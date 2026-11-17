import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type {
  CreateEmployeeInput,
  EmployeeStatus,
  ExitEmployeeInput,
  GradeInput,
  PayChangeInput,
  UpdateEmployeeInput,
} from "@qorrix-erp/contracts";
import { and, asc, eq, ne, type SQL } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../common/auth-context.js";
import { businessDate } from "../common/dates.js";
import { num } from "../common/num.js";
import { nextNumber } from "../common/numbering.js";
import { money, org } from "../common/org.js";
import { DB } from "../common/tokens.js";
import type { Db, Tx } from "../db/client.js";
import { employees, grades, sites } from "../db/schema.js";

type Employee = typeof employees.$inferSelect;
type Grade = typeof grades.$inferSelect;

const PAY = ["basic", "housing", "transport", "other"] as const;
const monthly = (e: Pick<Employee, (typeof PAY)[number]>) =>
  PAY.reduce((s, k) => s + Number(e[k]), 0);

const gradeView = (g: Grade) => ({
  ...g,
  minMonthly: Number(g.minMonthly),
  maxMonthly: Number(g.maxMonthly),
});

/** What stops someone being paid, in words HR can act on. */
export function employeeIssues(e: Employee, g: Grade | undefined) {
  const issues: string[] = [];
  if (!e.bankName || !e.accountNumber) issues.push("No bank account");
  if (!e.pfa || !e.rsaPin) issues.push("No pension fund or RSA PIN");
  const gross = monthly(e);
  if (g && (gross < Number(g.minMonthly) || gross > Number(g.maxMonthly)))
    issues.push(
      `Monthly pay ${money(gross)} is outside ${g.code}'s band (${money(Number(g.minMonthly))} to ${money(Number(g.maxMonthly))})`,
    );
  return issues;
}

/**
 * Staff records: who works here, on what grade and pay, and with which bank,
 * pension fund and tax office. Pay sits inside the grade's band, and a joiner
 * is paid only once HR has activated them with everything payroll needs.
 */
@Injectable()
export class PeopleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ── Grades ────────────────────────────────────────────────────────────────

  async listGrades() {
    const rows = await this.db.select().from(grades).orderBy(asc(grades.code));
    return rows.map(gradeView);
  }

  async createGrade(input: GradeInput, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: grades.id })
        .from(grades)
        .where(eq(grades.code, input.code));
      if (dup)
        throw new ConflictException(`Grade ${input.code} already exists`);
      const [g] = await tx
        .insert(grades)
        .values({
          ...input,
          minMonthly: String(input.minMonthly),
          maxMonthly: String(input.maxMonthly),
        })
        .returning();
      await this.audit.record(tx, actor, {
        action: "grade.created",
        entityType: "grade",
        entityId: g.id,
        after: g,
      });
      return gradeView(g);
    });
  }

  async updateGrade(id: string, input: GradeInput, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(grades)
        .where(eq(grades.id, id))
        .for("update");
      if (!before) throw new NotFoundException("Grade not found");
      // Nobody already on the grade may end up outside its new band.
      const on = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.gradeId, id), ne(employees.status, "exited")));
      const outside = on.filter(
        (e) => monthly(e) < input.minMonthly || monthly(e) > input.maxMonthly,
      );
      if (outside.length)
        throw new UnprocessableEntityException(
          `${outside.map((e) => e.name).join(", ")} would be outside the new band. Change their pay or grade first.`,
        );
      const [g] = await tx
        .update(grades)
        .set({
          ...input,
          minMonthly: String(input.minMonthly),
          maxMonthly: String(input.maxMonthly),
          updatedAt: new Date(),
        })
        .where(eq(grades.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "grade.updated",
        entityType: "grade",
        entityId: id,
        before,
        after: g,
      });
      return gradeView(g);
    });
  }

  // ── People ────────────────────────────────────────────────────────────────

  async list(status?: EmployeeStatus) {
    const where: SQL[] = [];
    if (status) where.push(eq(employees.status, status));
    const rows = await this.db
      .select({ e: employees, g: grades, siteName: sites.name })
      .from(employees)
      .innerJoin(grades, eq(grades.id, employees.gradeId))
      .leftJoin(sites, eq(sites.id, employees.siteId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(employees.name));
    return rows.map((r) => this.view(r.e, r.g, r.siteName));
  }

  async get(id: string) {
    const [r] = await this.db
      .select({ e: employees, g: grades, siteName: sites.name })
      .from(employees)
      .innerJoin(grades, eq(grades.id, employees.gradeId))
      .leftJoin(sites, eq(sites.id, employees.siteId))
      .where(eq(employees.id, id));
    if (!r) throw new NotFoundException("Person not found");
    return this.view(r.e, r.g, r.siteName);
  }

  private view(e: Employee, g: Grade, siteName: string | null) {
    return {
      ...e,
      basic: Number(e.basic),
      housing: Number(e.housing),
      transport: Number(e.transport),
      other: Number(e.other),
      annualRent: num(e.annualRent) ?? 0,
      monthlyGross: monthly(e),
      grade: { id: g.id, code: g.code, name: g.name },
      siteName,
      issues: e.status === "exited" ? [] : employeeIssues(e, g),
    };
  }

  private async grade(exec: Db | Tx, id: string) {
    const [g] = await exec.select().from(grades).where(eq(grades.id, id));
    if (!g) throw new UnprocessableEntityException("Choose a grade");
    return g;
  }

  private assertInBand(gross: number, g: Grade) {
    if (gross < Number(g.minMonthly) || gross > Number(g.maxMonthly))
      throw new UnprocessableEntityException(
        `Monthly pay of ${money(gross)} is outside ${g.code}'s band of ${money(Number(g.minMonthly))} to ${money(Number(g.maxMonthly))}`,
      );
  }

  private assertTaxState(state: string | undefined) {
    if (state && !org().regions.includes(state))
      throw new UnprocessableEntityException({
        message: "Validation failed",
        issues: [
          {
            path: "taxState",
            message: "Choose one of the organization's states or regions",
          },
        ],
      });
  }

  async create(
    input: CreateEmployeeInput & { taxState: string },
    actor: Actor,
  ) {
    this.assertTaxState(input.taxState);
    return this.db.transaction(async (tx) => {
      const g = await this.grade(tx, input.gradeId);
      const pay = {
        basic: input.pay.basic,
        housing: input.pay.housing ?? 0,
        transport: input.pay.transport ?? 0,
        other: input.pay.other ?? 0,
      };
      this.assertInBand(pay.basic + pay.housing + pay.transport + pay.other, g);
      const { pay: _, annualRent, ...rest } = input;
      const [e] = await tx
        .insert(employees)
        .values({
          ...rest,
          number: await nextNumber(tx, "EMP"),
          employmentType: input.employmentType ?? "permanent",
          basic: String(pay.basic),
          housing: String(pay.housing),
          transport: String(pay.transport),
          other: String(pay.other),
          annualRent: String(annualRent ?? 0),
          createdBy: actor.userId as string, // always set for a signed-in request
        })
        .returning();
      await this.audit.record(tx, actor, {
        action: "employee.created",
        entityType: "employee",
        entityId: e.id,
        after: e,
      });
      return e;
    });
  }

  async update(id: string, input: UpdateEmployeeInput, actor: Actor) {
    this.assertTaxState(input.taxState);
    return this.db.transaction(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.status === "exited")
        throw new ConflictException(`${before.name} has left`);
      if (input.gradeId)
        this.assertInBand(monthly(before), await this.grade(tx, input.gradeId));
      const { annualRent, ...rest } = input;
      const [e] = await tx
        .update(employees)
        .set({
          ...rest,
          ...(annualRent !== undefined
            ? { annualRent: String(annualRent) }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(employees.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "employee.updated",
        entityType: "employee",
        entityId: id,
        before,
        after: e,
      });
      return e;
    });
  }

  /** Pay changes are kept apart from other edits: they carry a reason. */
  async changePay(id: string, input: PayChangeInput, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.status === "exited")
        throw new ConflictException(`${before.name} has left`);
      const pay = {
        basic: input.basic,
        housing: input.housing ?? 0,
        transport: input.transport ?? 0,
        other: input.other ?? 0,
      };
      this.assertInBand(
        pay.basic + pay.housing + pay.transport + pay.other,
        await this.grade(tx, before.gradeId),
      );
      const [e] = await tx
        .update(employees)
        .set({
          basic: String(pay.basic),
          housing: String(pay.housing),
          transport: String(pay.transport),
          other: String(pay.other),
          updatedAt: new Date(),
        })
        .where(eq(employees.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "employee.pay_changed",
        entityType: "employee",
        entityId: id,
        before: Object.fromEntries(PAY.map((k) => [k, before[k]])),
        after: {
          ...Object.fromEntries(PAY.map((k) => [k, e[k]])),
          reason: input.reason,
        },
      });
      return e;
    });
  }

  /**
   * A joiner goes on payroll only with a bank account nobody else is paid
   * into, a pension fund and RSA PIN, and pay inside their grade's band.
   */
  async activate(id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const e = await this.lock(tx, id);
      if (e.status !== "onboarding")
        throw new ConflictException(`${e.name} is already ${e.status}`);
      const issues = employeeIssues(e, await this.grade(tx, e.gradeId));
      const [shared] = e.accountNumber
        ? await tx
            .select({ name: employees.name })
            .from(employees)
            .where(
              and(
                eq(employees.accountNumber, e.accountNumber),
                ne(employees.id, e.id),
                ne(employees.status, "exited"),
              ),
            )
        : [];
      if (shared) issues.push(`Bank account is already ${shared.name}'s`);
      if (issues.length)
        throw new UnprocessableEntityException(
          `${e.name} can't go on payroll yet: ${issues.join("; ")}.`,
        );
      const [a] = await tx
        .update(employees)
        .set({
          status: "active",
          activatedBy: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(employees.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "employee.activated",
        entityType: "employee",
        entityId: id,
        after: { status: "active" },
      });
      return a;
    });
  }

  /** A leaver is paid to their exit date and no further. */
  async exit(id: string, input: ExitEmployeeInput, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const e = await this.lock(tx, id);
      if (e.status === "exited")
        throw new ConflictException(`${e.name} has already left`);
      if (input.exitDate < e.startDate)
        throw new UnprocessableEntityException(
          "They can't leave before they started",
        );
      const [x] = await tx
        .update(employees)
        .set({
          status: "exited",
          exitDate: input.exitDate,
          exitReason: input.reason,
          updatedAt: new Date(),
        })
        .where(eq(employees.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "employee.exited",
        entityType: "employee",
        entityId: id,
        after: { exitDate: input.exitDate, reason: input.reason },
      });
      return x;
    });
  }

  private async lock(tx: Tx, id: string) {
    const [e] = await tx
      .select()
      .from(employees)
      .where(eq(employees.id, id))
      .for("update");
    if (!e) throw new NotFoundException("Person not found");
    return e;
  }

  /** For the record: today, where the organization is. */
  today() {
    return businessDate();
  }
}
