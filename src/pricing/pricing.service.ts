import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { PriceListInput } from "@cocean/contracts";
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { priceListLines, priceLists, products } from "../db/schema.js";
import { ApprovalHandlers } from "../approvals/approval-handlers.js";
import { ApprovalsService } from "../approvals/approvals.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { lagosDate } from "../common/dates.js";
import { num } from "../common/num.js";
import { DB } from "../common/tokens.js";

type Lines = PriceListInput["lines"];

@Injectable()
export class PricingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(ApprovalHandlers) handlers: ApprovalHandlers,
  ) {
    handlers.register("price_list", (tx, req, actor) =>
      this.applyDecision(tx, req, actor),
    );
  }

  async list() {
    return this.db
      .select()
      .from(priceLists)
      .orderBy(desc(priceLists.validFrom));
  }

  async get(id: string, exec: Db | Tx = this.db) {
    const [pl] = await exec
      .select()
      .from(priceLists)
      .where(eq(priceLists.id, id));
    if (!pl) throw new NotFoundException("Price list not found");
    const lines = await exec
      .select()
      .from(priceListLines)
      .where(eq(priceListLines.priceListId, id))
      .orderBy(asc(priceListLines.productCode));
    return {
      ...pl,
      lines: lines.map((l) => ({
        productCode: l.productCode,
        price: num(l.price)!,
      })),
    };
  }

  /**
   * The price list in force on a date: the approved list with the latest
   * start date on or before it.
   */
  async inForce(exec: Db | Tx = this.db, onDate = lagosDate()) {
    const [pl] = await exec
      .select()
      .from(priceLists)
      .where(
        and(
          eq(priceLists.status, "approved"),
          lte(priceLists.validFrom, onDate),
        ),
      )
      .orderBy(desc(priceLists.validFrom), desc(priceLists.approvedAt))
      .limit(1);
    return pl ? this.get(pl.id, exec) : null;
  }

  private async checkProducts(tx: Tx, lines: Lines) {
    const codes = lines.map((l) => l.productCode);
    const found = await tx
      .select({ code: products.code })
      .from(products)
      .where(and(inArray(products.code, codes), eq(products.active, true)));
    const missing = codes.filter((c) => !found.some((f) => f.code === c));
    if (missing.length)
      throw new UnprocessableEntityException(
        `Unknown or inactive product: ${missing.join(", ")}`,
      );
  }

  async create(input: PriceListInput, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: priceLists.id })
        .from(priceLists)
        .where(eq(priceLists.code, input.code));
      if (dup)
        throw new ConflictException(`Price list ${input.code} already exists`);
      await this.checkProducts(tx, input.lines);
      const [pl] = await tx
        .insert(priceLists)
        .values({
          code: input.code,
          validFrom: input.validFrom,
          createdBy: user.id,
        })
        .returning();
      await tx
        .insert(priceListLines)
        .values(
          input.lines.map((l) => ({
            priceListId: pl.id,
            productCode: l.productCode,
            price: String(l.price),
          })),
        );
      await this.audit.record(tx, actor, {
        action: "price_list.created",
        entityType: "price_list",
        entityId: pl.id,
        after: input,
      });
      return this.get(pl.id, tx);
    });
  }

  /** Replaces the prices on a draft. Submitted or approved lists can't change. */
  async replaceLines(id: string, lines: Lines, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const before = await this.get(id, tx);
      if (before.status !== "draft")
        throw new ConflictException("Only a draft price list can be changed");
      await this.checkProducts(tx, lines);
      await tx.delete(priceListLines).where(eq(priceListLines.priceListId, id));
      await tx
        .insert(priceListLines)
        .values(
          lines.map((l) => ({
            priceListId: id,
            productCode: l.productCode,
            price: String(l.price),
          })),
        );
      await tx
        .update(priceLists)
        .set({ updatedAt: new Date() })
        .where(eq(priceLists.id, id));
      await this.audit.record(tx, actor, {
        action: "price_list.lines_changed",
        entityType: "price_list",
        entityId: id,
        before: before.lines,
        after: lines,
      });
      return this.get(id, tx);
    });
  }

  async submit(id: string, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const pl = await this.get(id, tx);
      if (pl.status !== "draft")
        throw new ConflictException(`Already ${pl.status}`);
      await tx
        .update(priceLists)
        .set({ status: "pending", updatedAt: new Date() })
        .where(eq(priceLists.id, id));
      const prices = pl.lines
        .map((l) => `${l.productCode} ₦${l.price.toLocaleString("en-NG")}`)
        .join(", ");
      const request = await this.approvals.createIn(
        tx,
        {
          kind: "price_list",
          ref: pl.code,
          title: `Price list ${pl.code} from ${pl.validFrom}`,
          amount: 0,
          reason: `Prices per unit from ${pl.validFrom}: ${prices}`,
        },
        user.id,
        actor,
        { priceListId: id },
      );
      return { ...(await this.get(id, tx)), approval: request };
    });
  }

  private async applyDecision(
    tx: Tx,
    req: { status: string; payload: unknown },
    actor: Actor,
  ) {
    const id = (req.payload as { priceListId?: string } | null)?.priceListId;
    if (!id) return;
    const approved = req.status === "approved";
    await tx
      .update(priceLists)
      .set({
        status: approved ? "approved" : "draft",
        approvedAt: approved ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(and(eq(priceLists.id, id), eq(priceLists.status, "pending")));
    await this.audit.record(tx, actor, {
      action: approved ? "price_list.approved" : "price_list.returned_to_draft",
      entityType: "price_list",
      entityId: id,
    });
  }
}
