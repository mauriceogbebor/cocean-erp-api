import { createHash, randomBytes } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  STOCK_RULES,
  type ConfirmDeliveryInput,
  type LoadLiftingInput,
  type PlanLiftingInput,
} from "@cocean/contracts";
import { and, asc, desc, eq, inArray, ne, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import {
  customerSites,
  customers,
  invoices,
  liftingDrops,
  liftings,
  salesOrderLines,
  salesOrders,
  sites,
  tanks,
} from "../db/schema.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { num } from "../common/num.js";
import { nextNumber } from "../common/numbering.js";
import { DB } from "../common/tokens.js";
import { StockService } from "../stock/stock.service.js";

type Lifting = typeof liftings.$inferSelect;
type Drop = typeof liftingDrops.$inferSelect;
type Status = Lifting["status"];
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const q3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => n.toLocaleString("en-NG");

/** What a drop counts against its order line: loaded once loaded, planned before. */
const committed = (d: Drop) => Number(d.loadedQuantity ?? d.plannedQuantity);

@Injectable()
export class LiftingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StockService) private readonly stock: StockService,
  ) {}

  async list(q: { status?: Status; orderId?: string }) {
    const where: SQL[] = [];
    if (q.status) where.push(eq(liftings.status, q.status));
    if (q.orderId) where.push(eq(liftings.orderId, q.orderId));
    const rows = await this.db
      .select({
        lifting: liftings,
        order: salesOrders.number,
        customer: customers.name,
        site: sites.name,
      })
      .from(liftings)
      .innerJoin(salesOrders, eq(salesOrders.id, liftings.orderId))
      .innerJoin(customers, eq(customers.id, salesOrders.customerId))
      .innerJoin(sites, eq(sites.id, liftings.siteId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(liftings.createdAt))
      .limit(200);
    return rows.map((r) => ({
      ...r.lifting,
      orderNumber: r.order,
      customerName: r.customer,
      siteName: r.site,
    }));
  }

  /**
   * A lifting with its drops. Seal numbers go only to people who plan, load
   * or investigate: anyone else could pass them to a receiver and defeat
   * the blind check.
   */
  async get(id: string, exec: Db | Tx = this.db, viewer?: AuthUser) {
    const seeSeals =
      !viewer ||
      viewer.permissions.some((p) =>
        ["liftings.plan", "liftings.load", "deliveries.resolve"].includes(p),
      );
    const [r] = await exec
      .select({
        lifting: liftings,
        order: salesOrders.number,
        customer: customers.name,
        site: sites.name,
      })
      .from(liftings)
      .innerJoin(salesOrders, eq(salesOrders.id, liftings.orderId))
      .innerJoin(customers, eq(customers.id, salesOrders.customerId))
      .innerJoin(sites, eq(sites.id, liftings.siteId))
      .where(eq(liftings.id, id));
    if (!r) throw new NotFoundException("Lifting not found");
    const drops = await exec
      .select({
        drop: liftingDrops,
        line: salesOrderLines,
        site: customerSites.name,
        tank: tanks.code,
        invoice: invoices.number,
      })
      .from(liftingDrops)
      .innerJoin(
        salesOrderLines,
        eq(salesOrderLines.id, liftingDrops.orderLineId),
      )
      .innerJoin(
        customerSites,
        eq(customerSites.id, salesOrderLines.deliverySiteId),
      )
      .leftJoin(tanks, eq(tanks.id, liftingDrops.tankId))
      .leftJoin(invoices, eq(invoices.dropId, liftingDrops.id))
      .where(eq(liftingDrops.liftingId, id))
      .orderBy(asc(salesOrderLines.lineNo));
    return {
      ...r.lifting,
      orderNumber: r.order,
      customerName: r.customer,
      siteName: r.site,
      drops: drops.map(
        ({ drop: { tokenHash: _, ...d }, line, site, tank, invoice }) => ({
          ...d,
          plannedQuantity: num(d.plannedQuantity)!,
          loadedQuantity: num(d.loadedQuantity),
          receivedQuantity: num(d.receivedQuantity),
          productCode: line.productCode,
          unit: line.unit,
          deliverySiteName: site,
          tankCode: tank,
          invoiceNumber: invoice,
          ...(seeSeals ? {} : { seals: null, receivedSeals: null }),
        }),
      ),
    };
  }

  /** Plans one truck against a released order; each drop is one order line's delivery. */
  async plan(input: PlanLiftingInput, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [o] = await tx
        .select()
        .from(salesOrders)
        .where(eq(salesOrders.id, input.orderId))
        .for("update");
      if (!o) throw new UnprocessableEntityException("Order not found");
      if (o.status !== "released")
        throw new ConflictException(
          `Only a released order can be loaded (${o.number} is ${o.status.replace("_", " ")})`,
        );
      const [depot] = await tx
        .select()
        .from(sites)
        .where(eq(sites.id, input.siteId));
      if (!depot?.active || depot.kind !== "depot")
        throw new UnprocessableEntityException(
          "Trucks load at an active depot",
        );
      const lines = await tx
        .select()
        .from(salesOrderLines)
        .where(
          and(
            eq(salesOrderLines.orderId, o.id),
            inArray(
              salesOrderLines.id,
              input.drops.map((d) => d.orderLineId),
            ),
          ),
        );
      const earlier = await this.activeDrops(
        tx,
        lines.map((l) => l.id),
      );
      for (const d of input.drops) {
        const line = lines.find((l) => l.id === d.orderLineId);
        if (!line)
          throw new UnprocessableEntityException(
            `Line ${d.orderLineId} isn't on ${o.number}`,
          );
        const used = earlier
          .filter((e) => e.orderLineId === line.id)
          .reduce((a, e) => a + committed(e), 0);
        const left = q3(Number(line.quantity) - used);
        if (d.quantity > left + 1e-9)
          throw new UnprocessableEntityException(
            `Line ${line.lineNo} (${line.productCode}): ${fmt(d.quantity)} ${line.unit} planned, but only ${fmt(left)} is still to load`,
          );
      }
      const number = await nextNumber(tx, "LI");
      const [l] = await tx
        .insert(liftings)
        .values({
          number,
          orderId: o.id,
          siteId: depot.id,
          truckPlate: input.truckPlate.replace(
            /^([A-Z]{3})-?(\d{3})-?([A-Z]{2})$/,
            "$1-$2-$3",
          ),
          driverName: input.driverName,
          driverPhone: input.driverPhone,
          plannedBy: user.id,
        })
        .returning();
      await tx.insert(liftingDrops).values(
        input.drops.map((d) => ({
          liftingId: l.id,
          orderLineId: d.orderLineId,
          plannedQuantity: String(d.quantity),
        })),
      );
      await this.audit.record(tx, actor, {
        action: "lifting.planned",
        entityType: "lifting",
        entityId: l.id,
        after: {
          number,
          order: o.number,
          truck: l.truckPlate,
          drops: input.drops,
        },
      });
      return this.get(l.id, tx);
    });
  }

  async cancel(id: string, reason: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const l = await this.lock(tx, id);
      if (l.status !== "planned")
        throw new ConflictException(
          `A lifting that is ${l.status.replace("_", " ")} can't be cancelled`,
        );
      await tx
        .update(liftings)
        .set({
          status: "cancelled",
          cancelledReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(liftings.id, id));
      await tx
        .update(liftingDrops)
        .set({ status: "cancelled" })
        .where(eq(liftingDrops.liftingId, id));
      await this.audit.record(tx, actor, {
        action: "lifting.cancelled",
        entityType: "lifting",
        entityId: id,
        before: { status: l.status },
        after: { status: "cancelled", reason },
      });
      return this.get(id, tx);
    });
  }

  /**
   * The depot loads the truck: quantity from the meter, the tank it came
   * from, the seals fitted. Stock leaves the tank now. Each drop gets a
   * one-time link for the customer's receiver, returned only here.
   */
  async load(
    id: string,
    input: LoadLiftingInput,
    user: AuthUser,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const l = await this.lock(tx, id);
      if (l.status !== "planned")
        throw new ConflictException(`Already ${l.status.replace("_", " ")}`);
      if (l.plannedBy === user.id)
        throw new ForbiddenException(
          "The person who planned the truck can't also load it",
        );
      const drops = await tx
        .select()
        .from(liftingDrops)
        .where(eq(liftingDrops.liftingId, id));
      const given = input.drops.map((d) => d.dropId);
      if (
        given.length !== drops.length ||
        !drops.every((d) => given.includes(d.id))
      )
        throw new UnprocessableEntityException(
          "Record every drop on this truck, once each",
        );
      const allSeals = input.drops.flatMap((d) => d.seals);
      if (new Set(allSeals).size !== allSeals.length)
        throw new UnprocessableEntityException(
          "A seal number is used twice on this truck",
        );
      const lines = await tx
        .select()
        .from(salesOrderLines)
        .where(
          inArray(
            salesOrderLines.id,
            drops.map((d) => d.orderLineId),
          ),
        );

      const links: { dropId: string; token: string; expiresAt: Date }[] = [];
      for (const d of input.drops) {
        const drop = drops.find((x) => x.id === d.dropId)!;
        const line = lines.find((x) => x.id === drop.orderLineId)!;
        if (d.loadedQuantity > Number(drop.plannedQuantity) + 1e-9)
          throw new UnprocessableEntityException(
            `${fmt(d.loadedQuantity)} ${line.unit} loaded but ${fmt(Number(drop.plannedQuantity))} planned: re-plan before loading more`,
          );
        const tank = await this.stock.lockTank(tx, d.tankId);
        if (
          tank.siteId !== l.siteId ||
          tank.productCode !== line.productCode ||
          !tank.active
        )
          throw new UnprocessableEntityException(
            `${tank.code} doesn't hold ${line.productCode} at this depot`,
          );
        await this.stock.post(tx, tank, {
          tankId: tank.id,
          kind: "lifting",
          quantity: -d.loadedQuantity,
          ref: l.number,
          docId: l.id,
          userId: user.id,
        });
        const token = randomBytes(24).toString("base64url");
        const expiresAt = new Date(
          Date.now() + STOCK_RULES.deliveryLinkDays * 86_400_000,
        );
        await tx
          .update(liftingDrops)
          .set({
            tankId: tank.id,
            loadedQuantity: String(d.loadedQuantity),
            seals: d.seals,
            status: "in_transit",
            tokenHash: sha256(token),
            tokenExpiresAt: expiresAt,
          })
          .where(eq(liftingDrops.id, drop.id));
        links.push({ dropId: drop.id, token, expiresAt });
      }
      await tx
        .update(liftings)
        .set({
          status: "in_transit",
          loadedBy: user.id,
          loadedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(liftings.id, id));
      await this.audit.record(tx, actor, {
        action: "lifting.loaded",
        entityType: "lifting",
        entityId: id,
        after: {
          drops: input.drops.map(
            ({ dropId, tankId, loadedQuantity, seals }) => ({
              dropId,
              tankId,
              loadedQuantity,
              seals: seals.length,
            }),
          ),
        },
      });
      return { ...(await this.get(id, tx)), deliveryLinks: links };
    });
  }

  /**
   * The customer's receiver confirms a delivery with their one-time link.
   * They never see what was loaded or which seals were fitted, so what they
   * type is a real check. The answer says only that it was recorded.
   */
  async confirm(input: ConfirmDeliveryInput, actor: Actor) {
    const outcome = await this.db.transaction(async (tx) => {
      const [drop] = await tx
        .select()
        .from(liftingDrops)
        .where(eq(liftingDrops.tokenHash, sha256(input.token)))
        .for("update");
      if (!drop)
        throw new NotFoundException(
          "This delivery link isn't valid, or the delivery is already confirmed",
        );
      if (drop.tokenExpiresAt && drop.tokenExpiresAt < new Date())
        throw new GoneException(
          "This delivery link has expired. Ask Cocean's logistics team for a new one.",
        );
      if (drop.status !== "in_transit")
        throw new ConflictException("This delivery is already confirmed");
      const [line] = await tx
        .select()
        .from(salesOrderLines)
        .where(eq(salesOrderLines.id, drop.orderLineId));

      const loaded = Number(drop.loadedQuantity);
      const fitted = [...(drop.seals ?? [])].sort();
      const typed = [...new Set(input.seals)].sort();
      const exceptions: string[] = [];
      if (
        fitted.length !== typed.length ||
        fitted.some((s, i) => s !== typed[i])
      )
        exceptions.push(
          "The seals the receiver entered don't match the seals fitted at the depot",
        );
      const diff = q3(input.receivedQuantity - loaded);
      if (Math.abs(diff) > STOCK_RULES.deliveryTolerancePct * loaded)
        exceptions.push(
          `Received ${fmt(input.receivedQuantity)} ${line.unit} against ${fmt(loaded)} loaded: ${diff < 0 ? "short" : "over"} by ${fmt(Math.abs(diff))} (${((Math.abs(diff) / loaded) * 100).toFixed(2)}%)`,
        );
      await tx
        .update(liftingDrops)
        .set({
          receiverName: input.receiverName,
          receivedQuantity: String(input.receivedQuantity),
          receivedSeals: input.seals,
          receiverNotes: input.notes ?? null,
          confirmedAt: new Date(),
          exceptions,
          status: exceptions.length ? "exception" : "delivered",
          // Single use: the link stops working once used.
          tokenHash: null,
        })
        .where(eq(liftingDrops.id, drop.id));
      const status = await this.settle(tx, drop.liftingId);
      await this.audit.record(tx, actor, {
        action: exceptions.length ? "delivery.exception" : "delivery.confirmed",
        entityType: "lifting",
        entityId: drop.liftingId,
        after: {
          drop: drop.id,
          receiver: input.receiverName,
          received: input.receivedQuantity,
          exceptions,
          lifting: status,
        },
      });
      const [l] = await tx
        .select({ number: liftings.number })
        .from(liftings)
        .where(eq(liftings.id, drop.liftingId));
      return { reference: l.number };
    });
    return {
      recorded: true,
      reference: outcome.reference,
      message:
        "Thank you. Your confirmation is recorded. Cocean will contact you if anything needs checking.",
    };
  }

  /** Security closes an exception once it is investigated; the finding stays on record. */
  async resolve(dropId: string, finding: string, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [d] = await tx
        .select()
        .from(liftingDrops)
        .where(eq(liftingDrops.id, dropId))
        .for("update");
      if (!d) throw new NotFoundException("Delivery not found");
      if (d.status !== "exception")
        throw new ConflictException(
          `Only a delivery with an exception needs resolving (this one is ${d.status})`,
        );
      await tx
        .update(liftingDrops)
        .set({
          status: "resolved",
          finding,
          resolvedBy: user.id,
          resolvedAt: new Date(),
        })
        .where(eq(liftingDrops.id, dropId));
      await this.settle(tx, d.liftingId);
      await this.audit.record(tx, actor, {
        action: "delivery.resolved",
        entityType: "lifting",
        entityId: d.liftingId,
        before: { drop: dropId, exceptions: d.exceptions },
        after: { finding },
      });
      return this.get(d.liftingId, tx);
    });
  }

  /** The lifting's status follows its drops. */
  private async settle(tx: Tx, liftingId: string) {
    const drops = await tx
      .select({ status: liftingDrops.status })
      .from(liftingDrops)
      .where(eq(liftingDrops.liftingId, liftingId));
    const s = drops.map((d) => d.status);
    const status: Status = s.includes("exception")
      ? "exception"
      : s.every((x) => x === "delivered" || x === "resolved")
        ? "delivered"
        : "in_transit";
    await tx
      .update(liftings)
      .set({ status, updatedAt: new Date() })
      .where(eq(liftings.id, liftingId));
    return status;
  }

  private activeDrops(tx: Tx, lineIds: string[]) {
    if (!lineIds.length) return Promise.resolve([] as Drop[]);
    return tx
      .select()
      .from(liftingDrops)
      .where(
        and(
          inArray(liftingDrops.orderLineId, lineIds),
          ne(liftingDrops.status, "cancelled"),
        ),
      );
  }

  private async lock(tx: Tx, id: string) {
    const [l] = await tx
      .select()
      .from(liftings)
      .where(eq(liftings.id, id))
      .for("update");
    if (!l) throw new NotFoundException("Lifting not found");
    return l;
  }
}
