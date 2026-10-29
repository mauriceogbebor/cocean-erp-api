import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  ApprovalKind,
  CreateApprovalInput,
  DecideApprovalInput,
} from "@cocean/contracts";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { approvalPolicies, approvalRequests } from "../db/schema.js";
import { AuditService } from "../audit/audit.service.js";
import { ApprovalHandlers } from "./approval-handlers.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { num } from "../common/num.js";
import { DB } from "../common/tokens.js";

type Row = typeof approvalRequests.$inferSelect;
const view = (r: Row) => ({ ...r, amount: num(r.amount)! });

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalHandlers) private readonly handlers: ApprovalHandlers,
  ) {}

  /** The active band for this kind where min <= amount < max. */
  async route(kind: ApprovalKind, amount: number) {
    const a = String(amount);
    const [p] = await this.db
      .select()
      .from(approvalPolicies)
      .where(
        and(
          eq(approvalPolicies.kind, kind),
          eq(approvalPolicies.active, true),
          lte(approvalPolicies.minAmount, a),
          or(
            isNull(approvalPolicies.maxAmount),
            gt(approvalPolicies.maxAmount, a),
          ),
        ),
      )
      .orderBy(desc(approvalPolicies.minAmount))
      .limit(1);
    if (!p)
      throw new UnprocessableEntityException(
        `No approval rule covers a ${kind.replace(/_/g, " ")} of this amount. Ask an administrator to set one.`,
      );
    return p;
  }

  async create(input: CreateApprovalInput, user: AuthUser, actor: Actor) {
    if (this.handlers.has(input.kind))
      throw new UnprocessableEntityException(
        `A ${input.kind.replace("_", " ")} request is raised from the record it is about, not directly`,
      );
    return this.db.transaction((tx) =>
      this.createIn(tx, input, user.id, actor),
    );
  }

  /**
   * Raises a request inside the caller's transaction, so the record that
   * needs approval and its request are saved together. `payload` is what
   * approving applies; the kind's handler reads it.
   */
  async createIn(
    tx: Tx,
    input: CreateApprovalInput,
    requestedBy: string,
    actor: Actor,
    payload?: unknown,
  ) {
    const policy = await this.route(input.kind, input.amount);
    const [open] = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.kind, input.kind),
          eq(approvalRequests.ref, input.ref),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (open)
      throw new ConflictException(
        `${input.ref} already has a pending request for this`,
      );
    const [r] = await tx
      .insert(approvalRequests)
      .values({
        ...input,
        amount: String(input.amount),
        requestedBy,
        approverRole: policy.approverRole,
        policyId: policy.id,
        payload: payload ?? null,
      })
      .returning();
    await this.audit.record(tx, actor, {
      action: "approval.requested",
      entityType: "approval",
      entityId: r.id,
      after: r,
    });
    return view(r);
  }

  /**
   * Decides a pending request. The row is locked for the decision, so two
   * people can't decide the same request at once.
   */
  async decide(
    id: string,
    input: DecideApprovalInput,
    user: AuthUser,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, id))
        .for("update");
      if (!r) throw new NotFoundException("Approval request not found");
      if (r.status !== "pending")
        throw new ConflictException(`Already ${r.status}`);
      if (r.requestedBy === user.id)
        throw new ForbiddenException(
          "You raised this request. Someone else must decide it.",
        );
      if (!user.roles.includes(r.approverRole as AuthUser["roles"][number]))
        throw new ForbiddenException(
          "This request is outside your approval authority",
        );
      const [after] = await tx
        .update(approvalRequests)
        .set({
          status: input.decision,
          decidedBy: user.id,
          decidedAt: new Date(),
          decisionNote: input.note || null,
        })
        .where(eq(approvalRequests.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: `approval.${input.decision}`,
        entityType: "approval",
        entityId: id,
        before: { status: r.status },
        after: { status: after.status, note: after.decisionNote },
      });
      await this.handlers.run(tx, after, actor);
      return view(after);
    });
  }

  /** The person who raised a pending request can take it back. */
  async withdraw(id: string, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, id))
        .for("update");
      if (!r) throw new NotFoundException("Approval request not found");
      if (r.requestedBy !== user.id)
        throw new ForbiddenException(
          "Only the person who raised it can withdraw it",
        );
      if (r.status !== "pending")
        throw new ConflictException(`Already ${r.status}`);
      const [after] = await tx
        .update(approvalRequests)
        .set({ status: "withdrawn", decidedAt: new Date() })
        .where(eq(approvalRequests.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "approval.withdrawn",
        entityType: "approval",
        entityId: id,
      });
      await this.handlers.run(tx, after, actor);
      return view(after);
    });
  }

  /** "mine": waiting for me to decide. "raised": what I asked for. */
  async list(
    user: AuthUser,
    scope: "mine" | "raised" | "all",
    status?: Row["status"],
  ) {
    const where: SQL[] = [];
    if (status) where.push(eq(approvalRequests.status, status));
    if (scope === "mine") {
      if (!user.roles.length) return [];
      where.push(inArray(approvalRequests.approverRole, user.roles));
      where.push(ne(approvalRequests.requestedBy, user.id));
    }
    if (scope === "raised")
      where.push(eq(approvalRequests.requestedBy, user.id));
    const rows = await this.db
      .select()
      .from(approvalRequests)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(approvalRequests.createdAt))
      .limit(200);
    return rows.map(view);
  }

  async get(id: string) {
    const [r] = await this.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id));
    if (!r) throw new NotFoundException("Approval request not found");
    return view(r);
  }

  async policies() {
    const rows = await this.db
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.active, true))
      .orderBy(
        asc(approvalPolicies.kind),
        asc(sql`${approvalPolicies.minAmount}::numeric`),
      );
    return rows.map((p) => ({
      ...p,
      minAmount: num(p.minAmount)!,
      maxAmount: num(p.maxAmount),
    }));
  }
}
