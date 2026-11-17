import { z } from "zod";

// ── Staff ───────────────────────────────────────────────────────────────────

const money = z.number().min(0).max(1e12);
const text = (max = 120) => z.string().trim().min(2).max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const employmentTypes = ["permanent", "contract"] as const;
export const employeeStatuses = ["onboarding", "active", "exited"] as const;
export type EmployeeStatus = (typeof employeeStatuses)[number];

export const gradeSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{1,12}$/, "Letters, digits and dashes"),
    name: text(80),
    /** Monthly gross pay band. */
    minMonthly: money,
    maxMonthly: money,
  })
  .refine((g) => g.maxMonthly >= g.minMonthly, {
    message: "The top of the band can't be below the bottom",
    path: ["maxMonthly"],
  });
export type GradeInput = z.infer<typeof gradeSchema>;

/** Monthly pay. Pension is worked on basic, housing and transport. */
export const paySchema = z.object({
  basic: money.refine((n) => n > 0, "Basic pay is required"),
  housing: money.default(0),
  transport: money.default(0),
  other: money.default(0),
});
export type PayInput = z.input<typeof paySchema>;

/** Bank and statutory details; checked against the organization's formats. */
const details = {
  phone: z.string().trim().min(7).max(20).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  department: text(80),
  jobTitle: text(80),
  siteId: z.string().uuid().optional(),
  employmentType: z.enum(employmentTypes).default("permanent"),
  bankName: z.string().trim().min(2).max(80).optional(),
  accountNumber: z.string().trim().min(4).max(34).optional(),
  accountName: z.string().trim().min(2).max(120).optional(),
  pfa: z.string().trim().min(2).max(80).optional(),
  rsaPin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,20}$/, "Enter the retirement savings account PIN")
    .optional(),
  taxId: z.string().trim().min(3).max(30).optional(),
  /** State or region whose revenue service receives the PAYE. */
  taxState: z.string().trim().min(2).max(80),
  /** Housing fund deductions only with the employee's consent. */
  nhfOptIn: z.boolean().default(false),
  /** Annual rent the employee has declared, for rent relief. */
  annualRent: money.default(0),
};

export const createEmployeeSchema = z.object({
  name: text(),
  gradeId: z.string().uuid(),
  startDate: isoDate,
  pay: paySchema,
  ...details,
});
export type CreateEmployeeInput = z.input<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z
  .object({ name: text(), gradeId: z.string().uuid(), ...details })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type UpdateEmployeeInput = z.input<typeof updateEmployeeSchema>;

export const payChangeSchema = paySchema.extend({
  reason: z.string().trim().min(5, "Say why the pay changes").max(300),
});
export type PayChangeInput = z.input<typeof payChangeSchema>;

export const exitEmployeeSchema = z.object({
  exitDate: isoDate,
  reason: z.string().trim().min(5, "Say why they are leaving").max(300),
});
export type ExitEmployeeInput = z.infer<typeof exitEmployeeSchema>;

// ── Payroll ─────────────────────────────────────────────────────────────────

export const payrollStatuses = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "paid",
] as const;
export type PayrollStatus = (typeof payrollStatuses)[number];

export const startPayrollSchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM"),
});
export type StartPayrollInput = z.infer<typeof startPayrollSchema>;

export const submitPayrollSchema = z.object({
  /** Required when the run has warnings: what HR checked. */
  note: z.string().trim().max(500).optional(),
});
export type SubmitPayrollInput = z.infer<typeof submitPayrollSchema>;

export const payPayrollSchema = z.object({
  paidOn: isoDate,
  bankRef: z.string().trim().min(3).max(60),
});
export type PayPayrollInput = z.infer<typeof payPayrollSchema>;

/** Flags a payroll line can carry. Blocking flags stop submission. */
export const PAYROLL_FLAGS = {
  shared_account: {
    label: "Bank account shared with another person",
    blocking: true,
  },
  missing_bank: { label: "No bank account", blocking: true },
  missing_pension: { label: "No pension fund or RSA PIN", blocking: true },
  out_of_band: { label: "Pay outside the grade's band", blocking: true },
  pay_jump: {
    label: "Net pay changed sharply since last month",
    blocking: false,
  },
  joiner: {
    label: "Joined this month: paid from the start date",
    blocking: false,
  },
  leaver: { label: "Left this month: paid to the exit date", blocking: false },
} as const;
export type PayrollFlag = keyof typeof PAYROLL_FLAGS;

/** Bands applied in order to annual chargeable income; null is "the rest". */
export const taxBandSchema = z.object({
  width: z.number().positive().max(1e13).nullable(),
  rate: z.number().min(0).max(0.7),
});

/**
 * Payroll rules: each organization sets its own. The defaults follow the
 * Nigeria Tax Act 2025 (from January 2026), the Pension Reform Act 2014 and
 * the usual employer levies; the organization's adviser confirms them.
 */
export const payrollRulesSchema = z.object({
  taxBands: z
    .array(taxBandSchema)
    .min(1)
    .max(12)
    .refine(
      (b) => b.every((x, i) => (x.width === null) === (i === b.length - 1)),
      "Only the last band is open-ended",
    ),
  /** Monthly gross at or below this pays no PAYE (the minimum wage). */
  taxFreeMonthlyGross: z.number().min(0).max(1e9),
  rentReliefPct: z.number().min(0).max(1),
  rentReliefCap: z.number().min(0).max(1e10),
  pensionEmployeePct: z.number().min(0).max(0.3),
  pensionEmployerPct: z.number().min(0).max(0.3),
  /** Housing fund, on basic pay, for those who opted in. */
  nhfPct: z.number().min(0).max(0.1),
  nsitfPct: z.number().min(0).max(0.05),
  itfPct: z.number().min(0).max(0.05),
  /** Net pay moving by more than this since last month is flagged. */
  payJumpPct: z.number().min(0.01).max(5),
});
export type PayrollRules = z.infer<typeof payrollRulesSchema>;

export const DEFAULT_PAYROLL_RULES: PayrollRules = {
  taxBands: [
    { width: 800_000, rate: 0 },
    { width: 2_200_000, rate: 0.15 },
    { width: 9_000_000, rate: 0.18 },
    { width: 13_000_000, rate: 0.21 },
    { width: 25_000_000, rate: 0.23 },
    { width: null, rate: 0.25 },
  ],
  taxFreeMonthlyGross: 70_000,
  rentReliefPct: 0.2,
  rentReliefCap: 500_000,
  pensionEmployeePct: 0.08,
  pensionEmployerPct: 0.1,
  nhfPct: 0.025,
  nsitfPct: 0.01,
  itfPct: 0.01,
  payJumpPct: 0.25,
};
