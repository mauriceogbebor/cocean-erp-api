import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  STOCK_RULES,
  type CreateTankInput,
  type DipInput,
} from "@cocean/contracts";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { dips, products, sites, stockMovements, tanks } from "../db/schema.js";
import {
  ApprovalHandlers,
  type DecidedRequest,
} from "../approvals/approval-handlers.js";
import { ApprovalsService } from "../approvals/approvals.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { lagosDate } from "../common/dates.js";
import { num } from "../common/num.js";
import { DB } from "../common/tokens.js";
import { PricingService } from "../pricing/pricing.service.js";

type Tank = typeof tanks.$inferSelect;
type Kind = (typeof stockMovements.$inferSelect)["kind"];
/** Quantities are kept to the litre/kilogram's thousandth. */
const q3 = (n: number) => Math.round(n * 1000) / 1000;

export type Movement = {
  tankId: string;
  kind: Kind;
  /** Positive in, negative out. */
  quantity: number;
  ref: string;
  docId?: string;
  userId?: string | null;
};

@Injectable()
export class StockService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(ApprovalHandlers) handlers: ApprovalHandlers,
  ) {
    handlers.register("variance", (tx, req, actor) =>
      this.applyVariance(tx, req, actor),
    );
  }

  async onHand(exec: Db | Tx, tankId: string) {
    const [{ total }] = await exec
      .select({
        total: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)`,
      })
      .from(stockMovements)
      .where(eq(stockMovements.tankId, tankId));
    return Number(total);
  }

  /** Locks the tank so stock checks and the movement that follows can't interleave. */
  async lockTank(tx: Tx, id: string) {
    const [t] = await tx
      .select()
      .from(tanks)
      .where(eq(tanks.id, id))
      .for("update");
    if (!t) throw new NotFoundException("Tank not found");
    return t;
  }

  /**
   * Posts a movement inside the caller's transaction, refusing one that would
   * take the tank below empty or above its safe capacity. The tank must be
   * locked first (lockTank).
   */
  async post(tx: Tx, tank: Tank, m: Movement) {
    const before = await this.onHand(tx, tank.id);
    const after = q3(before + m.quantity);
    const unit = await this.unit(tx, tank.productCode);
    if (after < 0)
      throw new UnprocessableEntityException(
        `${tank.code} holds ${before.toLocaleString("en-NG")} ${unit}; ${Math.abs(m.quantity).toLocaleString("en-NG")} can't come out of it`,
      );
    if (
      m.quantity > 0 &&
      m.kind === "receipt" &&
      after > Number(tank.safeCapacity)
    )
      throw new UnprocessableEntityException(
        `${tank.code} would hold ${after.toLocaleString("en-NG")} ${unit}, above its safe capacity of ${Number(tank.safeCapacity).toLocaleString("en-NG")}`,
      );
    await tx.insert(stockMovements).values({
      tankId: tank.id,
      kind: m.kind,
      quantity: String(q3(m.quantity)),
      ref: m.ref,
      docId: m.docId ?? null,
      createdBy: m.userId ?? null,
    });
    return after;
  }

  async listTanks(q: { siteId?: string }) {
    const rows = await this.db
      .select({
        tank: tanks,
        siteName: sites.name,
        unit: products.unit,
        onHand: sql<string>`(select coalesce(sum(quantity), 0) from stock_movements m where m.tank_id = "tanks"."id")`,
        lastDip: sql<
          string | null
        >`(select max(dipped_on)::text from dips d where d.tank_id = "tanks"."id")`,
      })
      .from(tanks)
      .innerJoin(sites, eq(sites.id, tanks.siteId))
      .innerJoin(products, eq(products.code, tanks.productCode))
      .where(q.siteId ? eq(tanks.siteId, q.siteId) : undefined)
      .orderBy(asc(tanks.code));
    return rows.map((r) => {
      const onHand = Number(r.onHand);
      return {
        ...r.tank,
        capacity: num(r.tank.capacity)!,
        safeCapacity: num(r.tank.safeCapacity)!,
        siteName: r.siteName,
        unit: r.unit,
        onHand,
        /** Room left before safe capacity. */
        ullage: q3(Number(r.tank.safeCapacity) - onHand),
        lastDip: r.lastDip,
      };
    });
  }

  async getTank(id: string) {
    const [t] = (await this.listTanks({})).filter((x) => x.id === id);
    if (!t) throw new NotFoundException("Tank not found");
    const movements = await this.db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.tankId, id))
      .orderBy(desc(stockMovements.id))
      .limit(100);
    const dipRows = await this.db
      .select()
      .from(dips)
      .where(eq(dips.tankId, id))
      .orderBy(desc(dips.createdAt))
      .limit(30);
    return {
      ...t,
      movements: movements.map((m) => ({ ...m, quantity: num(m.quantity)! })),
      dips: dipRows.map(dipView),
    };
  }

  async createTank(input: CreateTankInput, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [site] = await tx
        .select()
        .from(sites)
        .where(eq(sites.id, input.siteId));
      if (!site?.active)
        throw new UnprocessableEntityException("Site not found or inactive");
      const [p] = await tx
        .select()
        .from(products)
        .where(eq(products.code, input.productCode));
      if (!p?.active)
        throw new UnprocessableEntityException(
          `Unknown or inactive product ${input.productCode}`,
        );
      const [dup] = await tx
        .select({ id: tanks.id })
        .from(tanks)
        .where(eq(tanks.code, input.code));
      if (dup) throw new ConflictException(`Tank ${input.code} already exists`);
      const [t] = await tx
        .insert(tanks)
        .values({
          siteId: site.id,
          code: input.code,
          productCode: p.code,
          capacity: String(input.capacity),
          safeCapacity: String(input.safeCapacity),
        })
        .returning();
      if (input.openingStock > 0)
        await this.post(tx, t, {
          tankId: t.id,
          kind: "opening",
          quantity: input.openingStock,
          ref: "OPENING",
          userId: user.id,
        });
      await this.audit.record(tx, actor, {
        action: "tank.created",
        entityType: "tank",
        entityId: t.id,
        after: { ...t, openingStock: input.openingStock },
      });
      return t;
    });
  }

  /**
   * Records a dip. Within tolerance, the difference is booked at once as a
   * gain or loss. Beyond it, nothing changes until Operations approves the
   * variance; a refused variance means dip again.
   */
  async recordDip(
    tankId: string,
    input: DipInput,
    user: AuthUser,
    actor: Actor,
  ) {
    if (input.dippedOn > lagosDate())
      throw new UnprocessableEntityException(
        "A dip can't be dated in the future",
      );
    return this.db.transaction(async (tx) => {
      const tank = await this.lockTank(tx, tankId);
      if (!tank.active)
        throw new UnprocessableEntityException(`${tank.code} is not in use`);
      const [open] = await tx
        .select({ id: dips.id })
        .from(dips)
        .where(
          and(eq(dips.tankId, tankId), eq(dips.status, "variance_pending")),
        );
      if (open)
        throw new ConflictException(
          `${tank.code} has a variance waiting for a decision; that comes first`,
        );
      const book = await this.onHand(tx, tankId);
      const variance = q3(input.quantity - book);
      const tolerance = Math.max(
        STOCK_RULES.dipTolerancePct * book,
        STOCK_RULES.dipToleranceMin,
      );
      const within = Math.abs(variance) <= tolerance;
      const [d] = await tx
        .insert(dips)
        .values({
          tankId,
          dippedOn: input.dippedOn,
          quantity: String(input.quantity),
          temperature:
            input.temperature === undefined ? null : String(input.temperature),
          book: String(book),
          variance: String(variance),
          status: within ? "within_tolerance" : "variance_pending",
          notes: input.notes ?? null,
          recordedBy: user.id,
        })
        .returning();
      const unit = await this.unit(tx, tank.productCode);
      let approval = null;
      if (within && variance !== 0)
        await this.post(tx, tank, {
          tankId,
          kind: "dip_adjustment",
          quantity: variance,
          ref: `DIP ${input.dippedOn}`,
          docId: d.id,
          userId: user.id,
        });
      if (!within) {
        const price = (
          await this.pricing.inForce(tx).catch(() => null)
        )?.lines.find((l) => l.productCode === tank.productCode)?.price;
        const value = price ? Math.round(Math.abs(variance) * price) : 0;
        approval = await this.approvals.createIn(
          tx,
          {
            kind: "variance",
            ref: `${tank.code} ${input.dippedOn}`,
            title: `${tank.code}: dip ${variance > 0 ? "over" : "under"} book by ${Math.abs(variance).toLocaleString("en-NG")} ${unit}`,
            amount: value,
            reason: `Dipped ${input.quantity.toLocaleString("en-NG")} ${unit} against book ${book.toLocaleString("en-NG")} ${unit}${input.temperature !== undefined ? ` at ${input.temperature} °C` : ""}; tolerance ±${Math.round(tolerance).toLocaleString("en-NG")} ${unit}.${input.notes ? ` ${input.notes}` : ""}${value ? ` About ₦${value.toLocaleString("en-NG")} at list price.` : ""}`,
          },
          user.id,
          actor,
          { dipId: d.id },
        );
      }
      await this.audit.record(tx, actor, {
        action: "tank.dipped",
        entityType: "tank",
        entityId: tankId,
        after: { dip: d.id, quantity: input.quantity, book, variance, within },
      });
      return { ...dipView(d), approval };
    });
  }

  private async applyVariance(tx: Tx, req: DecidedRequest, actor: Actor) {
    const dipId = (req.payload as { dipId?: string } | null)?.dipId;
    if (!dipId) return;
    const [d] = await tx
      .select()
      .from(dips)
      .where(eq(dips.id, dipId))
      .for("update");
    if (!d || d.status !== "variance_pending") return;
    const approved = req.status === "approved";
    if (approved) {
      const tank = await this.lockTank(tx, d.tankId);
      // The variance as measured, not recomputed: stock may have moved since.
      await this.post(tx, tank, {
        tankId: d.tankId,
        kind: "variance_adjustment",
        quantity: Number(d.variance),
        ref: req.ref,
        docId: req.id,
        userId: actor.userId,
      });
    }
    await tx
      .update(dips)
      .set({ status: approved ? "variance_approved" : "variance_rejected" })
      .where(eq(dips.id, dipId));
    await this.audit.record(tx, actor, {
      action: approved ? "tank.variance_booked" : "tank.variance_refused",
      entityType: "tank",
      entityId: d.tankId,
      after: { dip: d.id, variance: Number(d.variance), approval: req.id },
    });
  }

  private async unit(exec: Db | Tx, code: string) {
    const [p] = await exec
      .select({ unit: products.unit })
      .from(products)
      .where(eq(products.code, code));
    return p?.unit ?? "";
  }
}

const dipView = (d: typeof dips.$inferSelect) => ({
  ...d,
  quantity: num(d.quantity)!,
  temperature: num(d.temperature),
  book: num(d.book)!,
  variance: num(d.variance)!,
});
