import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  BILL_TOTAL_TOLERANCE,
  type BillPaidInput,
  type SupplierBillInput,
} from "@cocean/contracts";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import {
  purchaseOrderLines,
  purchaseOrders,
  supplierBillLines,
  supplierBills,
  vendors,
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
import { kobo, naira, priceLine, toNaira } from "./money.js";

type Bill = typeof supplierBills.$inferSelect;
type Status = Bill["status"];

const view = (b: Bill) => ({
  ...b,
  statedTotal: num(b.statedTotal)!,
  subtotal: num(b.subtotal)!,
  vat: num(b.vat)!,
  total: num(b.total)!,
});

@Injectable()
export class BillsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(ApprovalHandlers) handlers: ApprovalHandlers,
  ) {
    handlers.register("supplier_payment", (tx, req, actor) =>
      this.applyDecision(tx, req, actor),
    );
  }

  async list(q: { status?: Status; vendorId?: string }) {
    const where: SQL[] = [];
    if (q.status) where.push(eq(supplierBills.status, q.status));
    if (q.vendorId) where.push(eq(supplierBills.vendorId, q.vendorId));
    const rows = await this.db
      .select()
      .from(supplierBills)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(supplierBills.createdAt))
      .limit(200);
    return rows.map(view);
  }

  async get(id: string, exec: Db | Tx = this.db) {
    const [r] = await exec
      .select({
        bill: supplierBills,
        po: purchaseOrders.number,
        vendor: vendors.name,
      })
      .from(supplierBills)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, supplierBills.poId))
      .innerJoin(vendors, eq(vendors.id, supplierBills.vendorId))
      .where(eq(supplierBills.id, id));
    if (!r) throw new NotFoundException("Supplier invoice not found");
    const lines = await exec
      .select({ line: supplierBillLines, po: purchaseOrderLines })
      .from(supplierBillLines)
      .innerJoin(
        purchaseOrderLines,
        eq(purchaseOrderLines.id, supplierBillLines.poLineId),
      )
      .where(eq(supplierBillLines.billId, id))
      .orderBy(asc(purchaseOrderLines.lineNo));
    return {
      ...view(r.bill),
      poNumber: r.po,
      vendorName: r.vendor,
      lines: lines.map(({ line, po }) => ({
        lineNo: po.lineNo,
        poLineId: po.id,
        description: po.description,
        unit: po.unit,
        quantity: num(line.quantity)!,
        unitPrice: num(line.unitPrice)!,
        amount: num(line.amount)!,
        vat: num(line.vat)!,
        ordered: num(po.quantity)!,
        orderedPrice: num(po.unitPrice)!,
        received: num(po.received)!,
      })),
    };
  }

  /**
   * Enters a supplier invoice and matches it three ways: each line against
   * the order's price and against what was received and not yet billed, and
   * the printed total against its lines. A bill that doesn't match is kept,
   * with the reasons, and can't be paid.
   */
  async create(input: SupplierBillInput, user: AuthUser, actor: Actor) {
    if (input.invoiceDate > lagosDate())
      throw new UnprocessableEntityException(
        "An invoice can't be dated in the future",
      );
    return this.db.transaction(async (tx) => {
      const [po] = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, input.purchaseOrderId))
        .for("update");
      if (!po)
        throw new UnprocessableEntityException("Purchase order not found");
      if (!["approved", "partially_received", "received"].includes(po.status))
        throw new ConflictException(
          `${po.number} is ${po.status}; only an approved order can be billed`,
        );
      const [dup] = await tx
        .select({ number: supplierBills.number })
        .from(supplierBills)
        .where(
          and(
            eq(supplierBills.vendorId, po.vendorId),
            eq(supplierBills.vendorInvoiceNo, input.vendorInvoiceNo),
          ),
        );
      if (dup)
        throw new ConflictException(
          `Supplier invoice ${input.vendorInvoiceNo} is already entered as ${dup.number}`,
        );

      const ids = input.lines.map((l) => l.lineId);
      if (new Set(ids).size !== ids.length)
        throw new UnprocessableEntityException("Each line appears once");
      const poLines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(
          and(
            eq(purchaseOrderLines.poId, po.id),
            inArray(purchaseOrderLines.id, ids),
          ),
        )
        .for("update");

      const exceptions: string[] = [];
      let sub = 0;
      let vat = 0;
      const rows = input.lines.map((l) => {
        const pl = poLines.find((x) => x.id === l.lineId);
        if (!pl)
          throw new UnprocessableEntityException(
            `Line ${l.lineId} isn't on ${po.number}`,
          );
        const open = Number(pl.received) - Number(pl.billed);
        if (l.quantity > open + 1e-9)
          exceptions.push(
            `Line ${pl.lineNo} (${pl.description}): billed ${l.quantity} ${pl.unit}, but only ${open} received and not yet billed`,
          );
        if (kobo(l.unitPrice) !== kobo(pl.unitPrice))
          exceptions.push(
            `Line ${pl.lineNo} (${pl.description}): price ${naira(l.unitPrice)}, the order says ${naira(Number(pl.unitPrice))}`,
          );
        const p = priceLine(l.quantity, l.unitPrice, Number(pl.vatRate));
        sub += p.amount;
        vat += p.vat;
        return { pl, l, p };
      });
      const totalK = sub + vat;
      if (
        Math.abs(kobo(input.statedTotal) - totalK) >
        BILL_TOTAL_TOLERANCE * 100
      )
        exceptions.push(
          `The invoice total ${naira(input.statedTotal)} doesn't agree with its lines plus VAT, ${naira(totalK / 100)}`,
        );
      const status: Status = exceptions.length ? "exception" : "matched";

      const number = await nextNumber(tx, "BILL");
      const [b] = await tx
        .insert(supplierBills)
        .values({
          number,
          vendorId: po.vendorId,
          poId: po.id,
          vendorInvoiceNo: input.vendorInvoiceNo,
          invoiceDate: input.invoiceDate,
          statedTotal: toNaira(kobo(input.statedTotal)),
          subtotal: toNaira(sub),
          vat: toNaira(vat),
          total: toNaira(totalK),
          status,
          exceptions,
          recordedBy: user.id,
        })
        .returning();
      await tx.insert(supplierBillLines).values(
        rows.map(({ pl, l, p }) => ({
          billId: b.id,
          poLineId: pl.id,
          quantity: String(l.quantity),
          unitPrice: toNaira(kobo(l.unitPrice)),
          amount: toNaira(p.amount),
          vat: toNaira(p.vat),
        })),
      );
      if (status === "matched")
        await this.adjustBilled(
          tx,
          rows.map(({ pl, l }) => [pl.id, l.quantity]),
        );
      await this.audit.record(tx, actor, {
        action: status === "matched" ? "bill.matched" : "bill.exception",
        entityType: "bill",
        entityId: b.id,
        after: {
          number,
          po: po.number,
          vendorInvoiceNo: input.vendorInvoiceNo,
          total: totalK / 100,
          exceptions,
        },
      });
      return this.get(b.id, tx);
    });
  }

  /** A bill entered wrongly, or one the supplier will reissue. */
  async void(id: string, reason: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const b = await this.lock(tx, id);
      if (b.status !== "matched" && b.status !== "exception")
        throw new ConflictException(
          b.status === "payment_pending"
            ? "Withdraw the payment request first"
            : `A ${b.status} bill can't be voided`,
        );
      if (b.status === "matched") {
        const lines = await tx
          .select()
          .from(supplierBillLines)
          .where(eq(supplierBillLines.billId, id));
        await this.adjustBilled(
          tx,
          lines.map((l) => [l.poLineId, -Number(l.quantity)]),
        );
      }
      await tx
        .update(supplierBills)
        .set({ status: "void", voidReason: reason, updatedAt: new Date() })
        .where(eq(supplierBills.id, id));
      await this.audit.record(tx, actor, {
        action: "bill.voided",
        entityType: "bill",
        entityId: id,
        before: { status: b.status },
        after: { status: "void", reason },
      });
      return this.get(id, tx);
    });
  }

  /**
   * Asks for a matched bill to be paid, to the supplier's verified bank
   * details as they are now. Routed by amount (Finance, then the MD).
   */
  async requestPayment(id: string, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const b = await this.lock(tx, id);
      if (b.status !== "matched")
        throw new ConflictException(
          `Only a matched bill can be paid (this one is ${b.status})`,
        );
      const [v] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, b.vendorId))
        .for("update");
      if (!v.active)
        throw new UnprocessableEntityException(
          `${v.name} is not an active supplier`,
        );
      if (v.bankStatus !== "verified" || !v.accountNumber)
        throw new UnprocessableEntityException(
          v.bankStatus === "pending"
            ? `${v.name}'s bank details are waiting for Finance to verify them`
            : `${v.name} has no verified bank details`,
        );
      const payTo = {
        bankName: v.bankName!,
        accountNumber: v.accountNumber,
        accountName: v.accountName!,
      };
      const [po] = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, b.poId));
      const total = num(b.total)!;
      const approval = await this.approvals.createIn(
        tx,
        {
          kind: "supplier_payment",
          ref: b.number,
          title: `${v.name} · invoice ${b.vendorInvoiceNo} on ${po.number}, ${naira(total)}`,
          amount: total,
          reason: `Matched to ${po.number} and the goods received: quantities and prices agree. Pay to ${payTo.bankName} ${payTo.accountNumber}, ${payTo.accountName}.`,
        },
        user.id,
        actor,
        { billId: id },
      );
      await tx
        .update(supplierBills)
        .set({ status: "payment_pending", payTo, updatedAt: new Date() })
        .where(eq(supplierBills.id, id));
      await this.audit.record(tx, actor, {
        action: "bill.payment_requested",
        entityType: "bill",
        entityId: id,
        before: { status: b.status },
        after: { status: "payment_pending", approval: approval.id },
      });
      return { ...(await this.get(id, tx)), approval };
    });
  }

  /**
   * Records the transfer once it has gone out. Refused if the supplier's
   * bank details changed after the payment was approved.
   */
  async markPaid(
    id: string,
    input: BillPaidInput,
    user: AuthUser,
    actor: Actor,
  ) {
    if (input.paidOn > lagosDate())
      throw new UnprocessableEntityException(
        "A payment can't be dated in the future",
      );
    const outcome = await this.db.transaction(async (tx) => {
      const b = await this.lock(tx, id);
      if (b.status !== "approved")
        throw new ConflictException(
          `Only an approved payment can be recorded as paid (this one is ${b.status})`,
        );
      const [v] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, b.vendorId));
      const same =
        v.bankStatus === "verified" &&
        v.accountNumber === b.payTo?.accountNumber &&
        v.bankName === b.payTo?.bankName;
      if (!same) {
        // The approval was for other bank details: it no longer stands.
        await tx
          .update(supplierBills)
          .set({ status: "matched", payTo: null, updatedAt: new Date() })
          .where(eq(supplierBills.id, id));
        await this.audit.record(tx, actor, {
          action: "bill.payment_approval_lapsed",
          entityType: "bill",
          entityId: id,
          before: { status: b.status, payTo: b.payTo },
          after: { status: "matched", reason: "supplier bank details changed" },
        });
        return { lapsed: v.name };
      }
      await tx
        .update(supplierBills)
        .set({
          status: "paid",
          paymentRef: input.paymentRef,
          paidOn: input.paidOn,
          paidBy: user.id,
          updatedAt: new Date(),
        })
        .where(eq(supplierBills.id, id));
      await this.audit.record(tx, actor, {
        action: "bill.paid",
        entityType: "bill",
        entityId: id,
        before: { status: b.status },
        after: { status: "paid", ...input },
      });
      return { lapsed: null };
    });
    if (outcome.lapsed)
      throw new ConflictException(
        `${outcome.lapsed}'s bank details changed after this payment was approved. The approval has lapsed; request payment again.`,
      );
    return this.get(id);
  }

  /** What Cocean owes each supplier, by stage. */
  async payables() {
    const rows = await this.db
      .select({
        vendorId: vendors.id,
        code: vendors.code,
        name: vendors.name,
        status: supplierBills.status,
        total: sql<string>`sum(${supplierBills.total})`,
        count: sql<number>`count(*)::int`,
      })
      .from(supplierBills)
      .innerJoin(vendors, eq(vendors.id, supplierBills.vendorId))
      .where(notInArray(supplierBills.status, ["paid", "void"]))
      .groupBy(vendors.id, vendors.code, vendors.name, supplierBills.status)
      .orderBy(asc(vendors.name));
    const byVendor = new Map<
      string,
      {
        vendorId: string;
        code: string;
        name: string;
        owed: number;
        exceptions: number;
        stages: Record<string, number>;
      }
    >();
    for (const r of rows) {
      const v = byVendor.get(r.vendorId) ?? {
        vendorId: r.vendorId,
        code: r.code,
        name: r.name,
        owed: 0,
        exceptions: 0,
        stages: {},
      };
      if (r.status === "exception") v.exceptions += r.count;
      else {
        v.stages[r.status] = Number(r.total);
        v.owed = (kobo(v.owed) + kobo(r.total)) / 100;
      }
      byVendor.set(r.vendorId, v);
    }
    const vendorsOut = [...byVendor.values()];
    return {
      vendors: vendorsOut,
      totalOwed: vendorsOut.reduce((a, v) => (kobo(a) + kobo(v.owed)) / 100, 0),
    };
  }

  private async adjustBilled(tx: Tx, changes: [string, number][]) {
    for (const [lineId, qty] of changes)
      await tx
        .update(purchaseOrderLines)
        .set({ billed: sql`${purchaseOrderLines.billed} + ${qty}` })
        .where(eq(purchaseOrderLines.id, lineId));
  }

  private async lock(tx: Tx, id: string) {
    const [b] = await tx
      .select()
      .from(supplierBills)
      .where(eq(supplierBills.id, id))
      .for("update");
    if (!b) throw new NotFoundException("Supplier invoice not found");
    return b;
  }

  /** Approved: Finance can pay. Rejected or withdrawn: back to matched. */
  private async applyDecision(tx: Tx, req: DecidedRequest, actor: Actor) {
    const id = (req.payload as { billId?: string } | null)?.billId;
    if (!id) return;
    const b = await this.lock(tx, id);
    if (b.status !== "payment_pending") return;
    const status: Status = req.status === "approved" ? "approved" : "matched";
    await tx
      .update(supplierBills)
      .set({
        status,
        ...(status === "matched" ? { payTo: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(supplierBills.id, id));
    await this.audit.record(tx, actor, {
      action:
        status === "approved"
          ? "bill.payment_approved"
          : "bill.payment_refused",
      entityType: "bill",
      entityId: id,
      before: { status: b.status },
      after: { status, approval: req.id },
    });
  }
}
