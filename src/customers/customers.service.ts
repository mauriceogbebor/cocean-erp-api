import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  CreateCustomerInput,
  CreditTermsInput,
  CustomerSiteInput,
  updateCustomerSchema,
} from "@cocean/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Db, Tx } from "../db/client.js";
import {
  customerLedger,
  customerSites,
  customers,
  salesOrders,
} from "../db/schema.js";
import { ApprovalHandlers } from "../approvals/approval-handlers.js";
import { ApprovalsService } from "../approvals/approvals.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { lagosDate } from "../common/dates.js";
import { num } from "../common/num.js";
import { DB } from "../common/tokens.js";

type Customer = typeof customers.$inferSelect;
type TermsPayload = {
  customerId: string;
  terms: "prepaid" | "credit";
  creditLimit: number;
  creditDays: number;
};

const view = (c: Customer) => ({
  ...c,
  creditLimit: num(c.creditLimit)!,
  openingBalance: num(c.openingBalance)!,
});

const round2 = (n: number) => Math.round(n * 100) / 100;
const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;

@Injectable()
export class CustomersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(ApprovalHandlers) handlers: ApprovalHandlers,
  ) {
    handlers.register("credit_limit", (tx, req, actor) =>
      this.applyTerms(tx, req, actor),
    );
  }

  async list() {
    return (
      await this.db.select().from(customers).orderBy(asc(customers.name))
    ).map(view);
  }

  async get(id: string) {
    const [c] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, id));
    if (!c) throw new NotFoundException("Customer not found");
    const sites = await this.db
      .select()
      .from(customerSites)
      .where(eq(customerSites.customerId, id))
      .orderBy(asc(customerSites.name));
    return { ...view(c), sites, credit: await this.creditPosition(this.db, c) };
  }

  /**
   * What the customer owes and has committed: the ledger balance (invoices
   * and opening balance less receipts) plus orders released but not yet
   * invoiced. `available` is what is left under the limit; for a prepaid
   * customer the limit is zero, so `available` is money paid and not yet used.
   */
  async creditPosition(exec: Db | Tx, c: Customer) {
    const [{ balance }] = await exec
      .select({
        balance: sql<string>`coalesce(sum(${customerLedger.amount}), 0)`,
      })
      .from(customerLedger)
      .where(eq(customerLedger.customerId, c.id));
    // Released orders count until invoiced; part-delivered ones count only
    // what isn't invoiced yet, since those invoices are on the ledger.
    const [{ open }] = await exec
      .select({
        open: sql<string>`coalesce(sum(${salesOrders.total} - coalesce((select sum(i.total) from invoices i where i.order_id = "sales_orders"."id"), 0)), 0)`,
      })
      .from(salesOrders)
      .where(
        and(
          eq(salesOrders.customerId, c.id),
          eq(salesOrders.status, "released"),
        ),
      );
    const limit = c.terms === "credit" ? num(c.creditLimit)! : 0;
    const bal = Number(balance);
    const openOrders = Number(open);
    const exposure = round2(bal + openOrders);
    return {
      limit,
      balance: bal,
      openOrders,
      exposure,
      available: round2(limit - exposure),
    };
  }

  async create(input: CreateCustomerInput, user: AuthUser, actor: Actor) {
    const { requestedTerms, openingBalance, ...fields } = input;
    return this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.code, fields.code));
      if (dup)
        throw new ConflictException(`Customer ${fields.code} already exists`);
      // Every customer starts prepaid with no credit; credit needs approval.
      const [c] = await tx
        .insert(customers)
        .values({ ...fields, openingBalance: String(openingBalance) })
        .returning();
      if (openingBalance !== 0)
        await tx.insert(customerLedger).values({
          customerId: c.id,
          kind: "opening",
          ref: "OPENING",
          entryDate: lagosDate(),
          dueOn: lagosDate(),
          amount: String(openingBalance),
          createdBy: user.id,
        });
      await this.audit.record(tx, actor, {
        action: "customer.created",
        entityType: "customer",
        entityId: c.id,
        after: c,
      });
      const request = requestedTerms
        ? await this.raiseTerms(tx, c, requestedTerms, user, actor)
        : null;
      return { ...view(c), pendingTermsRequest: request };
    });
  }

  async update(
    id: string,
    patch: z.infer<typeof updateCustomerSchema>,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, id));
      if (!before) throw new NotFoundException("Customer not found");
      const [after] = await tx
        .update(customers)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(customers.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "customer.updated",
        entityType: "customer",
        entityId: id,
        before,
        after,
      });
      return view(after);
    });
  }

  /** Asks for new credit terms. Nothing changes until someone else approves. */
  async requestTerms(
    id: string,
    input: CreditTermsInput,
    user: AuthUser,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(customers).where(eq(customers.id, id));
      if (!c) throw new NotFoundException("Customer not found");
      return this.raiseTerms(tx, c, input, user, actor);
    });
  }

  private raiseTerms(
    tx: Tx,
    c: Customer,
    input: CreditTermsInput,
    user: AuthUser,
    actor: Actor,
  ) {
    const payload: TermsPayload = {
      customerId: c.id,
      terms: input.terms,
      creditLimit: input.terms === "credit" ? input.creditLimit : 0,
      creditDays: input.terms === "credit" ? input.creditDays : 0,
    };
    const summary =
      payload.terms === "credit"
        ? `credit, ${naira(payload.creditLimit)} limit, ${payload.creditDays} days`
        : "prepaid";
    return this.approvals.createIn(
      tx,
      {
        kind: "credit_limit",
        ref: c.code,
        title: `${c.name}: ${summary} (now ${c.terms === "credit" ? `${naira(num(c.creditLimit)!)} limit` : "prepaid"})`,
        amount: payload.creditLimit,
        reason: input.reason,
      },
      user.id,
      actor,
      payload,
    );
  }

  private async applyTerms(
    tx: Tx,
    req: { status: string; payload: unknown; id: string },
    actor: Actor,
  ) {
    if (req.status !== "approved") return;
    const p = req.payload as TermsPayload | null;
    if (!p?.customerId) return;
    const [before] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, p.customerId));
    if (!before) return;
    const [after] = await tx
      .update(customers)
      .set({
        terms: p.terms,
        creditLimit: String(p.creditLimit),
        creditDays: p.creditDays,
        updatedAt: new Date(),
      })
      .where(eq(customers.id, p.customerId))
      .returning();
    await this.audit.record(tx, actor, {
      action: "customer.terms_changed",
      entityType: "customer",
      entityId: p.customerId,
      before: {
        terms: before.terms,
        creditLimit: before.creditLimit,
        creditDays: before.creditDays,
      },
      after: {
        terms: after.terms,
        creditLimit: after.creditLimit,
        creditDays: after.creditDays,
        approval: req.id,
      },
    });
  }

  async addSite(id: string, input: CustomerSiteInput, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, id));
      if (!c) throw new NotFoundException("Customer not found");
      const [s] = await tx
        .insert(customerSites)
        .values({ ...input, customerId: id })
        .returning();
      await this.audit.record(tx, actor, {
        action: "customer.site_added",
        entityType: "customer",
        entityId: id,
        after: s,
      });
      return s;
    });
  }
}
