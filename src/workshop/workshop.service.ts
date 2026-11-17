import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  lineTotals,
  OPEN_WORK_ORDER,
  type CancelWorkOrderInput,
  type CompleteWorkOrderInput,
  type CreateWorkOrderInput,
  type SubmitWorkOrderInput,
  type WorkLine,
  type WorkOrderStatus,
  workLineSchema,
} from "@qorrix-erp/contracts";
import { and, desc, eq, gte, inArray, lte, ne, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  ApprovalHandlers,
  type DecidedRequest,
} from "../approvals/approval-handlers.js";
import { ApprovalsService } from "../approvals/approvals.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { addDays, businessDate } from "../common/dates.js";
import { nextNumber } from "../common/numbering.js";
import { num } from "../common/num.js";
import { money, org } from "../common/org.js";
import { DB } from "../common/tokens.js";
import type { Db, Tx } from "../db/client.js";
import { approvalRequests, users, vehicles, workOrders } from "../db/schema.js";

type Row = typeof workOrders.$inferSelect;
type Stage = "estimate" | "overrun";
type Payload = { workOrderId?: string; stage?: Stage };

const KIND_LABEL: Record<string, string> = {
  repair: "Repair",
  service: "Service",
  tyres: "Tyres",
  accident: "Accident damage",
  inspection: "Inspection",
};

const view = (w: Row) => ({
  ...w,
  estimate: num(w.estimate),
  partsCost: num(w.partsCost),
  labourCost: num(w.labourCost),
  outsideCost: num(w.outsideCost),
  actualCost: num(w.actualCost),
});

/** Whole days a truck was off the road, counting a part day as one. */
const daysBetween = (from: Date, to: Date) =>
  Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));

const lines = z.array(workLineSchema);

@Injectable()
export class WorkshopService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(ApprovalHandlers) handlers: ApprovalHandlers,
  ) {
    handlers.register("work_order", (tx, req, actor) =>
      this.decided(tx, req, actor),
    );
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  async list(q: { state?: string; vehicleId?: string }) {
    const where: SQL[] = [];
    if (q.state === "open")
      where.push(inArray(workOrders.status, OPEN_WORK_ORDER));
    else if (q.state === "closed")
      where.push(inArray(workOrders.status, ["completed", "cancelled"]));
    if (q.vehicleId) where.push(eq(workOrders.vehicleId, q.vehicleId));
    const rows = await this.db
      .select({ w: workOrders, plate: vehicles.plate })
      .from(workOrders)
      .innerJoin(vehicles, eq(vehicles.id, workOrders.vehicleId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(workOrders.createdAt))
      .limit(300);
    return rows.map((r) => ({ ...view(r.w), plate: r.plate }));
  }

  async get(id: string, exec: Db | Tx = this.db) {
    const [r] = await exec
      .select({
        w: workOrders,
        plate: vehicles.plate,
        vehicleKind: vehicles.kind,
        openedByName: users.name,
      })
      .from(workOrders)
      .innerJoin(vehicles, eq(vehicles.id, workOrders.vehicleId))
      .leftJoin(users, eq(users.id, workOrders.openedBy))
      .where(eq(workOrders.id, id));
    if (!r) throw new NotFoundException("Work order not found");
    const approvals = await exec
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.kind, "work_order"),
          eq(approvalRequests.ref, r.w.number),
        ),
      )
      .orderBy(desc(approvalRequests.createdAt));
    return {
      ...view(r.w),
      plate: r.plate,
      vehicleKind: r.vehicleKind,
      openedByName: r.openedByName,
      /** What a finished job may cost before it needs approving again. */
      allowed:
        r.w.estimate === null
          ? null
          : Math.round(
              num(r.w.estimate)! * (1 + org().fleet.workOrderOverrunPct) * 100,
            ) / 100,
      approvals: approvals.map((a) => ({ ...a, amount: num(a.amount)! })),
    };
  }

  // ── Opening and pricing ───────────────────────────────────────────────────

  /** Opens a work order. An off-road job holds the truck until it closes. */
  async create(input: CreateWorkOrderInput, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const v = await this.lockVehicle(tx, input.vehicleId);
      if (v.status === "retired")
        throw new ConflictException(`${v.plate} is retired`);
      const number = await nextNumber(tx, "WO");
      const offRoad = input.offRoad ?? true;
      // A truck already on hold stays on that hold; this order doesn't take it over.
      const holds = offRoad && !v.holdReason;
      const [w] = await tx
        .insert(workOrders)
        .values({
          number,
          vehicleId: v.id,
          kind: input.kind,
          title: input.title,
          description: input.description ?? null,
          offRoad,
          heldFrom: holds ? new Date() : null,
          odometerKm: input.odometerKm ?? null,
          openedBy: user.id,
        })
        .returning();
      await this.audit.record(tx, actor, {
        action: "work_order.opened",
        entityType: "work_order",
        entityId: w.id,
        after: w,
      });
      if (holds) {
        const holdReason = `Work order ${number}: ${input.title}`;
        await tx
          .update(vehicles)
          .set({ holdReason, holdWorkOrderId: w.id, updatedAt: new Date() })
          .where(eq(vehicles.id, v.id));
        await this.audit.record(tx, actor, {
          action: "vehicle.held",
          entityType: "vehicle",
          entityId: v.id,
          before: { holdReason: null },
          after: { holdReason, workOrder: number },
        });
      }
      return this.get(w.id, tx);
    });
  }

  /** Prices the job and asks for approval; routed by the estimate. */
  async submit(
    id: string,
    input: SubmitWorkOrderInput,
    user: AuthUser,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const w = await this.lock(tx, id);
      if (w.status !== "draft" && w.status !== "rejected")
        throw new ConflictException(
          `${w.number} is ${w.status}; only a new or turned-down work order can be priced`,
        );
      const ls = lines.parse(input.lines);
      const t = lineTotals(ls);
      const [v] = await tx
        .select({ plate: vehicles.plate })
        .from(vehicles)
        .where(eq(vehicles.id, w.vehicleId));
      const approval = await this.approvals.createIn(
        tx,
        {
          kind: "work_order",
          ref: w.number,
          title: `${KIND_LABEL[w.kind] ?? w.kind} for ${v.plate}: ${w.title}`,
          amount: t.total,
          reason: [
            `Parts ${money(t.part)}, labour ${money(t.labour)}, outside work ${money(t.outside)}.`,
            input.supplierName ? `Done by ${input.supplierName}.` : "In-house.",
            w.offRoad ? "Truck is off the road until it's done." : "",
            input.note ?? "",
          ]
            .filter(Boolean)
            .join(" "),
        },
        user.id,
        actor,
        { workOrderId: w.id, stage: "estimate" } satisfies Payload,
      );
      await this.set(
        tx,
        w,
        {
          status: "submitted",
          estimateLines: ls,
          estimate: String(t.total),
          supplierName: input.supplierName ?? w.supplierName,
          approvalId: approval.id,
        },
        actor,
        "work_order.submitted",
      );
      return this.get(id, tx);
    });
  }

  /**
   * Records what the job cost. Within the estimate's allowance it closes
   * and the truck goes back on the road; over it, the extra needs approving.
   */
  async complete(
    id: string,
    input: CompleteWorkOrderInput,
    user: AuthUser,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const w = await this.lock(tx, id);
      if (w.status !== "approved")
        throw new ConflictException(
          `${w.number} is ${w.status}; only approved work can be completed`,
        );
      if (input.completedOn > businessDate())
        throw new UnprocessableEntityException({
          message: "The work can't be finished in the future",
          issues: [{ path: "completedOn", message: "Can't be in the future" }],
        });
      const ls = lines.parse(input.lines);
      const t = lineTotals(ls);
      const allowed = num(w.estimate)! * (1 + org().fleet.workOrderOverrunPct);
      const over = t.total > allowed + 0.005;
      if (over && !input.note?.trim())
        throw new UnprocessableEntityException({
          message: `${money(t.total)} is over the approved ${money(num(w.estimate)!)}; say why`,
          issues: [
            { path: "note", message: "Say why it cost more than estimated" },
          ],
        });
      const set: Partial<Row> = {
        actualLines: ls,
        partsCost: String(t.part),
        labourCost: String(t.labour),
        outsideCost: String(t.outside),
        actualCost: String(t.total),
        completedOn: input.completedOn,
        completionNote: input.note ?? null,
        odometerKm: input.odometerKm ?? w.odometerKm,
      };
      if (!over) {
        await this.set(
          tx,
          w,
          { ...set, status: "completed" },
          actor,
          "work_order.completed",
        );
        await this.release(tx, w, actor);
        return this.get(id, tx);
      }
      const [v] = await tx
        .select({ plate: vehicles.plate })
        .from(vehicles)
        .where(eq(vehicles.id, w.vehicleId));
      const approval = await this.approvals.createIn(
        tx,
        {
          kind: "work_order",
          ref: w.number,
          title: `${w.number} for ${v.plate} cost more than approved`,
          amount: t.total,
          reason: `Approved ${money(num(w.estimate)!)}; the job came to ${money(t.total)}. ${input.note}`,
        },
        user.id,
        actor,
        { workOrderId: w.id, stage: "overrun" } satisfies Payload,
      );
      await this.set(
        tx,
        w,
        { ...set, status: "overrun", approvalId: approval.id },
        actor,
        "work_order.overrun",
      );
      return this.get(id, tx);
    });
  }

  async cancel(id: string, input: CancelWorkOrderInput, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const w = await this.lock(tx, id);
      if (!["draft", "rejected", "approved"].includes(w.status))
        throw new ConflictException(
          w.status === "submitted" || w.status === "overrun"
            ? `${w.number} is waiting for approval; withdraw the request first`
            : `${w.number} is already ${w.status}`,
        );
      await this.set(
        tx,
        w,
        { status: "cancelled", cancelReason: input.reason },
        actor,
        "work_order.cancelled",
      );
      await this.release(tx, w, actor);
      return this.get(id, tx);
    });
  }

  // ── What the fleet costs, and what's due ──────────────────────────────────

  /** Completed work by truck, for a period (this year so far by default). */
  async costs(q: { from?: string; to?: string }) {
    const to = q.to ?? businessDate();
    const from = q.from ?? `${to.slice(0, 4)}-01-01`;
    const [vs, done] = await Promise.all([
      this.db.select().from(vehicles).where(ne(vehicles.status, "retired")),
      this.db
        .select()
        .from(workOrders)
        .where(
          and(
            eq(workOrders.status, "completed"),
            gte(workOrders.completedOn, from),
            lte(workOrders.completedOn, to),
          ),
        ),
    ]);
    const byVehicle = new Map(
      vs.map((v) => [
        v.id,
        {
          vehicleId: v.id,
          plate: v.plate,
          kind: v.kind,
          ownership: v.ownership,
          orders: 0,
          parts: 0,
          labour: 0,
          outside: 0,
          total: 0,
          daysOffRoad: 0,
        },
      ]),
    );
    for (const w of done) {
      let row = byVehicle.get(w.vehicleId);
      if (!row) {
        // A truck retired since; its costs still count.
        const [v] = await this.db
          .select()
          .from(vehicles)
          .where(eq(vehicles.id, w.vehicleId));
        row = {
          vehicleId: v.id,
          plate: v.plate,
          kind: v.kind,
          ownership: v.ownership,
          orders: 0,
          parts: 0,
          labour: 0,
          outside: 0,
          total: 0,
          daysOffRoad: 0,
        };
        byVehicle.set(v.id, row);
      }
      row.orders += 1;
      row.parts += num(w.partsCost) ?? 0;
      row.labour += num(w.labourCost) ?? 0;
      row.outside += num(w.outsideCost) ?? 0;
      row.total += num(w.actualCost) ?? 0;
      if (w.heldFrom && w.releasedAt)
        row.daysOffRoad += daysBetween(w.heldFrom, w.releasedAt);
    }
    const rows = [...byVehicle.values()]
      .map((r) => ({
        ...r,
        parts: round(r.parts),
        labour: round(r.labour),
        outside: round(r.outside),
        total: round(r.total),
      }))
      .sort((a, b) => b.total - a.total || a.plate.localeCompare(b.plate));
    const sum = (k: "parts" | "labour" | "outside" | "total" | "orders") =>
      round(rows.reduce((a, r) => a + r[k], 0));
    return {
      from,
      to,
      rows,
      totals: {
        orders: sum("orders"),
        parts: sum("parts"),
        labour: sum("labour"),
        outside: sum("outside"),
        total: sum("total"),
        daysOffRoad: rows.reduce((a, r) => a + r.daysOffRoad, 0),
      },
    };
  }

  /** When each truck in service is next due a service, by date or distance. */
  async serviceDue() {
    const { serviceIntervalDays: days, serviceIntervalKm: km } = org().fleet;
    const today = businessDate();
    const vs = await this.db
      .select()
      .from(vehicles)
      .where(inArray(vehicles.status, ["active", "pending_approval"]));
    if (!vs.length) return [];
    const wos = await this.db
      .select({
        vehicleId: workOrders.vehicleId,
        kind: workOrders.kind,
        status: workOrders.status,
        completedOn: workOrders.completedOn,
        odometerKm: workOrders.odometerKm,
        createdAt: workOrders.createdAt,
      })
      .from(workOrders)
      .where(
        inArray(
          workOrders.vehicleId,
          vs.map((v) => v.id),
        ),
      );
    return vs
      .map((v) => {
        const mine = wos.filter((w) => w.vehicleId === v.id);
        const last = mine
          .filter((w) => w.kind === "service" && w.status === "completed")
          .sort((a, b) => (b.completedOn! > a.completedOn! ? 1 : -1))[0];
        const openService = mine.some(
          (w) => w.kind === "service" && OPEN_WORK_ORDER.includes(w.status),
        );
        const readings = mine
          .map((w) => w.odometerKm)
          .filter((n): n is number => n !== null);
        const latestKm = readings.length ? Math.max(...readings) : null;
        const dueOn = last ? addDays(last.completedOn!, days) : null;
        const kmSince =
          last?.odometerKm != null && latestKm !== null
            ? latestKm - last.odometerKm
            : null;
        const reasons: string[] = [];
        if (!last) reasons.push("No service on record");
        else if (dueOn! <= today) reasons.push(`Due since ${dueOn}`);
        if (kmSince !== null && kmSince >= km)
          reasons.push(
            `${kmSince.toLocaleString(org().locale)} km since the last service`,
          );
        return {
          vehicleId: v.id,
          plate: v.plate,
          kind: v.kind,
          lastServiceOn: last?.completedOn ?? null,
          lastServiceKm: last?.odometerKm ?? null,
          latestKm,
          kmSince,
          dueOn,
          due: reasons.length > 0,
          booked: openService,
          reasons,
        };
      })
      .sort(
        (a, b) =>
          Number(b.due) - Number(a.due) ||
          (a.dueOn ?? "").localeCompare(b.dueOn ?? "") ||
          a.plate.localeCompare(b.plate),
      );
  }

  // ── Approval decisions ────────────────────────────────────────────────────

  private async decided(tx: Tx, req: DecidedRequest, actor: Actor) {
    const { workOrderId, stage } = (req.payload ?? {}) as Payload;
    if (!workOrderId) return;
    const w = await this.lock(tx, workOrderId);
    const ok = req.status === "approved";
    if (stage === "overrun") {
      if (w.status !== "overrun") return;
      if (ok) {
        await this.set(
          tx,
          w,
          { status: "completed" },
          actor,
          "work_order.completed",
        );
        await this.release(tx, w, actor);
      } else {
        // Back to the workshop: record the cost again, or with a better explanation.
        await this.set(
          tx,
          w,
          {
            status: "approved",
            actualLines: null,
            partsCost: null,
            labourCost: null,
            outsideCost: null,
            actualCost: null,
            completedOn: null,
            completionNote: null,
          },
          actor,
          `work_order.overrun_${req.status}`,
        );
      }
      return;
    }
    if (w.status !== "submitted") return;
    const status: WorkOrderStatus = ok
      ? "approved"
      : req.status === "withdrawn"
        ? "draft"
        : "rejected";
    await this.set(tx, w, { status }, actor, `work_order.${req.status}`);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Puts the truck back on the road if this work order was holding it. */
  private async release(tx: Tx, w: Row, actor: Actor) {
    const v = await this.lockVehicle(tx, w.vehicleId);
    if (v.holdWorkOrderId !== w.id) return;
    await tx
      .update(vehicles)
      .set({ holdReason: null, holdWorkOrderId: null, updatedAt: new Date() })
      .where(eq(vehicles.id, v.id));
    await tx
      .update(workOrders)
      .set({ releasedAt: new Date() })
      .where(eq(workOrders.id, w.id));
    await this.audit.record(tx, actor, {
      action: "vehicle.hold_cleared",
      entityType: "vehicle",
      entityId: v.id,
      before: { holdReason: v.holdReason },
      after: { holdReason: null, workOrder: w.number },
    });
  }

  private async set(
    tx: Tx,
    before: Row,
    set: Partial<Row>,
    actor: Actor,
    action: string,
  ) {
    await tx
      .update(workOrders)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(workOrders.id, before.id));
    await this.audit.record(tx, actor, {
      action,
      entityType: "work_order",
      entityId: before.id,
      before: { status: before.status },
      after: set,
    });
  }

  private async lock(tx: Tx, id: string) {
    const [w] = await tx
      .select()
      .from(workOrders)
      .where(eq(workOrders.id, id))
      .for("update");
    if (!w) throw new NotFoundException("Work order not found");
    return w;
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
}

const round = (n: number) => Math.round(n * 100) / 100;
export type { WorkLine };
