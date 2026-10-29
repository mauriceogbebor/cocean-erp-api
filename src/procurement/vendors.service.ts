import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  CreateVendorInput,
  VendorBankInput,
  updateVendorSchema,
} from "@cocean/contracts";
import { asc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Db, Tx } from "../db/client.js";
import { vendors } from "../db/schema.js";
import {
  ApprovalHandlers,
  type DecidedRequest,
} from "../approvals/approval-handlers.js";
import { ApprovalsService } from "../approvals/approvals.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { DB } from "../common/tokens.js";

type Vendor = typeof vendors.$inferSelect;
type BankPayload = {
  vendorId: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
};

const masked = (n: string | null) => (n ? `••••••${n.slice(-4)}` : null);

@Injectable()
export class VendorsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(ApprovalHandlers) handlers: ApprovalHandlers,
  ) {
    handlers.register("vendor_bank", (tx, req, actor) =>
      this.applyBank(tx, req, actor),
    );
  }

  list() {
    return this.db.select().from(vendors).orderBy(asc(vendors.name));
  }

  async get(id: string, exec: Db | Tx = this.db) {
    const [v] = await exec.select().from(vendors).where(eq(vendors.id, id));
    if (!v) throw new NotFoundException("Supplier not found");
    return v;
  }

  async create(input: CreateVendorInput, user: AuthUser, actor: Actor) {
    const { bank, ...fields } = input;
    return this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(eq(vendors.code, fields.code));
      if (dup)
        throw new ConflictException(`Supplier ${fields.code} already exists`);
      const [v] = await tx.insert(vendors).values(fields).returning();
      await this.audit.record(tx, actor, {
        action: "vendor.created",
        entityType: "vendor",
        entityId: v.id,
        after: v,
      });
      const request = bank
        ? await this.raiseBank(tx, v, bank, user, actor)
        : null;
      return { ...(await this.get(v.id, tx)), pendingBankRequest: request };
    });
  }

  async update(
    id: string,
    patch: z.infer<typeof updateVendorSchema>,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const before = await this.get(id, tx);
      const [after] = await tx
        .update(vendors)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(vendors.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "vendor.updated",
        entityType: "vendor",
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  /**
   * New bank details for a supplier. Nothing changes until Finance approves,
   * and the supplier can't be paid while a change is pending.
   */
  async requestBank(
    id: string,
    input: VendorBankInput,
    user: AuthUser,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const [v] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, id))
        .for("update");
      if (!v) throw new NotFoundException("Supplier not found");
      return this.raiseBank(tx, v, input, user, actor);
    });
  }

  private async raiseBank(
    tx: Tx,
    v: Vendor,
    input: VendorBankInput,
    user: AuthUser,
    actor: Actor,
  ) {
    const { reason, ...bank } = input;
    const payload: BankPayload = { vendorId: v.id, ...bank };
    const now = v.accountNumber
      ? ` (now ${v.bankName} ${masked(v.accountNumber)})`
      : "";
    const request = await this.approvals.createIn(
      tx,
      {
        kind: "vendor_bank",
        ref: v.code,
        title: `${v.name}: pay to ${bank.bankName} ${bank.accountNumber}, ${bank.accountName}${now}`,
        amount: 0,
        reason,
      },
      user.id,
      actor,
      payload,
    );
    await tx
      .update(vendors)
      .set({ bankStatus: "pending", updatedAt: new Date() })
      .where(eq(vendors.id, v.id));
    return request;
  }

  private async applyBank(tx: Tx, req: DecidedRequest, actor: Actor) {
    const p = req.payload as BankPayload | null;
    if (!p?.vendorId) return;
    const [v] = await tx
      .select()
      .from(vendors)
      .where(eq(vendors.id, p.vendorId))
      .for("update");
    if (!v) return;
    if (req.status === "approved") {
      await tx
        .update(vendors)
        .set({
          bankName: p.bankName,
          accountNumber: p.accountNumber,
          accountName: p.accountName,
          bankStatus: "verified",
          bankVerifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(vendors.id, v.id));
      await this.audit.record(tx, actor, {
        action: "vendor.bank_changed",
        entityType: "vendor",
        entityId: v.id,
        before: {
          bankName: v.bankName,
          accountNumber: masked(v.accountNumber),
        },
        after: {
          bankName: p.bankName,
          accountNumber: masked(p.accountNumber),
          approval: req.id,
        },
      });
    } else
      await tx
        .update(vendors)
        .set({
          bankStatus: v.accountNumber ? "verified" : "none",
          updatedAt: new Date(),
        })
        .where(eq(vendors.id, v.id));
  }
}
