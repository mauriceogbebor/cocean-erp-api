import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  CreateSiteInput,
  createProductSchema,
  updateProductSchema,
  updateSiteSchema,
} from "@cocean/contracts";
import { asc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import { products, sites } from "../db/schema.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../common/auth-context.js";
import { num } from "../common/num.js";
import { DB } from "../common/tokens.js";

/** Postgres unique violation, raw or wrapped by the query builder. */
const isUnique = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: unknown } | null;
  return (
    !!err && (err.code === "23505" || (!!err.cause && isUnique(err.cause)))
  );
};

const product = (p: typeof products.$inferSelect) => ({
  ...p,
  density: num(p.density),
});

@Injectable()
export class MasterDataService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  listSites() {
    return this.db.select().from(sites).orderBy(asc(sites.code));
  }

  async createSite(input: CreateSiteInput, actor: Actor) {
    try {
      return await this.db.transaction(async (tx) => {
        const [s] = await tx.insert(sites).values(input).returning();
        await this.audit.record(tx, actor, {
          action: "site.created",
          entityType: "site",
          entityId: s.id,
          after: s,
        });
        return s;
      });
    } catch (e) {
      if (isUnique(e))
        throw new ConflictException(`Site ${input.code} already exists`);
      throw e;
    }
  }

  async updateSite(
    id: string,
    patch: z.infer<typeof updateSiteSchema>,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(sites).where(eq(sites.id, id));
      if (!before) throw new NotFoundException("Site not found");
      const [after] = await tx
        .update(sites)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(sites.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "site.updated",
        entityType: "site",
        entityId: id,
        before,
        after,
      });
      return after;
    });
  }

  async listProducts() {
    return (
      await this.db.select().from(products).orderBy(asc(products.code))
    ).map(product);
  }

  async createProduct(
    input: z.infer<typeof createProductSchema>,
    actor: Actor,
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        const [p] = await tx
          .insert(products)
          .values({
            ...input,
            density: input.density === null ? null : String(input.density),
          })
          .returning();
        await this.audit.record(tx, actor, {
          action: "product.created",
          entityType: "product",
          entityId: p.code,
          after: p,
        });
        return product(p);
      });
    } catch (e) {
      if (isUnique(e))
        throw new ConflictException(`Product ${input.code} already exists`);
      throw e;
    }
  }

  async updateProduct(
    code: string,
    patch: z.infer<typeof updateProductSchema>,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(products)
        .where(eq(products.code, code));
      if (!before) throw new NotFoundException("Product not found");
      const { density, ...rest } = patch;
      const [after] = await tx
        .update(products)
        .set({
          ...rest,
          ...(density !== undefined
            ? { density: density === null ? null : String(density) }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(products.code, code))
        .returning();
      await this.audit.record(tx, actor, {
        action: "product.updated",
        entityType: "product",
        entityId: code,
        before,
        after,
      });
      return product(after);
    });
  }
}
