import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  PAYROLL_FLAGS,
  type PayPayrollInput,
  type PayrollFlag,
  type PayrollRules,
  type PayrollStatus,
  type SubmitPayrollInput,
} from "@qorrix-erp/contracts";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lte,
  ne,
  or,
  isNull,
  gte,
} from "drizzle-orm";
import {
  ApprovalHandlers,
  type DecidedRequest,
} from "../approvals/approval-handlers.js";
import { ApprovalsService } from "../approvals/approvals.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor, AuthUser } from "../common/auth-context.js";
import { nextNumber } from "../common/numbering.js";
import { money, org } from "../common/org.js";
import { DB } from "../common/tokens.js";
import type { Db, Tx } from "../db/client.js";
import {
  employees,
  grades,
  payrollLines,
  payrollRuns,
  users,
} from "../db/schema.js";
import { calcPay, monthOf } from "./pay-calc.js";

type Run = typeof payrollRuns.$inferSelect;
type Line = typeof payrollLines.$inferSelect;

const MONEY_LINE = [
  "basic",
  "housing",
  "transport",
  "other",
  "gross",
  "pensionEmployee",
  "nhf",
  "rentRelief",
  "paye",
  "net",
  "pensionEmployer",
  "nsitf",
  "itf",
] as const;
const MONEY_RUN = [
  "gross",
  "net",
  "paye",
  "pensionEmployee",
  "pensionEmployer",
  "nhf",
  "nsitf",
  "itf",
  "employerCost",
] as const;
const kobo = (n: number | string) => Math.round(Number(n) * 100);
const blocking = (flags: string[]) =>
  flags.filter((f) => PAYROLL_FLAGS[f as PayrollFlag]?.blocking);

const lineView = (l: Line) => {
  const m = Object.fromEntries(
    MONEY_LINE.map((k) => [k, Number(l[k])]),
  ) as Record<(typeof MONEY_LINE)[number], number>;
  return { ...l, ...m, factor: Number(l.factor) };
};

/**
 * A month's payroll. HR calculates it from active staff and the payroll
 * rules in the organization's settings; checks flag what needs a second
 * look, and anything blocking (a shared bank account, no pension details,
 * pay outside the band) stops it going forward. Approval follows the
 * payroll limits; Finance then pays from the bank file and records it.
 */
@Injectable()
export class PayrollService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
    @Inject(ApprovalHandlers) handlers: ApprovalHandlers,
  ) {
    handlers.register("payroll", (tx, req, actor) =>
      this.decided(tx, req, actor),
    );
  }

  private runView(r: Run, preparedByName?: string | null) {
    return {
      ...r,
      ...Object.fromEntries(MONEY_RUN.map((k) => [k, Number(r[k])])),
      preparedByName: preparedByName ?? null,
    };
  }

  async list() {
    const rows = await this.db
      .select({ r: payrollRuns, by: users.name })
      .from(payrollRuns)
      .leftJoin(users, eq(users.id, payrollRuns.preparedBy))
      .orderBy(desc(payrollRuns.period));
    return rows.map((x) => this.runView(x.r, x.by));
  }

  async get(id: string) {
    const [x] = await this.db
      .select({ r: payrollRuns, by: users.name })
      .from(payrollRuns)
      .leftJoin(users, eq(users.id, payrollRuns.preparedBy))
      .where(eq(payrollRuns.id, id));
    if (!x) throw new NotFoundException("Payroll run not found");
    const lines = (
      await this.db
        .select()
        .from(payrollLines)
        .where(eq(payrollLines.runId, id))
        .orderBy(asc(payrollLines.name))
    ).map(lineView);
    return {
      ...this.runView(x.r, x.by),
      lines,
      blocking: lines.filter((l) => blocking(l.flags).length).length,
      remittances: this.remittances(lines),
    };
  }

  /** One person's payslip. */
  async payslip(runId: string, employeeId: string) {
    const run = await this.get(runId);
    const line = run.lines.find((l) => l.employeeId === employeeId);
    if (!line) throw new NotFoundException("They aren't on this payroll");
    const { lines: _, remittances: __, ...r } = run;
    return { run: r, line };
  }

  /** Who is owed what: tax by state, pension by fund, housing fund, levies. */
  private remittances(lines: ReturnType<typeof lineView>[]) {
    const sum = <K extends string>(
      key: (l: (typeof lines)[number]) => K,
      v: (l: (typeof lines)[number]) => number,
    ) => {
      const m = new Map<K, number>();
      for (const l of lines) m.set(key(l), (m.get(key(l)) ?? 0) + kobo(v(l)));
      return [...m.entries()]
        .filter(([, a]) => a > 0)
        .map(([to, a]) => ({ to, amount: a / 100 }))
        .sort((a, b) => String(a.to).localeCompare(String(b.to)));
    };
    return {
      paye: sum(
        (l) => l.taxState,
        (l) => l.paye,
      ),
      pension: sum(
        (l) => l.pfa ?? "No fund",
        (l) => l.pensionEmployee + l.pensionEmployer,
      ),
      nhf: lines.reduce((s, l) => s + kobo(l.nhf), 0) / 100,
      nsitf: lines.reduce((s, l) => s + kobo(l.nsitf), 0) / 100,
      itf: lines.reduce((s, l) => s + kobo(l.itf), 0) / 100,
    };
  }

  /** Works out a month: a new run, or a draft (or refused) one again. */
  async calculate(period: string, actor: Actor) {
    const { first, last } = monthOf(period);
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(payrollRuns)
        .where(eq(payrollRuns.period, period))
        .for("update");
      if (existing && !["draft", "rejected"].includes(existing.status))
        throw new ConflictException(
          `${period}'s payroll is ${existing.status}; it can't be worked out again`,
        );
      const rules = org().payroll;
      // Everyone active, and leavers who were still here at some point in it.
      const people = await tx
        .select({ e: employees, g: grades })
        .from(employees)
        .innerJoin(grades, eq(grades.id, employees.gradeId))
        .where(
          and(
            lte(employees.startDate, last),
            or(
              eq(employees.status, "active"),
              and(
                eq(employees.status, "exited"),
                gte(employees.exitDate, first),
              ),
            ),
          ),
        );
      const previous = await this.previousNet(tx, period);
      const accounts = new Map<string, number>();
      for (const { e } of people)
        if (e.accountNumber)
          accounts.set(
            e.accountNumber,
            (accounts.get(e.accountNumber) ?? 0) + 1,
          );

      const lines = people.flatMap(({ e, g }) => {
        const pay = calcPay(
          {
            basic: Number(e.basic),
            housing: Number(e.housing),
            transport: Number(e.transport),
            other: Number(e.other),
            nhfOptIn: e.nhfOptIn,
            annualRent: Number(e.annualRent),
            startDate: e.startDate,
            exitDate: e.exitDate,
          },
          period,
          rules,
        );
        if (!pay) return [];
        const full =
          Number(e.basic) +
          Number(e.housing) +
          Number(e.transport) +
          Number(e.other);
        const flags: PayrollFlag[] = [];
        if (!e.bankName || !e.accountNumber) flags.push("missing_bank");
        else if ((accounts.get(e.accountNumber) ?? 0) > 1)
          flags.push("shared_account");
        if (!e.pfa || !e.rsaPin) flags.push("missing_pension");
        if (full < Number(g.minMonthly) || full > Number(g.maxMonthly))
          flags.push("out_of_band");
        const before = previous.get(e.id);
        if (
          before !== undefined &&
          !pay.joiner &&
          !pay.leaver &&
          Math.abs(pay.net - before) > before * rules.payJumpPct
        )
          flags.push("pay_jump");
        if (pay.joiner) flags.push("joiner");
        if (pay.leaver) flags.push("leaver");
        return [{ e, pay, flags }];
      });
      if (!lines.length)
        throw new UnprocessableEntityException(
          `Nobody was employed in ${period}. Activate joiners first.`,
        );

      const total = (k: (typeof MONEY_RUN)[number] | "pensionEmployee") =>
        lines.reduce(
          (s, l) => s + kobo(l.pay[k as keyof typeof l.pay] as number),
          0,
        );
      const t = {
        gross: total("gross"),
        net: total("net"),
        paye: total("paye"),
        pensionEmployee: total("pensionEmployee"),
        pensionEmployer: total("pensionEmployer"),
        nhf: total("nhf"),
        nsitf: total("nsitf"),
        itf: total("itf"),
      };
      const employerCost = t.gross + t.pensionEmployer + t.nsitf + t.itf;
      const values = {
        headcount: lines.length,
        ...Object.fromEntries(
          Object.entries({ ...t, employerCost }).map(([k, v]) => [
            k,
            (v / 100).toFixed(2),
          ]),
        ),
        rules,
        status: "draft" as const,
        approvalId: null,
        note: null,
        preparedBy: actor.userId as string,
        calculatedAt: new Date(),
      } as Omit<typeof payrollRuns.$inferInsert, "number" | "period">;

      let run: Run;
      if (existing) {
        await tx
          .delete(payrollLines)
          .where(eq(payrollLines.runId, existing.id));
        [run] = await tx
          .update(payrollRuns)
          .set(values)
          .where(eq(payrollRuns.id, existing.id))
          .returning();
      } else {
        [run] = await tx
          .insert(payrollRuns)
          .values({ ...values, period, number: await nextNumber(tx, "PAY") })
          .returning();
      }
      await tx.insert(payrollLines).values(
        lines.map(({ e, pay, flags }) => ({
          runId: run.id,
          employeeId: e.id,
          number: e.number,
          name: e.name,
          department: e.department,
          jobTitle: e.jobTitle,
          bankName: e.bankName,
          accountNumber: e.accountNumber,
          accountName: e.accountName,
          pfa: e.pfa,
          rsaPin: e.rsaPin,
          taxState: e.taxState,
          factor: String(pay.factor),
          ...Object.fromEntries(MONEY_LINE.map((k) => [k, pay[k].toFixed(2)])),
          flags,
        })) as (typeof payrollLines.$inferInsert)[],
      );
      await this.audit.record(tx, actor, {
        action: existing ? "payroll.recalculated" : "payroll.calculated",
        entityType: "payroll_run",
        entityId: run.id,
        after: { period, headcount: lines.length, net: t.net / 100 },
      });
      return run;
    });
  }

  /** Net pay per person in the last paid month before this one. */
  private async previousNet(tx: Tx, period: string) {
    const [prev] = await tx
      .select({ id: payrollRuns.id, period: payrollRuns.period })
      .from(payrollRuns)
      .where(
        and(eq(payrollRuns.status, "paid"), ne(payrollRuns.period, period)),
      )
      .orderBy(desc(payrollRuns.period));
    if (!prev || prev.period > period) return new Map<string, number>();
    const rows = await tx
      .select({
        id: payrollLines.employeeId,
        net: payrollLines.net,
        factor: payrollLines.factor,
      })
      .from(payrollLines)
      .where(eq(payrollLines.runId, prev.id));
    // A part month last time isn't a fair comparison.
    return new Map(
      rows
        .filter((r) => Number(r.factor) === 1)
        .map((r) => [r.id, Number(r.net)]),
    );
  }

  /** HR sends a clean run for approval; warnings need a note saying what was checked. */
  async submit(
    id: string,
    input: SubmitPayrollInput,
    user: AuthUser,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const run = await this.lock(tx, id);
      if (run.status !== "draft")
        throw new ConflictException(`This payroll is ${run.status}`);
      const lines = await tx
        .select()
        .from(payrollLines)
        .where(eq(payrollLines.runId, id));
      const stop = lines.filter((l) => blocking(l.flags).length);
      if (stop.length)
        throw new UnprocessableEntityException(
          `Fix these first, then work the payroll out again: ${stop
            .map(
              (l) =>
                `${l.name} (${blocking(l.flags)
                  .map((f) =>
                    PAYROLL_FLAGS[f as PayrollFlag].label.toLowerCase(),
                  )
                  .join(", ")})`,
            )
            .join("; ")}.`,
        );
      const warned = lines.filter((l) => l.flags.includes("pay_jump"));
      if (warned.length && !input.note)
        throw new UnprocessableEntityException(
          `Say what you checked for ${warned.map((l) => l.name).join(", ")}: their net pay changed sharply since last month.`,
        );
      const approval = await this.approvals.createIn(
        tx,
        {
          kind: "payroll",
          ref: run.number,
          title: `Payroll for ${run.period}: ${run.headcount} people, ${money(Number(run.net))} net`,
          amount: Math.round(Number(run.employerCost)),
          reason: [
            `Gross ${money(Number(run.gross))}; PAYE ${money(Number(run.paye))}; pension ${money(Number(run.pensionEmployee) + Number(run.pensionEmployer))}; cost to the organization ${money(Number(run.employerCost))}.`,
            ...lines
              .filter((l) => l.flags.length)
              .map(
                (l) =>
                  `${l.name}: ${l.flags.map((f) => PAYROLL_FLAGS[f as PayrollFlag].label.toLowerCase()).join(", ")}.`,
              ),
            input.note ? `HR's note: ${input.note}` : "",
          ]
            .filter(Boolean)
            .join(" "),
        },
        user.id,
        actor,
        { runId: id },
      );
      const [r] = await tx
        .update(payrollRuns)
        .set({
          status: "submitted",
          approvalId: approval.id,
          note: input.note ?? null,
        })
        .where(eq(payrollRuns.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "payroll.submitted",
        entityType: "payroll_run",
        entityId: id,
        after: { approval: approval.id },
      });
      return r;
    });
  }

  private async decided(tx: Tx, req: DecidedRequest, actor: Actor) {
    const id = (req.payload as { runId?: string } | null)?.runId;
    if (!id) return;
    const run = await this.lock(tx, id);
    if (run.status !== "submitted") return;
    const status: PayrollStatus =
      req.status === "approved" ? "approved" : "rejected";
    await tx.update(payrollRuns).set({ status }).where(eq(payrollRuns.id, id));
    await this.audit.record(tx, actor, {
      action: `payroll.${status}`,
      entityType: "payroll_run",
      entityId: id,
      after: { approval: req.id },
    });
  }

  /** The bank's bulk payment file: one row per person, net pay. */
  async bankFile(id: string) {
    const run = await this.get(id);
    if (!["approved", "paid"].includes(run.status))
      throw new ConflictException("Only an approved payroll can be paid");
    const q = (v: string | number | null) =>
      `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      [
        "Employee number",
        "Name",
        "Bank",
        "Account number",
        "Account name",
        "Amount",
        "Narration",
      ],
      ...run.lines.map((l) => [
        l.number,
        l.name,
        l.bankName,
        l.accountNumber,
        l.accountName ?? l.name,
        l.net.toFixed(2),
        `Salary ${run.period}`,
      ]),
    ];
    return {
      filename: `${run.number}-bank-file.csv`,
      csv: rows.map((r) => r.map(q).join(",")).join("\r\n") + "\r\n",
    };
  }

  /** Finance records the payment; the maker of the run can't. */
  async pay(id: string, input: PayPayrollInput, user: AuthUser, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const run = await this.lock(tx, id);
      if (run.status !== "approved")
        throw new ConflictException(
          run.status === "paid"
            ? "This payroll is already paid"
            : "Only an approved payroll can be paid",
        );
      if (run.preparedBy === user.id)
        throw new ForbiddenException(
          "You prepared this payroll. Someone else records it as paid.",
        );
      const [r] = await tx
        .update(payrollRuns)
        .set({
          status: "paid",
          paidOn: input.paidOn,
          bankRef: input.bankRef,
          paidBy: user.id,
        })
        .where(eq(payrollRuns.id, id))
        .returning();
      await this.audit.record(tx, actor, {
        action: "payroll.paid",
        entityType: "payroll_run",
        entityId: id,
        after: input,
      });
      return r;
    });
  }

  private async lock(tx: Tx, id: string) {
    const [r] = await tx
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, id))
      .for("update");
    if (!r) throw new NotFoundException("Payroll run not found");
    return r;
  }

  /** The rules a run was worked with. */
  rulesOf(run: Run) {
    return run.rules as PayrollRules;
  }
}
