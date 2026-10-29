import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { CreateOrderInput } from "@cocean/contracts";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import {
  customerSites,
  customers,
  products,
  salesOrderLines,
  salesOrders,
} from "../db/schema.js";
import { ApprovalHandlers } from "../approvals/approval-handlers.js";
import { ApprovalsService } from "../approvals/approvals.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { lagosDate } from "../common/dates.js";
import { num } from "../common/num.js";
import { nextNumber } from "../common/numbering.js";
import { DB } from "../common/tokens.js";
import { CustomersService } from "../customers/customers.service.js";
import { PricingService } from "../pricing/pricing.service.js";

type Status = (typeof salesOrders.$inferSelect)["status"];
const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;
/** Kobo-safe money arithmetic: work in kobo, store naira with 2 decimals. */
const toKobo = (n: number) => Math.round(n * 100);
const fromKobo = (k: number) => (k / 100).toFixed(2);

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(CustomersService) private readonly customers: CustomersService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(ApprovalHandlers) handlers: ApprovalHandlers,
  ) {
    handlers.register("credit_override", (tx, req, actor) =>
      this.applyOverride(tx, req, actor),
    );
  }

  /**
   * Enters an order. Prices come from the approved list in force today and
   * are copied onto the lines; nobody types a price. The credit check runs
   * here, and its result is stored with the order.
   */
  async create(input: CreateOrderInput, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, input.customerId))
        .for("update");
      if (!c) throw new UnprocessableEntityException("Customer not found");
      if (!c.active)
        throw new UnprocessableEntityException(
          `${c.name} is not an active customer`,
        );

      const siteIds = [...new Set(input.lines.map((l) => l.deliverySiteId))];
      const sites = await tx
        .select()
        .from(customerSites)
        .where(
          and(
            inArray(customerSites.id, siteIds),
            eq(customerSites.customerId, c.id),
          ),
        );
      const badSite = siteIds.find(
        (id) => !sites.some((s) => s.id === id && s.active),
      );
      if (badSite)
        throw new UnprocessableEntityException(
          `Delivery site ${badSite} is not an active site of ${c.name}`,
        );

      const pl = await this.pricing.inForce(tx, lagosDate());
      if (!pl)
        throw new UnprocessableEntityException(
          "No approved price list is in force today. Orders can't be priced.",
        );
      const codes = [...new Set(input.lines.map((l) => l.productCode))];
      const prods = await tx
        .select()
        .from(products)
        .where(inArray(products.code, codes));

      const lines = input.lines.map((l, i) => {
        const p = prods.find((x) => x.code === l.productCode && x.active);
        if (!p)
          throw new UnprocessableEntityException(
            `Unknown or inactive product ${l.productCode}`,
          );
        const price = pl.lines.find(
          (x) => x.productCode === l.productCode,
        )?.price;
        if (price === undefined)
          throw new UnprocessableEntityException(
            `${l.productCode} isn't on price list ${pl.code}`,
          );
        const kobo = Math.round(l.quantity * toKobo(price));
        return {
          lineNo: i + 1,
          productCode: l.productCode,
          quantity: String(l.quantity),
          unit: p.unit,
          unitPrice: String(price),
          amountKobo: kobo,
          deliverySiteId: l.deliverySiteId,
        };
      });
      const totalKobo = lines.reduce((a, l) => a + l.amountKobo, 0);
      const total = totalKobo / 100;

      let status: Status;
      let creditCheck: Record<string, unknown> | null = null;
      if (c.terms === "prepaid") status = "awaiting_payment";
      else {
        const pos = await this.customers.creditPosition(tx, c);
        const exposure = pos.exposure + total;
        creditCheck = {
          limit: pos.limit,
          balance: pos.balance,
          openOrders: pos.openOrders,
          thisOrder: total,
          exposure,
          over: Math.max(0, exposure - pos.limit),
        };
        status = exposure > pos.limit ? "credit_hold" : "released";
      }

      const number = await nextNumber(tx, "SO");
      const [o] = await tx
        .insert(salesOrders)
        .values({
          number,
          customerId: c.id,
          poRef: input.poRef,
          requestRef: input.requestRef ?? null,
          notes: input.notes ?? null,
          terms: c.terms,
          status,
          priceListId: pl.id,
          total: fromKobo(totalKobo),
          creditCheck,
          createdBy: user.id,
          releasedAt: status === "released" ? new Date() : null,
        })
        .returning();
      await tx.insert(salesOrderLines).values(
        lines.map(({ amountKobo, ...l }) => ({
          ...l,
          orderId: o.id,
          amount: fromKobo(amountKobo),
        })),
      );
      await this.audit.record(tx, actor, {
        action: "order.created",
        entityType: "order",
        entityId: o.id,
        after: { number, status, total, priceList: pl.code, creditCheck },
      });
      return this.get(o.id, tx);
    });
  }

  async get(id: string, exec: Db | Tx = this.db) {
    const [o] = await exec
      .select({
        order: salesOrders,
        customer: {
          id: customers.id,
          code: customers.code,
          name: customers.name,
        },
      })
      .from(salesOrders)
      .innerJoin(customers, eq(customers.id, salesOrders.customerId))
      .where(eq(salesOrders.id, id));
    if (!o) throw new NotFoundException("Order not found");
    const lines = await exec
      .select({
        line: salesOrderLines,
        site: { id: customerSites.id, name: customerSites.name },
      })
      .from(salesOrderLines)
      .innerJoin(
        customerSites,
        eq(customerSites.id, salesOrderLines.deliverySiteId),
      )
      .where(eq(salesOrderLines.orderId, id))
      .orderBy(asc(salesOrderLines.lineNo));
    return {
      ...o.order,
      total: num(o.order.total)!,
      customer: o.customer,
      lines: lines.map(({ line, site }) => ({
        ...line,
        quantity: num(line.quantity)!,
        unitPrice: num(line.unitPrice)!,
        amount: num(line.amount)!,
        deliverySite: site,
      })),
    };
  }

  async list(q: { status?: Status; customerId?: string }) {
    const where: SQL[] = [];
    if (q.status) where.push(eq(salesOrders.status, q.status));
    if (q.customerId) where.push(eq(salesOrders.customerId, q.customerId));
    const rows = await this.db
      .select({ order: salesOrders, customer: customers.name })
      .from(salesOrders)
      .innerJoin(customers, eq(customers.id, salesOrders.customerId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(salesOrders.createdAt))
      .limit(200);
    return rows.map((r) => ({
      ...r.order,
      total: num(r.order.total)!,
      customerName: r.customer,
    }));
  }

  /** Sales asks for an order on credit hold to go ahead; routed by amount. */
  async requestOverride(
    id: string,
    reason: string,
    user: AuthUser,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const o = await this.lock(tx, id);
      if (o.status !== "credit_hold")
        throw new ConflictException(
          `Only an order on credit hold needs an override (this one is ${o.status})`,
        );
      const [c] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, o.customerId));
      const check = o.creditCheck as {
        limit: number;
        exposure: number;
        over: number;
      } | null;
      const approval = await this.approvals.createIn(
        tx,
        {
          kind: "credit_override",
          ref: o.number,
          title: `${c.name} · ${o.number} on credit, ${naira(num(o.total)!)}`,
          amount: num(o.total)!,
          reason: check
            ? `${reason} (limit ${naira(check.limit)}, exposure with this order ${naira(check.exposure)}, ${naira(check.over)} over)`
            : reason,
        },
        user.id,
        actor,
        { orderId: id },
      );
      await this.setStatus(
        tx,
        id,
        "override_pending",
        actor,
        "order.override_requested",
      );
      return { ...(await this.get(id, tx)), approval };
    });
  }

  /**
   * Finance releases an order once money or credit covers it: a prepaid
   * order after the customer has paid, or a held credit order after they
   * have paid down. The same check as at entry, run again now.
   */
  async release(id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const o = await this.lock(tx, id);
      if (o.status !== "awaiting_payment" && o.status !== "credit_hold")
        throw new ConflictException(
          `Only an order awaiting payment or on credit hold can be released (this one is ${o.status})`,
        );
      const [c] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, o.customerId))
        .for("update");
      const pos = await this.customers.creditPosition(tx, c);
      const total = num(o.total)!;
      const short = Math.round((pos.exposure + total - pos.limit) * 100) / 100;
      if (short > 0)
        throw new ConflictException(
          c.terms === "prepaid"
            ? `${c.name} has ${naira(Math.max(0, -pos.exposure))} paid and unused; this order needs ${naira(total)}. ${naira(short)} short.`
            : `Still ${naira(short)} over ${c.name}'s ${naira(pos.limit)} limit. Record their payment first, or ask for an override.`,
        );
      await tx
        .update(salesOrders)
        .set({
          creditCheck: { ...pos, thisOrder: total, releasedBy: "finance" },
        })
        .where(eq(salesOrders.id, id));
      await this.setStatus(tx, id, "released", actor, "order.released");
      return this.get(id, tx);
    });
  }

  async cancel(id: string, reason: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const o = await this.lock(tx, id);
      if (o.status === "released" || o.status === "invoiced")
        throw new ConflictException(
          `This order is ${o.status} and can't be cancelled here`,
        );
      if (o.status === "override_pending")
        throw new ConflictException(
          "Withdraw the credit override request first",
        );
      if (o.status === "cancelled")
        throw new ConflictException("Already cancelled");
      await tx
        .update(salesOrders)
        .set({
          status: "cancelled",
          cancelledReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(salesOrders.id, id));
      await this.audit.record(tx, actor, {
        action: "order.cancelled",
        entityType: "order",
        entityId: id,
        before: { status: o.status },
        after: { status: "cancelled", reason },
      });
      return this.get(id, tx);
    });
  }

  private async lock(tx: Tx, id: string) {
    const [o] = await tx
      .select()
      .from(salesOrders)
      .where(eq(salesOrders.id, id))
      .for("update");
    if (!o) throw new NotFoundException("Order not found");
    return o;
  }

  private async setStatus(
    tx: Tx,
    id: string,
    status: Status,
    actor: Actor,
    action: string,
  ) {
    const [before] = await tx
      .select({ status: salesOrders.status })
      .from(salesOrders)
      .where(eq(salesOrders.id, id));
    await tx
      .update(salesOrders)
      .set({
        status,
        updatedAt: new Date(),
        ...(status === "released" ? { releasedAt: new Date() } : {}),
      })
      .where(eq(salesOrders.id, id));
    await this.audit.record(tx, actor, {
      action,
      entityType: "order",
      entityId: id,
      before,
      after: { status },
    });
  }

  /** Approved: the order goes to Logistics. Rejected or withdrawn: back on hold. */
  private async applyOverride(
    tx: Tx,
    req: { status: string; payload: unknown },
    actor: Actor,
  ) {
    const orderId = (req.payload as { orderId?: string } | null)?.orderId;
    if (!orderId) return;
    const o = await this.lock(tx, orderId);
    if (o.status !== "override_pending") return;
    if (req.status === "approved")
      await this.setStatus(
        tx,
        orderId,
        "released",
        actor,
        "order.released_on_override",
      );
    else
      await this.setStatus(
        tx,
        orderId,
        "credit_hold",
        actor,
        "order.override_refused",
      );
  }
}
