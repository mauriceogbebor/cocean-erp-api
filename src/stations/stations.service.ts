import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  STATION_RULES,
  STOCK_RULES,
  type BankTakingsInput,
  type CloseShiftInput,
  type CreatePumpInput,
  type StationReceiptInput,
} from "@cocean/contracts";
import { and, asc, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import {
  fills,
  pumps,
  shiftPumps,
  shifts,
  sites,
  tanks,
  users,
  userSites,
} from "../db/schema.js";
import {
  ApprovalHandlers,
  type DecidedRequest,
} from "../approvals/approval-handlers.js";
import { ApprovalsService } from "../approvals/approvals.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { lagosDate } from "../common/dates.js";
import { num } from "../common/num.js";
import { nextNumber } from "../common/numbering.js";
import { DB } from "../common/tokens.js";
import { PricingService } from "../pricing/pricing.service.js";
import { StockService } from "../stock/stock.service.js";
import { assertSiteAccess } from "./site-access.js";

type Shift = typeof shifts.$inferSelect;
const kobo = (n: number | string) => Math.round(Number(n) * 100);
const n2 = (n: number) => Math.round(n * 100) / 100;
const naira = (n: number) =>
  `₦${n.toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
const RETAIL_KINDS = ["station", "lpg_plant"] as const;

@Injectable()
export class StationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(ApprovalHandlers) handlers: ApprovalHandlers,
  ) {
    handlers.register("shift_variance", (tx, req, actor) =>
      this.applyVariance(tx, req, actor),
    );
  }

  // ── Sites, people, pumps ──────────────────────────────────────────────────

  /** Stations and LPG plants, with their pumps and last shift. */
  async overview() {
    const rows = await this.db
      .select()
      .from(sites)
      .where(inArray(sites.kind, [...RETAIL_KINDS]))
      .orderBy(asc(sites.name));
    const ps = await this.db.select().from(pumps);
    const last = await this.db
      .select()
      .from(shifts)
      .orderBy(desc(shifts.shiftDate), desc(shifts.createdAt));
    return rows.map((s) => {
      const l = last.find((x) => x.siteId === s.id);
      return {
        ...s,
        pumps: ps.filter((p) => p.siteId === s.id && p.active).length,
        lastShift: l
          ? {
              id: l.id,
              number: l.number,
              shiftDate: l.shiftDate,
              period: l.period,
              status: l.status,
            }
          : null,
      };
    });
  }

  async setUserSites(userId: string, siteIds: string[], actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [u] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId));
      if (!u) throw new NotFoundException("User not found");
      const before = await tx
        .select()
        .from(userSites)
        .where(eq(userSites.userId, userId));
      await tx.delete(userSites).where(eq(userSites.userId, userId));
      if (siteIds.length)
        await tx
          .insert(userSites)
          .values([...new Set(siteIds)].map((siteId) => ({ userId, siteId })));
      await this.audit.record(tx, actor, {
        action: "user.sites_set",
        entityType: "user",
        entityId: userId,
        before: before.map((b) => b.siteId),
        after: siteIds,
      });
      return { userId, siteIds };
    });
  }

  async listPumps(siteId: string) {
    const rows = await this.db
      .select({ pump: pumps, tank: tanks.code, product: tanks.productCode })
      .from(pumps)
      .innerJoin(tanks, eq(tanks.id, pumps.tankId))
      .where(eq(pumps.siteId, siteId))
      .orderBy(asc(pumps.code));
    return Promise.all(
      rows.map(async (r) => ({
        ...r.pump,
        openingMeter: num(r.pump.openingMeter)!,
        tankCode: r.tank,
        productCode: r.product,
        /** Where the next shift starts. */
        currentMeter: await this.lastMeter(this.db, r.pump),
      })),
    );
  }

  async createPump(input: CreatePumpInput, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [s] = await tx
        .select()
        .from(sites)
        .where(eq(sites.id, input.siteId));
      if (!s || s.kind !== "station")
        throw new UnprocessableEntityException("Pumps belong to a station");
      const [t] = await tx
        .select()
        .from(tanks)
        .where(eq(tanks.id, input.tankId));
      if (!t || t.siteId !== s.id)
        throw new UnprocessableEntityException(`That tank isn't at ${s.name}`);
      const [dup] = await tx
        .select({ id: pumps.id })
        .from(pumps)
        .where(and(eq(pumps.siteId, s.id), eq(pumps.code, input.code)));
      if (dup)
        throw new ConflictException(
          `${s.name} already has a pump ${input.code}`,
        );
      const [p] = await tx
        .insert(pumps)
        .values({ ...input, openingMeter: String(input.openingMeter) })
        .returning();
      await this.audit.record(tx, actor, {
        action: "pump.created",
        entityType: "pump",
        entityId: p.id,
        after: p,
      });
      return p;
    });
  }

  /** Product delivered into a station's tank, against its waybill. */
  async receive(
    tankId: string,
    input: StationReceiptInput,
    user: AuthUser,
    actor: Actor,
  ) {
    if (input.receivedOn > lagosDate())
      throw new UnprocessableEntityException(
        "A delivery can't be received in the future",
      );
    return this.db.transaction(async (tx) => {
      const tank = await this.stock.lockTank(tx, tankId);
      const [s] = await tx
        .select()
        .from(sites)
        .where(eq(sites.id, tank.siteId));
      if (!(RETAIL_KINDS as readonly string[]).includes(s.kind))
        throw new UnprocessableEntityException(
          "Depot receipts come through purchase orders",
        );
      await assertSiteAccess(tx, user, s.id);
      const after = await this.stock.post(tx, tank, {
        tankId,
        kind: "receipt",
        quantity: input.quantity,
        ref: `WB ${input.waybill}`,
        userId: user.id,
      });
      await this.audit.record(tx, actor, {
        action: "station.received",
        entityType: "tank",
        entityId: tankId,
        after: { ...input, onHand: after },
      });
      return { tankId, onHand: after };
    });
  }

  // ── Shift close ───────────────────────────────────────────────────────────

  /**
   * Closes a shift. Sales are what the meters moved (and LPG fills since the
   * last close), priced from the list in force. The tanks should then hold
   * book stock and the takings should equal the sales. Within tolerance it
   * balances and small dip differences are booked; beyond, Operations (or
   * the Head of Operations, for larger amounts) decides.
   */
  async close(input: CloseShiftInput, user: AuthUser, actor: Actor) {
    if (input.shiftDate > lagosDate())
      throw new UnprocessableEntityException(
        "A shift can't be closed for a future date",
      );
    return this.db.transaction(async (tx) => {
      const [site] = await tx
        .select()
        .from(sites)
        .where(eq(sites.id, input.siteId));
      if (!site || !(RETAIL_KINDS as readonly string[]).includes(site.kind))
        throw new UnprocessableEntityException(
          "Shifts are closed at stations and LPG plants",
        );
      await assertSiteAccess(tx, user, site.id);
      const [dup] = await tx
        .select({ number: shifts.number })
        .from(shifts)
        .where(
          and(
            eq(shifts.siteId, site.id),
            eq(shifts.shiftDate, input.shiftDate),
            eq(shifts.period, input.period),
          ),
        );
      if (dup)
        throw new ConflictException(
          `This shift is already closed as ${dup.number}`,
        );

      const pl = await this.pricing.inForce(tx, lagosDate());
      const price = (code: string) => {
        const p = pl?.lines.find((l) => l.productCode === code)?.price;
        if (p === undefined)
          throw new UnprocessableEntityException(
            `No approved price for ${code} is in force`,
          );
        return p;
      };

      // Every active pump, once.
      const sitePumps = await tx
        .select()
        .from(pumps)
        .where(and(eq(pumps.siteId, site.id), eq(pumps.active, true)));
      const given = input.meters.map((m) => m.pumpId);
      if (
        given.length !== new Set(given).size ||
        given.some((id) => !sitePumps.some((p) => p.id === id))
      )
        throw new UnprocessableEntityException(
          "Each meter must be one of this site's pumps, once",
        );
      const missing = sitePumps.filter((p) => !given.includes(p.id));
      if (missing.length)
        throw new UnprocessableEntityException(
          `Read every pump: ${missing.map((p) => p.code).join(", ")} missing`,
        );

      // Every tank, locked, dipped once.
      const siteTanks = await tx
        .select()
        .from(tanks)
        .where(and(eq(tanks.siteId, site.id), eq(tanks.active, true)));
      for (const t of siteTanks) await this.stock.lockTank(tx, t.id);
      const dipped = input.dips.map((d) => d.tankId);
      if (
        dipped.length !== new Set(dipped).size ||
        dipped.some((id) => !siteTanks.some((t) => t.id === id))
      )
        throw new UnprocessableEntityException(
          "Each dip must be one of this site's tanks, once",
        );
      const undipped = siteTanks.filter((t) => !dipped.includes(t.id));
      if (undipped.length)
        throw new UnprocessableEntityException(
          `Dip every tank: ${undipped.map((t) => t.code).join(", ")} missing`,
        );

      const number = await nextNumber(tx, "SH");
      const pumpRows = [];
      const soldByTank = new Map<string, number>();
      let expectedK = 0;
      for (const m of input.meters) {
        const p = sitePumps.find((x) => x.id === m.pumpId)!;
        const opening = await this.lastMeter(tx, p);
        if (m.closing < opening - 1e-9)
          throw new UnprocessableEntityException(
            `Pump ${p.code}'s meter went backwards: ${opening} at the last close, ${m.closing} now`,
          );
        const tank = siteTanks.find((t) => t.id === p.tankId)!;
        const qty = n2(m.closing - opening);
        const unit = price(tank.productCode);
        const amountK = Math.round(qty * kobo(unit));
        expectedK += amountK;
        soldByTank.set(tank.id, (soldByTank.get(tank.id) ?? 0) + qty);
        pumpRows.push({
          pumpId: p.id,
          opening: String(opening),
          closing: String(m.closing),
          quantity: String(qty),
          price: String(unit),
          amount: (amountK / 100).toFixed(2),
        });
      }
      for (const [tankId, qty] of soldByTank)
        if (qty > 0)
          await this.stock.post(
            tx,
            siteTanks.find((t) => t.id === tankId)!,
            {
              tankId,
              kind: "sale",
              quantity: -qty,
              ref: number,
              userId: user.id,
            },
          );

      // LPG fills since the last close are this shift's sales too (stock already out).
      const openFills = await tx
        .select()
        .from(fills)
        .where(and(eq(fills.siteId, site.id), isNull(fills.shiftId)));
      expectedK += openFills.reduce((a, f) => a + kobo(f.amount), 0);

      // Tanks against book, after the sales.
      const tankCheck = [];
      for (const t of siteTanks) {
        const book = await this.stock.onHand(tx, t.id);
        const dip = input.dips.find((d) => d.tankId === t.id)!.quantity;
        const variance = n2(dip - book);
        const within =
          Math.abs(variance) <=
          Math.max(
            STOCK_RULES.dipTolerancePct * book,
            STOCK_RULES.dipToleranceMin,
          );
        if (within && variance !== 0)
          await this.stock.post(tx, t, {
            tankId: t.id,
            kind: "dip_adjustment",
            quantity: variance,
            ref: number,
            userId: user.id,
          });
        tankCheck.push({
          tankId: t.id,
          code: t.code,
          productCode: t.productCode,
          book,
          dip,
          variance,
          within,
        });
      }

      const declaredK =
        kobo(input.takings.cash) +
        kobo(input.takings.pos) +
        kobo(input.takings.transfer);
      const cashVarianceK = declaredK - expectedK;
      const cashOk =
        Math.abs(cashVarianceK) <=
        Math.max(
          STATION_RULES.cashToleranceNaira * 100,
          STATION_RULES.cashTolerancePct * expectedK,
        );
      const balanced = cashOk && tankCheck.every((c) => c.within);

      const [shift] = await tx
        .insert(shifts)
        .values({
          number,
          siteId: site.id,
          shiftDate: input.shiftDate,
          period: input.period,
          status: balanced ? "balanced" : "variance_pending",
          expected: (expectedK / 100).toFixed(2),
          cash: String(input.takings.cash),
          pos: String(input.takings.pos),
          transfer: String(input.takings.transfer),
          cashVariance: (cashVarianceK / 100).toFixed(2),
          tankCheck,
          notes: input.notes ?? null,
          closedBy: user.id,
        })
        .returning();
      if (pumpRows.length)
        await tx
          .insert(shiftPumps)
          .values(pumpRows.map((r) => ({ ...r, shiftId: shift.id })));
      if (openFills.length)
        await tx
          .update(fills)
          .set({ shiftId: shift.id })
          .where(
            inArray(
              fills.id,
              openFills.map((f) => f.id),
            ),
          );

      let approval = null;
      if (!balanced) {
        const off = tankCheck.filter((c) => !c.within);
        const stockValueK = off.reduce(
          (a, c) =>
            a + Math.round(Math.abs(c.variance) * kobo(price(c.productCode))),
          0,
        );
        const parts = [
          ...(!cashOk
            ? [
                `takings ${cashVarianceK < 0 ? "short" : "over"} by ${naira(Math.abs(cashVarianceK) / 100)} against ${naira(expectedK / 100)} sold`,
              ]
            : []),
          ...off.map(
            (c) =>
              `${c.code} ${c.variance < 0 ? "short" : "over"} by ${Math.abs(c.variance).toLocaleString("en-NG")} against book ${c.book.toLocaleString("en-NG")}`,
          ),
        ];
        approval = await this.approvals.createIn(
          tx,
          {
            kind: "shift_variance",
            ref: number,
            title: `${site.name}, ${input.shiftDate} ${input.period}: ${parts[0]}`,
            amount: Math.round(
              (Math.abs(cashOk ? 0 : cashVarianceK) + stockValueK) / 100,
            ),
            reason: `${parts.join("; ")}.${input.notes ? ` Station's note: ${input.notes}` : ""}`,
          },
          user.id,
          actor,
          { shiftId: shift.id },
        );
      }
      await this.audit.record(tx, actor, {
        action: balanced ? "shift.balanced" : "shift.variance",
        entityType: "shift",
        entityId: shift.id,
        after: {
          number,
          expected: expectedK / 100,
          declared: declaredK / 100,
          tankCheck,
        },
      });
      return { ...(await this.getShift(shift.id, tx)), approval };
    });
  }

  /** Finance records the takings lodged at the bank. */
  async bank(
    id: string,
    input: BankTakingsInput,
    user: AuthUser,
    actor: Actor,
  ) {
    if (input.bankedOn > lagosDate())
      throw new UnprocessableEntityException(
        "A lodgement can't be in the future",
      );
    return this.db.transaction(async (tx) => {
      const [s] = await tx
        .select()
        .from(shifts)
        .where(eq(shifts.id, id))
        .for("update");
      if (!s) throw new NotFoundException("Shift not found");
      if (s.status !== "balanced" && s.status !== "variance_accepted")
        throw new ConflictException(
          s.status === "banked"
            ? `${s.number} is already banked`
            : `${s.number}'s variance must be decided before banking`,
        );
      await tx
        .update(shifts)
        .set({
          status: "banked",
          bank: input.bank,
          bankRef: input.bankRef,
          bankedAmount: String(input.amount),
          bankedOn: input.bankedOn,
          bankedBy: user.id,
        })
        .where(eq(shifts.id, id));
      await this.audit.record(tx, actor, {
        action: "shift.banked",
        entityType: "shift",
        entityId: id,
        before: { status: s.status },
        after: { ...input, cashDeclared: Number(s.cash) },
      });
      return this.getShift(id, tx);
    });
  }

  async listShifts(q: { siteId?: string; status?: Shift["status"] }) {
    const where: SQL[] = [];
    if (q.siteId) where.push(eq(shifts.siteId, q.siteId));
    if (q.status) where.push(eq(shifts.status, q.status));
    const rows = await this.db
      .select({ shift: shifts, site: sites.name })
      .from(shifts)
      .innerJoin(sites, eq(sites.id, shifts.siteId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(shifts.shiftDate), desc(shifts.createdAt))
      .limit(200);
    return rows.map((r) => ({ ...view(r.shift), siteName: r.site }));
  }

  async getShift(id: string, exec: Db | Tx = this.db) {
    const [r] = await exec
      .select({ shift: shifts, site: sites.name, closedBy: users.name })
      .from(shifts)
      .innerJoin(sites, eq(sites.id, shifts.siteId))
      .innerJoin(users, eq(users.id, shifts.closedBy))
      .where(eq(shifts.id, id));
    if (!r) throw new NotFoundException("Shift not found");
    const meters = await exec
      .select({ row: shiftPumps, code: pumps.code })
      .from(shiftPumps)
      .innerJoin(pumps, eq(pumps.id, shiftPumps.pumpId))
      .where(eq(shiftPumps.shiftId, id))
      .orderBy(asc(pumps.code));
    const fillRows = await exec
      .select()
      .from(fills)
      .where(eq(fills.shiftId, id));
    return {
      ...view(r.shift),
      siteName: r.site,
      closedByName: r.closedBy,
      meters: meters.map(({ row, code }) => ({
        pumpId: row.pumpId,
        code,
        opening: num(row.opening)!,
        closing: num(row.closing)!,
        quantity: num(row.quantity)!,
        price: num(row.price)!,
        amount: num(row.amount)!,
      })),
      fills: {
        count: fillRows.length,
        kg: n2(fillRows.reduce((a, f) => a + Number(f.kg), 0)),
        amount: n2(fillRows.reduce((a, f) => a + Number(f.amount), 0)),
      },
    };
  }

  private async applyVariance(tx: Tx, req: DecidedRequest, actor: Actor) {
    const id = (req.payload as { shiftId?: string } | null)?.shiftId;
    if (!id) return;
    const [s] = await tx
      .select()
      .from(shifts)
      .where(eq(shifts.id, id))
      .for("update");
    if (!s || s.status !== "variance_pending") return;
    const approved = req.status === "approved";
    if (approved)
      for (const c of s.tankCheck.filter((x) => !x.within)) {
        const tank = await this.stock.lockTank(tx, c.tankId);
        // The difference as measured at close, not recomputed.
        await this.stock.post(tx, tank, {
          tankId: c.tankId,
          kind: "variance_adjustment",
          quantity: c.variance,
          ref: s.number,
          docId: req.id,
          userId: actor.userId,
        });
      }
    await tx
      .update(shifts)
      .set({ status: approved ? "variance_accepted" : "variance_rejected" })
      .where(eq(shifts.id, id));
    await this.audit.record(tx, actor, {
      action: approved ? "shift.variance_accepted" : "shift.variance_rejected",
      entityType: "shift",
      entityId: id,
      after: { approval: req.id },
    });
  }

  /** Where a pump's meter stands: its last closing, or its set-up reading. */
  private async lastMeter(exec: Db | Tx, p: typeof pumps.$inferSelect) {
    const [last] = await exec
      .select({ closing: shiftPumps.closing })
      .from(shiftPumps)
      .innerJoin(shifts, eq(shifts.id, shiftPumps.shiftId))
      .where(eq(shiftPumps.pumpId, p.id))
      .orderBy(desc(shifts.createdAt))
      .limit(1);
    return Number(last?.closing ?? p.openingMeter);
  }
}

const view = (s: Shift) => ({
  ...s,
  expected: num(s.expected)!,
  cash: num(s.cash)!,
  pos: num(s.pos)!,
  transfer: num(s.transfer)!,
  cashVariance: num(s.cashVariance)!,
  bankedAmount: num(s.bankedAmount),
  /** Cash counted at close that didn't reach the bank. */
  cashShortAtBank:
    s.bankedAmount === null
      ? null
      : n2(Number(s.cash) - Number(s.bankedAmount)),
});
