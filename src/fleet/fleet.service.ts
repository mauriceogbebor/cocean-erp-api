import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  CreateDriverInput,
  CreateVehicleInput,
  VehicleDocumentInput,
  updateDriverSchema,
} from "@qorrix-erp/contracts";
import { asc, desc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import type { Db, Tx } from "../db/client.js";
import {
  drivers,
  vehicleDocuments,
  vehiclePositions,
  vehicles,
  workOrders,
} from "../db/schema.js";
import {
  ApprovalHandlers,
  type DecidedRequest,
} from "../approvals/approval-handlers.js";
import { ApprovalsService } from "../approvals/approvals.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { addDays, businessDate } from "../common/dates.js";
import { num } from "../common/num.js";
import { DB } from "../common/tokens.js";
import {
  driverIssues,
  EXPIRING_DAYS,
  latestDocs,
  vehicleIssues,
} from "./eligibility.js";
import { org } from "../common/org.js";

type Vehicle = typeof vehicles.$inferSelect;
type Driver = typeof drivers.$inferSelect;

@Injectable()
export class FleetService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(ApprovalHandlers) handlers: ApprovalHandlers,
  ) {
    handlers.register("truck_onboarding", (tx, req, actor) =>
      this.applyOnboarding(tx, req, actor),
    );
  }

  // ── Vehicles ──────────────────────────────────────────────────────────────

  async listVehicles() {
    const vs = await this.db
      .select()
      .from(vehicles)
      .orderBy(asc(vehicles.plate));
    if (!vs.length) return [];
    const docs = await this.db
      .select()
      .from(vehicleDocuments)
      .where(
        inArray(
          vehicleDocuments.vehicleId,
          vs.map((v) => v.id),
        ),
      );
    const today = businessDate();
    const soon = addDays(today, EXPIRING_DAYS);
    return vs.map((v) => {
      const latest = [
        ...latestDocs(docs.filter((d) => d.vehicleId === v.id)).values(),
      ];
      return {
        ...view(v),
        issues: vehicleIssues(v, latest, today),
        expiringSoon: latest
          .filter((d) => d.expiresOn >= today && d.expiresOn <= soon)
          .map((d) => d.kind),
      };
    });
  }

  async getVehicle(id: string, exec: Db | Tx = this.db) {
    const [v] = await exec.select().from(vehicles).where(eq(vehicles.id, id));
    if (!v) throw new NotFoundException("Vehicle not found");
    const docs = await exec
      .select()
      .from(vehicleDocuments)
      .where(eq(vehicleDocuments.vehicleId, id))
      .orderBy(desc(vehicleDocuments.createdAt));
    const latest = [...latestDocs(docs).values()];
    const [position] = await exec
      .select()
      .from(vehiclePositions)
      .where(eq(vehiclePositions.vehicleId, id))
      .orderBy(desc(vehiclePositions.recordedAt))
      .limit(1);
    return {
      ...view(v),
      issues: vehicleIssues(v, latest, businessDate()),
      documents: latest,
      history: docs,
      position: position
        ? {
            lat: num(position.lat)!,
            lng: num(position.lng)!,
            speedKph: num(position.speedKph),
            recordedAt: position.recordedAt,
          }
        : null,
    };
  }

  async createVehicle(input: CreateVehicleInput, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: vehicles.id })
        .from(vehicles)
        .where(eq(vehicles.plate, input.plate));
      if (dup)
        throw new ConflictException(`${input.plate} is already registered`);
      if (input.trackerId) {
        const [t] = await tx
          .select({ plate: vehicles.plate })
          .from(vehicles)
          .where(eq(vehicles.trackerId, input.trackerId));
        if (t)
          throw new ConflictException(
            `Tracker ${input.trackerId} is already fitted to ${t.plate}`,
          );
      }
      const [v] = await tx
        .insert(vehicles)
        .values({
          plate: input.plate,
          kind: input.kind,
          capacity: String(input.capacity),
          compartments: input.compartments ?? null,
          ownership: input.ownership,
          transporterName:
            input.ownership === "transporter" ? input.transporterName! : null,
          trackerId: input.trackerId ?? null,
          createdBy: user.id,
        })
        .returning();
      await this.audit.record(tx, actor, {
        action: "vehicle.registered",
        entityType: "vehicle",
        entityId: v.id,
        after: v,
      });
      return this.getVehicle(v.id, tx);
    });
  }

  /** Records a paper, or its renewal. The latest of each kind counts. */
  async addDocument(
    id: string,
    input: VehicleDocumentInput,
    user: AuthUser,
    actor: Actor,
  ) {
    if (!org().vehicleDocuments.some((d) => d.key === input.kind))
      throw new BadRequestException({
        message: "Validation failed",
        issues: [
          {
            path: "kind",
            message: "Not one of the organization's vehicle documents",
          },
        ],
      });
    return this.db.transaction(async (tx) => {
      const v = await this.lockVehicle(tx, id);
      if (v.status === "retired")
        throw new ConflictException(`${v.plate} is retired`);
      const [d] = await tx
        .insert(vehicleDocuments)
        .values({ ...input, vehicleId: id, recordedBy: user.id })
        .returning();
      await this.audit.record(tx, actor, {
        action: "vehicle.document_recorded",
        entityType: "vehicle",
        entityId: id,
        after: d,
      });
      return this.getVehicle(id, tx);
    });
  }

  /** Asks the Head of Operations to put a vehicle into service. Its papers must be complete and in date. */
  async submit(id: string, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const v = await this.lockVehicle(tx, id);
      if (v.status !== "onboarding")
        throw new ConflictException(
          `${v.plate} is ${v.status.replace("_", " ")}`,
        );
      const docs = await tx
        .select()
        .from(vehicleDocuments)
        .where(eq(vehicleDocuments.vehicleId, id));
      const latest = [...latestDocs(docs).values()];
      const issues = vehicleIssues(v, latest, businessDate(), {
        forOnboarding: true,
      });
      if (issues.length)
        throw new UnprocessableEntityException(
          `${v.plate} isn't ready: ${issues.join("; ")}`,
        );
      const papers = latest
        .map(
          (d) =>
            `${org().vehicleDocuments.find((t) => t.key === d.kind)?.label ?? d.kind} ${d.number} to ${d.expiresOn}`,
        )
        .join("; ");
      const approval = await this.approvals.createIn(
        tx,
        {
          kind: "truck_onboarding",
          ref: v.plate,
          title: `${v.plate} into service: ${v.kind.replace("_", " ")}, ${Number(v.capacity).toLocaleString(org().locale)}${v.ownership === "transporter" ? `, ${v.transporterName}` : ", own fleet"}`,
          amount: 0,
          reason: `Papers checked: ${papers}.${v.trackerId ? ` Tracker ${v.trackerId} fitted.` : " No tracker fitted yet."}`,
        },
        user.id,
        actor,
        { vehicleId: id },
      );
      await this.setVehicle(
        tx,
        id,
        { status: "pending_approval" },
        actor,
        "vehicle.submitted",
      );
      return { ...(await this.getVehicle(id, tx)), approval };
    });
  }

  async hold(id: string, reason: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const v = await this.lockVehicle(tx, id);
      if (v.holdReason)
        throw new ConflictException(`${v.plate} is already on hold`);
      await this.setVehicle(
        tx,
        id,
        { holdReason: reason },
        actor,
        "vehicle.held",
      );
      return this.getVehicle(id, tx);
    });
  }

  async clearHold(id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const v = await this.lockVehicle(tx, id);
      if (!v.holdReason)
        throw new ConflictException(`${v.plate} isn't on hold`);
      if (v.holdWorkOrderId) {
        const [w] = await tx
          .select({ number: workOrders.number })
          .from(workOrders)
          .where(eq(workOrders.id, v.holdWorkOrderId));
        throw new ConflictException(
          `${v.plate} is held by work order ${w?.number ?? ""}; complete or cancel it to clear the hold`,
        );
      }
      await this.setVehicle(
        tx,
        id,
        { holdReason: null },
        actor,
        "vehicle.hold_cleared",
      );
      return this.getVehicle(id, tx);
    });
  }

  // ── Drivers ───────────────────────────────────────────────────────────────

  async listDrivers() {
    const today = businessDate();
    return (
      await this.db.select().from(drivers).orderBy(asc(drivers.name))
    ).map((d) => ({ ...d, issues: driverIssues(d, today) }));
  }

  async createDriver(input: CreateDriverInput, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ name: drivers.name })
        .from(drivers)
        .where(eq(drivers.licenceNumber, input.licenceNumber));
      if (dup)
        throw new ConflictException(
          `Licence ${input.licenceNumber} is already registered to ${dup.name}`,
        );
      const [phoneDup] = await tx
        .select({ name: drivers.name })
        .from(drivers)
        .where(eq(drivers.phone, input.phone));
      if (phoneDup)
        throw new ConflictException(
          `That phone number is already registered to ${phoneDup.name}`,
        );
      const [d] = await tx
        .insert(drivers)
        .values({
          ...input,
          inductedOn: input.inductedOn ?? null,
          employer: input.employer ?? null,
        })
        .returning();
      await this.audit.record(tx, actor, {
        action: "driver.registered",
        entityType: "driver",
        entityId: d.id,
        after: d,
      });
      return { ...d, issues: driverIssues(d, businessDate()) };
    });
  }

  async updateDriver(
    id: string,
    patch: z.infer<typeof updateDriverSchema>,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const before = await this.lockDriver(tx, id);
      const [after] = await tx
        .update(drivers)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(drivers.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "driver.updated",
        entityType: "driver",
        entityId: id,
        before,
        after,
      });
      return { ...after, issues: driverIssues(after, businessDate()) };
    });
  }

  /** Inside the caller's transaction, so Security can suspend as it closes a case. */
  async suspendIn(tx: Tx, id: string, reason: string, actor: Actor) {
    const d = await this.lockDriver(tx, id);
    if (d.status === "suspended") return d;
    const [after] = await tx
      .update(drivers)
      .set({
        status: "suspended",
        suspendedReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(drivers.id, id))
      .returning();
    await this.audit.record(tx, actor, {
      action: "driver.suspended",
      entityType: "driver",
      entityId: id,
      before: { status: d.status },
      after: { status: "suspended", reason },
    });
    return after;
  }

  async suspend(id: string, reason: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const d = await this.lockDriver(tx, id);
      if (d.status === "suspended")
        throw new ConflictException(`${d.name} is already suspended`);
      const after = await this.suspendIn(tx, id, reason, actor);
      return { ...after, issues: driverIssues(after, businessDate()) };
    });
  }

  async reinstate(id: string, note: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const d = await this.lockDriver(tx, id);
      if (d.status !== "suspended")
        throw new ConflictException(`${d.name} isn't suspended`);
      const [after] = await tx
        .update(drivers)
        .set({ status: "active", suspendedReason: null, updatedAt: new Date() })
        .where(eq(drivers.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "driver.reinstated",
        entityType: "driver",
        entityId: id,
        before: { status: "suspended", reason: d.suspendedReason },
        after: { status: "active", note },
      });
      return { ...after, issues: driverIssues(after, businessDate()) };
    });
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  /**
   * The truck and driver for a loading, checked today: in service, papers in
   * date, no hold, driver licensed, inducted and not suspended, and the load
   * within the tank. Throws with every reason at once.
   */
  async dispatchable(
    tx: Tx,
    vehicleId: string,
    driverId: string,
    quantity: number,
  ) {
    const [v] = await tx
      .select()
      .from(vehicles)
      .where(eq(vehicles.id, vehicleId))
      .for("update");
    if (!v) throw new UnprocessableEntityException("Vehicle not found");
    const [d] = await tx
      .select()
      .from(drivers)
      .where(eq(drivers.id, driverId))
      .for("update");
    if (!d) throw new UnprocessableEntityException("Driver not found");
    const docs = await tx
      .select()
      .from(vehicleDocuments)
      .where(eq(vehicleDocuments.vehicleId, vehicleId));
    const today = businessDate();
    const problems = [
      ...vehicleIssues(v, [...latestDocs(docs).values()], today).map(
        (i) => `${v.plate}: ${i}`,
      ),
      ...driverIssues(d, today).map((i) => `${d.name}: ${i}`),
    ];
    if (quantity > Number(v.capacity) + 1e-9)
      problems.push(
        `${v.plate} holds ${Number(v.capacity).toLocaleString(org().locale)}; ${quantity.toLocaleString(org().locale)} won't fit`,
      );
    if (problems.length)
      throw new UnprocessableEntityException(
        `Can't dispatch: ${problems.join("; ")}`,
      );
    return { vehicle: v, driver: d };
  }

  private async applyOnboarding(tx: Tx, req: DecidedRequest, actor: Actor) {
    const id = (req.payload as { vehicleId?: string } | null)?.vehicleId;
    if (!id) return;
    const v = await this.lockVehicle(tx, id);
    if (v.status !== "pending_approval") return;
    await this.setVehicle(
      tx,
      id,
      { status: req.status === "approved" ? "active" : "onboarding" },
      actor,
      req.status === "approved"
        ? "vehicle.into_service"
        : "vehicle.onboarding_returned",
    );
  }

  private async setVehicle(
    tx: Tx,
    id: string,
    set: Partial<Vehicle>,
    actor: Actor,
    action: string,
  ) {
    const [before] = await tx
      .select()
      .from(vehicles)
      .where(eq(vehicles.id, id));
    await tx
      .update(vehicles)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(vehicles.id, id));
    await this.audit.record(tx, actor, {
      action,
      entityType: "vehicle",
      entityId: id,
      before: { status: before.status, holdReason: before.holdReason },
      after: set,
    });
  }

  private async lockVehicle(tx: Tx, id: string) {
    const [v] = await tx
      .select()
      .from(vehicles)
      .where(eq(vehicles.id, id))
      .for("update");
    if (!v) throw new NotFoundException("Vehicle not found");
    return v;
  }

  private async lockDriver(tx: Tx, id: string): Promise<Driver> {
    const [d] = await tx
      .select()
      .from(drivers)
      .where(eq(drivers.id, id))
      .for("update");
    if (!d) throw new NotFoundException("Driver not found");
    return d;
  }
}

const view = (v: Vehicle) => ({ ...v, capacity: num(v.capacity)! });
