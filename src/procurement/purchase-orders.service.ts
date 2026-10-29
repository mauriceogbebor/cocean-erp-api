import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  CreatePurchaseOrderInput,
  GoodsReceiptInput,
} from "@cocean/contracts";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import {
  goodsReceiptLines,
  goodsReceipts,
  products,
  purchaseOrderLines,
  purchaseOrders,
  sites,
  supplierBills,
  tanks,
  vendors,
} from "../db/schema.js";
import { StockService } from "../stock/stock.service.js";
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
import { kobo, naira, priceLine, toNaira } from "./money.js";

type Status = (typeof purchaseOrders.$inferSelect)["status"];
type Lines = CreatePurchaseOrderInput["lines"];

@Injectable()
export class PurchaseOrdersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(ApprovalHandlers) handlers: ApprovalHandlers,
  ) {
    handlers.register("purchase_order", (tx, req, actor) =>
      this.applyDecision(tx, req, actor),
    );
  }

  async list(q: { status?: Status; vendorId?: string }) {
    const where: SQL[] = [];
    if (q.status) where.push(eq(purchaseOrders.status, q.status));
    if (q.vendorId) where.push(eq(purchaseOrders.vendorId, q.vendorId));
    const rows = await this.db
      .select({ po: purchaseOrders, vendor: vendors.name })
      .from(purchaseOrders)
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(purchaseOrders.createdAt))
      .limit(200);
    return rows.map((r) => ({ ...money(r.po), vendorName: r.vendor }));
  }

  /** The order with its lines, what has been received, and the bills against it. */
  async get(id: string, exec: Db | Tx = this.db) {
    const [r] = await exec
      .select({
        po: purchaseOrders,
        vendor: { id: vendors.id, code: vendors.code, name: vendors.name },
      })
      .from(purchaseOrders)
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .where(eq(purchaseOrders.id, id));
    if (!r) throw new NotFoundException("Purchase order not found");
    const lines = await exec
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.poId, id))
      .orderBy(asc(purchaseOrderLines.lineNo));
    const grns = await exec
      .select()
      .from(goodsReceipts)
      .where(eq(goodsReceipts.poId, id))
      .orderBy(asc(goodsReceipts.createdAt));
    const bills = await exec
      .select({
        id: supplierBills.id,
        number: supplierBills.number,
        vendorInvoiceNo: supplierBills.vendorInvoiceNo,
        status: supplierBills.status,
        total: supplierBills.total,
      })
      .from(supplierBills)
      .where(eq(supplierBills.poId, id));
    return {
      ...money(r.po),
      vendor: r.vendor,
      lines: lines.map((l) => ({
        ...l,
        quantity: num(l.quantity)!,
        unitPrice: num(l.unitPrice)!,
        vatRate: num(l.vatRate)!,
        amount: num(l.amount)!,
        vat: num(l.vat)!,
        received: num(l.received)!,
        billed: num(l.billed)!,
      })),
      receipts: grns,
      bills: bills.map((b) => ({ ...b, total: num(b.total)! })),
    };
  }

  async create(input: CreatePurchaseOrderInput, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [v] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, input.vendorId));
      if (!v?.active)
        throw new UnprocessableEntityException(
          "Supplier not found or inactive",
        );
      const [s] = await tx
        .select()
        .from(sites)
        .where(eq(sites.id, input.siteId));
      if (!s?.active)
        throw new UnprocessableEntityException(
          "Delivery site not found or inactive",
        );
      const number = await nextNumber(tx, "PO");
      const [po] = await tx
        .insert(purchaseOrders)
        .values({
          number,
          vendorId: v.id,
          siteId: s.id,
          justification: input.justification,
          quoteRef: input.quoteRef ?? null,
          subtotal: "0",
          vat: "0",
          total: "0",
          createdBy: user.id,
        })
        .returning();
      await this.writeLines(tx, po.id, input.lines);
      await this.audit.record(tx, actor, {
        action: "purchase_order.created",
        entityType: "purchase_order",
        entityId: po.id,
        after: { number, vendor: v.code, lines: input.lines },
      });
      return this.get(po.id, tx);
    });
  }

  async replaceLines(id: string, lines: Lines, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const po = await this.lock(tx, id);
      if (po.status !== "draft")
        throw new ConflictException(
          `Only a draft can be changed (this one is ${po.status})`,
        );
      const before = await this.get(id, tx);
      await tx
        .delete(purchaseOrderLines)
        .where(eq(purchaseOrderLines.poId, id));
      await this.writeLines(tx, id, lines);
      await this.audit.record(tx, actor, {
        action: "purchase_order.lines_changed",
        entityType: "purchase_order",
        entityId: id,
        before: { total: before.total, lines: before.lines.length },
        after: { lines },
      });
      return this.get(id, tx);
    });
  }

  /** Sends the order for approval; routed by its total (with VAT). */
  async submit(id: string, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const po = await this.lock(tx, id);
      if (po.status !== "draft")
        throw new ConflictException(`Already ${po.status}`);
      const full = await this.get(id, tx);
      const [v] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, po.vendorId));
      if (!v.active)
        throw new UnprocessableEntityException(
          `${v.name} is no longer an active supplier`,
        );
      const what = full.lines
        .map(
          (l) =>
            `${l.quantity.toLocaleString("en-NG")} ${l.unit} ${l.description} at ${naira(l.unitPrice)}`,
        )
        .join("; ");
      const approval = await this.approvals.createIn(
        tx,
        {
          kind: "purchase_order",
          ref: po.number,
          title: `${v.name} · ${po.number}, ${naira(full.total)}`,
          amount: full.total,
          reason: `${po.justification} — ${what}${po.quoteRef ? ` (quote ${po.quoteRef})` : ""}`,
        },
        user.id,
        actor,
        { purchaseOrderId: id },
      );
      await this.setStatus(
        tx,
        id,
        "pending",
        actor,
        "purchase_order.submitted",
      );
      return { ...(await this.get(id, tx)), approval };
    });
  }

  async cancel(id: string, reason: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const po = await this.lock(tx, id);
      if (po.status === "pending")
        throw new ConflictException("Withdraw the approval request first");
      if (po.status !== "draft" && po.status !== "approved")
        throw new ConflictException(
          `A ${po.status.replace("_", " ")} order can't be cancelled`,
        );
      await tx
        .update(purchaseOrders)
        .set({
          status: "cancelled",
          cancelledReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrders.id, id));
      await this.audit.record(tx, actor, {
        action: "purchase_order.cancelled",
        entityType: "purchase_order",
        entityId: id,
        before: { status: po.status },
        after: { status: "cancelled", reason },
      });
      return this.get(id, tx);
    });
  }

  /**
   * Records what arrived, against the order's lines. The person who raised
   * the order can't also receive it, and nobody can receive more than was
   * ordered.
   */
  async receive(
    id: string,
    input: GoodsReceiptInput,
    user: AuthUser,
    actor: Actor,
  ) {
    if (input.receivedOn > lagosDate())
      throw new UnprocessableEntityException(
        "Goods can't be received in the future",
      );
    return this.db.transaction(async (tx) => {
      const po = await this.lock(tx, id);
      if (po.status !== "approved" && po.status !== "partially_received")
        throw new ConflictException(
          `Goods can only be received on an approved order (this one is ${po.status})`,
        );
      if (po.createdBy === user.id)
        throw new ForbiddenException(
          "The person who raised the order can't receive it",
        );
      const ids = input.lines.map((l) => l.lineId);
      if (new Set(ids).size !== ids.length)
        throw new UnprocessableEntityException("Each line appears once");
      const lines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(
          and(
            eq(purchaseOrderLines.poId, id),
            inArray(purchaseOrderLines.id, ids),
          ),
        )
        .for("update");
      for (const l of input.lines) {
        const pl = lines.find((x) => x.id === l.lineId);
        if (!pl)
          throw new UnprocessableEntityException(
            `Line ${l.lineId} isn't on ${po.number}`,
          );
        const left = Number(pl.quantity) - Number(pl.received);
        if (l.quantity > left + 1e-9)
          throw new UnprocessableEntityException(
            `Line ${pl.lineNo} (${pl.description}): ${l.quantity} received but only ${left} ${pl.unit} still due`,
          );
      }
      // Bulk product goes into a tank: one that holds it at the receiving site.
      const tankFor = new Map<string, typeof tanks.$inferSelect>();
      for (const l of input.lines) {
        const pl = lines.find((x) => x.id === l.lineId)!;
        const options = pl.productCode
          ? await tx
              .select()
              .from(tanks)
              .where(
                and(
                  eq(tanks.siteId, po.siteId),
                  eq(tanks.productCode, pl.productCode),
                  eq(tanks.active, true),
                ),
              )
          : [];
        if (!options.length) {
          if (l.tankId)
            throw new UnprocessableEntityException(
              `Line ${pl.lineNo} doesn't go into a tank at this site`,
            );
          continue;
        }
        const tank = options.find((t) => t.id === l.tankId);
        if (!tank)
          throw new UnprocessableEntityException(
            `Line ${pl.lineNo} (${pl.productCode}): choose the tank it went into (${options.map((t) => t.code).join(", ")})`,
          );
        tankFor.set(l.lineId, await this.stock.lockTank(tx, tank.id));
      }
      const number = await nextNumber(tx, "GRN");
      const [grn] = await tx
        .insert(goodsReceipts)
        .values({
          number,
          poId: id,
          receivedOn: input.receivedOn,
          deliveryNote: input.deliveryNote,
          notes: input.notes ?? null,
          receivedBy: user.id,
        })
        .returning();
      await tx.insert(goodsReceiptLines).values(
        input.lines.map((l) => ({
          receiptId: grn.id,
          poLineId: l.lineId,
          quantity: String(l.quantity),
          tankId: tankFor.get(l.lineId)?.id ?? null,
        })),
      );
      for (const l of input.lines) {
        const tank = tankFor.get(l.lineId);
        if (tank)
          await this.stock.post(tx, tank, {
            tankId: tank.id,
            kind: "receipt",
            quantity: l.quantity,
            ref: number,
            docId: grn.id,
            userId: user.id,
          });
      }
      for (const l of input.lines) {
        const pl = lines.find((x) => x.id === l.lineId)!;
        await tx
          .update(purchaseOrderLines)
          .set({ received: String(Number(pl.received) + l.quantity) })
          .where(eq(purchaseOrderLines.id, pl.id));
      }
      const all = await tx
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.poId, id));
      const done = all.every(
        (l) => Number(l.received) >= Number(l.quantity) - 1e-9,
      );
      await tx
        .update(purchaseOrders)
        .set({
          status: done ? "received" : "partially_received",
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrders.id, id));
      await this.audit.record(tx, actor, {
        action: "goods.received",
        entityType: "purchase_order",
        entityId: id,
        after: {
          grn: number,
          deliveryNote: input.deliveryNote,
          lines: input.lines,
        },
      });
      return { ...(await this.get(id, tx)), goodsReceipt: grn };
    });
  }

  private async writeLines(tx: Tx, poId: string, lines: Lines) {
    const codes = [
      ...new Set(lines.flatMap((l) => (l.productCode ? [l.productCode] : []))),
    ];
    if (codes.length) {
      const found = await tx
        .select()
        .from(products)
        .where(inArray(products.code, codes));
      const bad = codes.find(
        (c) => !found.some((p) => p.code === c && p.active),
      );
      if (bad)
        throw new UnprocessableEntityException(
          `Unknown or inactive product ${bad}`,
        );
    }
    let sub = 0;
    let vat = 0;
    const rows = lines.map((l, i) => {
      const p = priceLine(l.quantity, l.unitPrice, l.vatRate);
      sub += p.amount;
      vat += p.vat;
      return {
        poId,
        lineNo: i + 1,
        productCode: l.productCode ?? null,
        description: l.description,
        quantity: String(l.quantity),
        unit: l.unit,
        unitPrice: toNaira(kobo(l.unitPrice)),
        vatRate: String(l.vatRate),
        amount: toNaira(p.amount),
        vat: toNaira(p.vat),
      };
    });
    await tx.insert(purchaseOrderLines).values(rows);
    await tx
      .update(purchaseOrders)
      .set({
        subtotal: toNaira(sub),
        vat: toNaira(vat),
        total: toNaira(sub + vat),
        updatedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, poId));
  }

  private async lock(tx: Tx, id: string) {
    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, id))
      .for("update");
    if (!po) throw new NotFoundException("Purchase order not found");
    return po;
  }

  private async setStatus(
    tx: Tx,
    id: string,
    status: Status,
    actor: Actor,
    action: string,
  ) {
    const [before] = await tx
      .select({ status: purchaseOrders.status })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, id));
    await tx
      .update(purchaseOrders)
      .set({
        status,
        updatedAt: new Date(),
        ...(status === "approved" ? { approvedAt: new Date() } : {}),
      })
      .where(eq(purchaseOrders.id, id));
    await this.audit.record(tx, actor, {
      action,
      entityType: "purchase_order",
      entityId: id,
      before,
      after: { status },
    });
  }

  /** Approved: the supplier can deliver. Rejected or withdrawn: back to draft. */
  private async applyDecision(tx: Tx, req: DecidedRequest, actor: Actor) {
    const id = (req.payload as { purchaseOrderId?: string } | null)
      ?.purchaseOrderId;
    if (!id) return;
    const po = await this.lock(tx, id);
    if (po.status !== "pending") return;
    if (req.status === "approved")
      await this.setStatus(
        tx,
        id,
        "approved",
        actor,
        "purchase_order.approved",
      );
    else
      await this.setStatus(tx, id, "draft", actor, "purchase_order.returned");
  }
}

const money = (po: typeof purchaseOrders.$inferSelect) => ({
  ...po,
  subtotal: num(po.subtotal)!,
  vat: num(po.vat)!,
  total: num(po.total)!,
});
