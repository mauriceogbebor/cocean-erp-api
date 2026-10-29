import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  AGEING_BUCKETS,
  type AgeingBucket,
  type CreateReceiptInput,
} from "@cocean/contracts";
import { and, asc, desc, eq, inArray, lte, ne, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import {
  customerLedger,
  customers,
  invoiceLines,
  invoices,
  liftingDrops,
  liftings,
  products,
  receipts,
  salesOrderLines,
  salesOrders,
} from "../db/schema.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { addDays, daysBetween, lagosDate } from "../common/dates.js";
import { num } from "../common/num.js";
import { nextNumber } from "../common/numbering.js";
import { DB } from "../common/tokens.js";

const kobo = (n: number | string) => Math.round(Number(n) * 100);
const naira = (k: number) => (k / 100).toFixed(2);

const receiptView = (r: typeof receipts.$inferSelect) => ({
  ...r,
  amount: num(r.amount)!,
});

@Injectable()
export class ReceivablesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ── Receipts ──────────────────────────────────────────────────────────────

  /** Records money that has reached Cocean's bank. One bank reference, once. */
  async recordReceipt(input: CreateReceiptInput, user: AuthUser, actor: Actor) {
    if (input.receivedOn > lagosDate())
      throw new UnprocessableEntityException(
        "A receipt can't be dated in the future",
      );
    return this.db.transaction(async (tx) => {
      const [c] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, input.customerId))
        .for("update");
      if (!c) throw new UnprocessableEntityException("Customer not found");
      const [dup] = await tx
        .select({ number: receipts.number })
        .from(receipts)
        .where(
          and(
            eq(receipts.bank, input.bank),
            eq(receipts.bankRef, input.bankRef),
          ),
        );
      if (dup)
        throw new ConflictException(
          `${input.bank} reference ${input.bankRef} is already recorded as ${dup.number}`,
        );
      const number = await nextNumber(tx, "RCT");
      const [r] = await tx
        .insert(receipts)
        .values({
          ...input,
          number,
          amount: naira(kobo(input.amount)),
          notes: input.notes ?? null,
          recordedBy: user.id,
        })
        .returning();
      await tx.insert(customerLedger).values({
        customerId: c.id,
        kind: "receipt",
        ref: number,
        docId: r.id,
        entryDate: input.receivedOn,
        amount: naira(-kobo(input.amount)),
        createdBy: user.id,
      });
      await this.audit.record(tx, actor, {
        action: "receipt.recorded",
        entityType: "receipt",
        entityId: r.id,
        after: r,
      });
      return receiptView(r);
    });
  }

  /**
   * Undoes a receipt recorded in error (wrong customer, bounced transfer).
   * Someone other than the person who recorded it must do it, and the
   * original stays on the ledger with a reversing entry beside it.
   */
  async reverseReceipt(
    id: string,
    reason: string,
    user: AuthUser,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.id, id))
        .for("update");
      if (!r) throw new NotFoundException("Receipt not found");
      if (r.reversedAt)
        throw new ConflictException(`${r.number} is already reversed`);
      if (r.recordedBy === user.id)
        throw new ForbiddenException(
          "Someone other than the person who recorded it must reverse it",
        );
      const [after] = await tx
        .update(receipts)
        .set({
          reversedAt: new Date(),
          reversedBy: user.id,
          reversalReason: reason,
        })
        .where(eq(receipts.id, id))
        .returning();
      await tx.insert(customerLedger).values({
        customerId: r.customerId,
        kind: "receipt_reversal",
        ref: r.number,
        docId: r.id,
        entryDate: lagosDate(),
        amount: r.amount,
        createdBy: user.id,
      });
      await this.audit.record(tx, actor, {
        action: "receipt.reversed",
        entityType: "receipt",
        entityId: id,
        before: { reversedAt: null },
        after: { reversedAt: after.reversedAt, reason },
      });
      return receiptView(after);
    });
  }

  async listReceipts(q: { customerId?: string }) {
    const rows = await this.db
      .select()
      .from(receipts)
      .where(q.customerId ? eq(receipts.customerId, q.customerId) : undefined)
      .orderBy(desc(receipts.createdAt))
      .limit(200);
    return rows.map(receiptView);
  }

  // ── Invoices ──────────────────────────────────────────────────────────────

  /**
   * Invoices a released order at the prices on the order. Prices on the
   * list are VAT-inclusive, so the invoice total equals the order total and
   * VAT is shown out of it at each product's rate. Due date: today plus the
   * customer's credit days (today, for prepaid).
   */
  async invoiceOrder(orderId: string, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const o = await this.lockOrder(tx, orderId);
      if (o.status !== "released")
        throw new ConflictException(
          `Only a released order can be invoiced (this one is ${o.status})`,
        );
      const [lifting] = await tx
        .select({ id: liftings.id })
        .from(liftings)
        .where(
          and(eq(liftings.orderId, orderId), ne(liftings.status, "cancelled")),
        )
        .limit(1);
      if (lifting)
        throw new ConflictException(
          "This order is being delivered by truck: invoice each delivery once the customer confirms it",
        );
      const lines = await tx
        .select({
          line: salesOrderLines,
          name: products.name,
          vatRate: products.vatRate,
        })
        .from(salesOrderLines)
        .innerJoin(products, eq(products.code, salesOrderLines.productCode))
        .where(eq(salesOrderLines.orderId, orderId))
        .orderBy(asc(salesOrderLines.lineNo));
      const inv = await this.issue(tx, o, user, actor, {
        dropId: null,
        lines: lines.map(({ line, name, vatRate }) => ({
          lineNo: line.lineNo,
          productCode: line.productCode,
          description: name,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          grossK: kobo(line.amount),
          vatRate: Number(vatRate),
        })),
      });
      await tx
        .update(salesOrders)
        .set({ status: "invoiced", updatedAt: new Date() })
        .where(eq(salesOrders.id, orderId));
      return this.getInvoice(inv, tx);
    });
  }

  /**
   * Invoices one confirmed delivery for the quantity the customer received,
   * at the order's price. The order is invoiced once every line is loaded in
   * full and every delivery is invoiced.
   */
  async invoiceDrop(dropId: string, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [d] = await tx
        .select({ drop: liftingDrops, lifting: liftings })
        .from(liftingDrops)
        .innerJoin(liftings, eq(liftings.id, liftingDrops.liftingId))
        .where(eq(liftingDrops.id, dropId));
      if (!d) throw new NotFoundException("Delivery not found");
      const o = await this.lockOrder(tx, d.lifting.orderId);
      const [drop] = await tx
        .select()
        .from(liftingDrops)
        .where(eq(liftingDrops.id, dropId))
        .for("update");
      if (drop.status !== "delivered" && drop.status !== "resolved")
        throw new ConflictException(
          drop.status === "exception"
            ? "This delivery has an open exception: Security closes it first"
            : `Only a confirmed delivery can be invoiced (this one is ${drop.status.replace("_", " ")})`,
        );
      const [done] = await tx
        .select({ number: invoices.number })
        .from(invoices)
        .where(eq(invoices.dropId, dropId));
      if (done)
        throw new ConflictException(
          `This delivery is already invoiced as ${done.number}`,
        );
      const [{ line, name, vatRate }] = await tx
        .select({
          line: salesOrderLines,
          name: products.name,
          vatRate: products.vatRate,
        })
        .from(salesOrderLines)
        .innerJoin(products, eq(products.code, salesOrderLines.productCode))
        .where(eq(salesOrderLines.id, drop.orderLineId));
      const quantity = Number(drop.receivedQuantity);
      const inv = await this.issue(tx, o, user, actor, {
        dropId,
        lines: [
          {
            lineNo: line.lineNo,
            productCode: line.productCode,
            description: `${name}, ${d.lifting.number} (${d.lifting.truckPlate})`,
            quantity: String(quantity),
            unit: line.unit,
            unitPrice: line.unitPrice,
            grossK: Math.round(quantity * kobo(line.unitPrice)),
            vatRate: Number(vatRate),
          },
        ],
      });
      if (await this.fullyDelivered(tx, o.id))
        await tx
          .update(salesOrders)
          .set({ status: "invoiced", updatedAt: new Date() })
          .where(eq(salesOrders.id, o.id));
      return this.getInvoice(inv, tx);
    });
  }

  /** Every line loaded in full, and every loaded delivery invoiced. */
  private async fullyDelivered(tx: Tx, orderId: string) {
    const lines = await tx
      .select()
      .from(salesOrderLines)
      .where(eq(salesOrderLines.orderId, orderId));
    const drops = await tx
      .select({ drop: liftingDrops, invoice: invoices.id })
      .from(liftingDrops)
      .leftJoin(invoices, eq(invoices.dropId, liftingDrops.id))
      .where(
        and(
          inArray(
            liftingDrops.orderLineId,
            lines.map((l) => l.id),
          ),
          ne(liftingDrops.status, "cancelled"),
        ),
      );
    const loadedFully = lines.every(
      (l) =>
        drops
          .filter((d) => d.drop.orderLineId === l.id)
          .reduce((a, d) => a + Number(d.drop.loadedQuantity ?? 0), 0) >=
        Number(l.quantity) - 1e-9,
    );
    return loadedFully && drops.every((d) => !!d.invoice);
  }

  private async lockOrder(tx: Tx, orderId: string) {
    const [o] = await tx
      .select()
      .from(salesOrders)
      .where(eq(salesOrders.id, orderId))
      .for("update");
    if (!o) throw new NotFoundException("Order not found");
    return o;
  }

  /** Writes an invoice, its lines and its ledger entry. Prices are VAT-inclusive. */
  private async issue(
    tx: Tx,
    o: typeof salesOrders.$inferSelect,
    user: AuthUser,
    actor: Actor,
    doc: {
      dropId: string | null;
      lines: {
        lineNo: number;
        productCode: string;
        description: string;
        quantity: string;
        unit: string;
        unitPrice: string;
        grossK: number;
        vatRate: number;
      }[];
    },
  ) {
    const [c] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, o.customerId))
      .for("update");
    const priced = doc.lines.map((l) => ({
      ...l,
      vatK: Math.round((l.grossK * l.vatRate) / (1 + l.vatRate)),
    }));
    const totalK = priced.reduce((a, l) => a + l.grossK, 0);
    const vatK = priced.reduce((a, l) => a + l.vatK, 0);
    const issuedOn = lagosDate();
    const dueOn = addDays(issuedOn, o.terms === "credit" ? c.creditDays : 0);
    const number = await nextNumber(tx, "INV");
    const [inv] = await tx
      .insert(invoices)
      .values({
        number,
        customerId: c.id,
        orderId: o.id,
        dropId: doc.dropId,
        issuedOn,
        dueOn,
        subtotal: naira(totalK - vatK),
        vat: naira(vatK),
        total: naira(totalK),
        createdBy: user.id,
      })
      .returning();
    await tx.insert(invoiceLines).values(
      priced.map((l) => ({
        invoiceId: inv.id,
        lineNo: l.lineNo,
        productCode: l.productCode,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: l.unitPrice,
        amount: naira(l.grossK - l.vatK),
        vatRate: String(l.vatRate),
        vat: naira(l.vatK),
      })),
    );
    await tx.insert(customerLedger).values({
      customerId: c.id,
      kind: "invoice",
      ref: number,
      docId: inv.id,
      entryDate: issuedOn,
      dueOn,
      amount: naira(totalK),
      createdBy: user.id,
    });
    await this.audit.record(tx, actor, {
      action: "invoice.issued",
      entityType: "invoice",
      entityId: inv.id,
      after: {
        number,
        order: o.number,
        drop: doc.dropId,
        total: totalK / 100,
        dueOn,
      },
    });
    return inv.id;
  }

  async getInvoice(id: string, exec: Db | Tx = this.db) {
    const [inv] = await exec
      .select({
        inv: invoices,
        order: salesOrders.number,
        customer: customers.name,
      })
      .from(invoices)
      .innerJoin(salesOrders, eq(salesOrders.id, invoices.orderId))
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(eq(invoices.id, id));
    if (!inv) throw new NotFoundException("Invoice not found");
    const lines = await exec
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, id))
      .orderBy(asc(invoiceLines.lineNo));
    return {
      ...inv.inv,
      subtotal: num(inv.inv.subtotal)!,
      vat: num(inv.inv.vat)!,
      total: num(inv.inv.total)!,
      orderNumber: inv.order,
      customerName: inv.customer,
      lines: lines.map((l) => ({
        ...l,
        quantity: num(l.quantity)!,
        unitPrice: num(l.unitPrice)!,
        amount: num(l.amount)!,
        vatRate: num(l.vatRate)!,
        vat: num(l.vat)!,
      })),
    };
  }

  async listInvoices(q: { customerId?: string }) {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(q.customerId ? eq(invoices.customerId, q.customerId) : undefined)
      .orderBy(desc(invoices.createdAt))
      .limit(200);
    return rows.map((i) => ({
      ...i,
      subtotal: num(i.subtotal)!,
      vat: num(i.vat)!,
      total: num(i.total)!,
    }));
  }

  // ── Statement and ageing ─────────────────────────────────────────────────

  /** Every entry on the customer's account with the running balance. */
  async statement(customerId: string) {
    const [c] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, customerId));
    if (!c) throw new NotFoundException("Customer not found");
    const rows = await this.ledger(this.db, [
      eq(customerLedger.customerId, customerId),
    ]);
    let run = 0;
    const entries = rows.map((e) => {
      run += kobo(e.amount);
      return { ...e, amount: num(e.amount)!, balance: run / 100 };
    });
    return {
      customer: { id: c.id, code: c.code, name: c.name, terms: c.terms },
      balance: run / 100,
      entries,
    };
  }

  /**
   * Aged receivables as at a date. Money in is applied to the oldest amount
   * due first; what is left of each invoice is aged by days past its due
   * date. Money not yet used against anything is shown as on account.
   */
  async receivables(asOf = lagosDate()) {
    const cs = await this.db
      .select()
      .from(customers)
      .orderBy(asc(customers.name));
    const rows = await this.ledger(this.db, [
      lte(customerLedger.entryDate, asOf),
    ]);
    const zero = () =>
      Object.fromEntries(AGEING_BUCKETS.map((b) => [b, 0])) as Record<
        AgeingBucket,
        number
      >;
    const totals = { ...zero(), balance: 0, overdue: 0, onAccount: 0 };

    const customersOut = cs
      .map((c) => {
        const mine = rows.filter((r) => r.customerId === c.id);
        const debits = mine
          .filter((e) => e.kind === "opening" || e.kind === "invoice")
          .map((e) => ({ due: e.dueOn ?? e.entryDate, left: kobo(e.amount) }))
          .sort((a, b) => a.due.localeCompare(b.due));
        let credit = mine
          .filter((e) => e.kind === "receipt" || e.kind === "receipt_reversal")
          .reduce((a, e) => a - kobo(e.amount), 0);
        for (const d of debits) {
          const used = Math.min(credit, d.left);
          d.left -= used;
          credit -= used;
        }
        const b = zero();
        for (const d of debits) {
          if (d.left <= 0) continue;
          const late = daysBetween(d.due, asOf);
          const bucket: AgeingBucket =
            late <= 0
              ? "current"
              : late <= 30
                ? "1-30"
                : late <= 60
                  ? "31-60"
                  : late <= 90
                    ? "61-90"
                    : "90+";
          b[bucket] += d.left;
        }
        const owed = AGEING_BUCKETS.reduce((a, k) => a + b[k], 0);
        const overdue = owed - b.current;
        const onAccount = Math.max(0, credit);
        return {
          customerId: c.id,
          code: c.code,
          name: c.name,
          terms: c.terms,
          creditLimit: num(c.creditLimit)!,
          ...Object.fromEntries(AGEING_BUCKETS.map((k) => [k, b[k] / 100])),
          balance: (owed - onAccount) / 100,
          overdue: overdue / 100,
          onAccount: onAccount / 100,
          _k: { b, owed, overdue, onAccount },
        };
      })
      .filter((r) => r._k.owed !== 0 || r._k.onAccount !== 0);

    for (const r of customersOut) {
      for (const k of AGEING_BUCKETS) totals[k] += r._k.b[k];
      totals.balance += r._k.owed - r._k.onAccount;
      totals.overdue += r._k.overdue;
      totals.onAccount += r._k.onAccount;
    }
    return {
      asOf,
      customers: customersOut.map(({ _k, ...r }) => r),
      totals: Object.fromEntries(
        Object.entries(totals).map(([k, v]) => [k, v / 100]),
      ),
    };
  }

  private ledger(exec: Db | Tx, where: SQL[]) {
    return exec
      .select()
      .from(customerLedger)
      .where(and(...where))
      .orderBy(asc(customerLedger.entryDate), asc(customerLedger.id));
  }
}
