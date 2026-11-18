import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { CreateCylinderInput, FillInput } from "@qorrix-erp/contracts";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cylinders, fills, sites } from "../db/schema.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { businessDate } from "../common/dates.js";
import { num } from "../common/num.js";
import { DB } from "../common/tokens.js";
import { PricingService } from "../pricing/pricing.service.js";
import { StockService } from "../stock/stock.service.js";
import { assertSiteAccess } from "./site-access.js";

type Cylinder = typeof cylinders.$inferSelect;
const cylView = (c: Cylinder) => ({ ...c, sizeKg: num(c.sizeKg)! });

@Injectable()
export class LpgService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StockService) private readonly stock: StockService,
    @Inject(PricingService) private readonly pricing: PricingService,
  ) {}

  async listCylinders() {
    const today = businessDate();
    return (
      await this.db.select().from(cylinders).orderBy(asc(cylinders.serial))
    ).map((c) => ({
      ...cylView(c),
      canFill: c.status === "active" && c.testDueOn >= today,
    }));
  }

  async createCylinder(input: CreateCylinderInput, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: cylinders.id })
        .from(cylinders)
        .where(eq(cylinders.serial, input.serial));
      if (dup)
        throw new ConflictException(
          `Cylinder ${input.serial} is already registered`,
        );
      const [c] = await tx
        .insert(cylinders)
        .values({ ...input, sizeKg: String(input.sizeKg) })
        .returning();
      await this.audit.record(tx, actor, {
        action: "cylinder.registered",
        entityType: "cylinder",
        entityId: c.id,
        after: c,
      });
      return cylView(c);
    });
  }

  /** Taken out of use for good: damage, corrosion, a failed test. */
  async condemn(id: string, reason: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx
        .select()
        .from(cylinders)
        .where(eq(cylinders.id, id))
        .for("update");
      if (!c) throw new NotFoundException("Cylinder not found");
      if (c.status === "condemned")
        throw new ConflictException(`${c.serial} is already condemned`);
      const [after] = await tx
        .update(cylinders)
        .set({ status: "condemned", condemnedReason: reason })
        .where(eq(cylinders.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "cylinder.condemned",
        entityType: "cylinder",
        entityId: id,
        after: { reason },
      });
      return cylView(after);
    });
  }

  /**
   * Fills a cylinder from a plant tank. A cylinder that isn't registered,
   * is condemned, or is past its pressure test is refused; nobody can
   * override that. Stock leaves the tank now; the takings belong to the
   * next shift close.
   */
  async fill(input: FillInput, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [site] = await tx
        .select()
        .from(sites)
        .where(eq(sites.id, input.siteId));
      if (!site || site.kind !== "lpg_plant")
        throw new UnprocessableEntityException(
          "Cylinders are filled at an LPG plant",
        );
      await assertSiteAccess(tx, user, site.id);
      const tank = await this.stock.lockTank(tx, input.tankId);
      if (tank.siteId !== site.id || tank.productCode !== "LPG")
        throw new UnprocessableEntityException(
          `${tank.code} isn't an LPG tank at ${site.name}`,
        );
      const [c] = await tx
        .select()
        .from(cylinders)
        .where(eq(cylinders.serial, input.serial));
      if (!c)
        throw new UnprocessableEntityException(
          `Cylinder ${input.serial} isn't registered. Register it before filling.`,
        );
      if (c.status === "condemned")
        throw new UnprocessableEntityException(
          `${c.serial} is condemned (${c.condemnedReason}) and can't be filled`,
        );
      if (c.testDueOn < businessDate())
        throw new UnprocessableEntityException(
          `${c.serial}'s pressure test was due on ${c.testDueOn}. It can't be filled until it is retested.`,
        );
      if (input.kg > Number(c.sizeKg))
        throw new UnprocessableEntityException(
          `${c.serial} is a ${num(c.sizeKg)} kg cylinder; ${input.kg} kg won't fit`,
        );
      const pl = await this.pricing.inForce(tx, businessDate());
      const price = pl?.lines.find((l) => l.productCode === "LPG")?.price;
      if (price === undefined)
        throw new UnprocessableEntityException(
          "No approved LPG price is in force",
        );
      await this.stock.post(tx, tank, {
        tankId: tank.id,
        kind: "sale",
        quantity: -input.kg,
        ref: `FILL ${c.serial}`,
        userId: user.id,
      });
      const amount = (
        Math.round(input.kg * Math.round(price * 100)) / 100
      ).toFixed(2);
      const [f] = await tx
        .insert(fills)
        .values({
          siteId: site.id,
          tankId: tank.id,
          cylinderId: c.id,
          kg: String(input.kg),
          price: String(price),
          amount,
          filledBy: user.id,
        })
        .returning();
      await this.audit.record(tx, actor, {
        action: "cylinder.filled",
        entityType: "cylinder",
        entityId: c.id,
        after: f,
      });
      return {
        ...f,
        kg: num(f.kg)!,
        price: num(f.price)!,
        amount: num(f.amount)!,
        serial: c.serial,
      };
    });
  }

  /** Fills not yet in a closed shift, newest first. */
  async openFills(siteId: string) {
    const rows = await this.db
      .select({
        fill: fills,
        serial: cylinders.serial,
        sizeKg: cylinders.sizeKg,
      })
      .from(fills)
      .innerJoin(cylinders, eq(cylinders.id, fills.cylinderId))
      .where(and(eq(fills.siteId, siteId), isNull(fills.shiftId)))
      .orderBy(desc(fills.createdAt));
    return rows.map((r) => ({
      ...r.fill,
      kg: num(r.fill.kg)!,
      price: num(r.fill.price)!,
      amount: num(r.fill.amount)!,
      serial: r.serial,
      sizeKg: num(r.sizeKg)!,
    }));
  }
}
