import { z } from "zod";
import { approvalKinds } from "./approvals";
import { roleKeys } from "./roles";

const roleKey = z.enum(roleKeys as [string, ...string[]]);

export const loginSchema = z.object({
  email: z.email().transform((v) => v.trim().toLowerCase()),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(20) });

export const createUserSchema = z.object({
  email: z.email().transform((v) => v.trim().toLowerCase()),
  name: z.string().trim().min(3),
  password: z.string().min(12, "At least 12 characters"),
  roles: z.array(roleKey).min(1),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const setRolesSchema = z.object({ roles: z.array(roleKey) });

export const siteKinds = [
  "depot",
  "station",
  "lpg_plant",
  "office",
  "workshop",
] as const;

export const createSiteSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}-[A-Z0-9]{2,6}$/, "Codes look like ONN-DEP or OWR-01"),
  name: z.string().trim().min(3),
  kind: z.enum(siteKinds),
  state: z.string().trim().min(2),
});
export const updateSiteSchema = createSiteSchema
  .omit({ code: true })
  .partial()
  .extend({ active: z.boolean().optional() });
export type CreateSiteInput = z.infer<typeof createSiteSchema>;

export const createProductSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,10}$/),
  name: z.string().trim().min(3),
  unit: z.enum(["L", "kg"]),
  /** kg per litre, for weighbridge checks. Null for products sold by mass. */
  density: z.number().positive().max(2).nullable(),
  /** VAT rate charged on sale, e.g. 0.075. Prices are quoted VAT-inclusive. */
  vatRate: z.number().min(0).max(0.5).default(0),
});
export const updateProductSchema = createProductSchema
  .omit({ code: true, vatRate: true })
  .partial()
  .extend({ vatRate: z.number().min(0).max(0.5).optional() })
  .extend({ active: z.boolean().optional() });

export const createApprovalSchema = z.object({
  kind: z.enum(approvalKinds),
  /** The record this decision is about, e.g. SO-2026-118. */
  ref: z.string().trim().min(3).max(60),
  title: z.string().trim().min(5).max(200),
  amount: z.number().nonnegative(),
  reason: z.string().trim().min(10, "Say why this should be approved"),
});
export type CreateApprovalInput = z.infer<typeof createApprovalSchema>;

export const decideApprovalSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    note: z.string().trim().max(1000).default(""),
  })
  .refine((v) => v.decision === "approved" || v.note.length >= 5, {
    message: "A rejection needs a reason",
    path: ["note"],
  });
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;

const newPassword = z
  .string()
  .min(12, "At least 12 characters")
  .max(200)
  .refine((p) => new Set(p).size >= 5, "Use a less repetitive password");

/** An administrator sets a temporary password; the person changes it. */
export const resetPasswordSchema = z.object({ password: newPassword });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z
  .object({ current: z.string().min(1), password: newPassword })
  .refine((v) => v.current !== v.password, {
    message: "Choose a password you haven't used here",
    path: ["password"],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * Who decides a kind of request, by amount. Bands start at 0, follow on with
 * no gaps, and the last is open-ended.
 */
export const policyBandsSchema = z
  .object({
    bands: z
      .array(
        z.object({
          min: z.number().min(0),
          max: z.number().positive().nullable(),
          approver: roleKey,
        }),
      )
      .min(1)
      .max(10),
  })
  .superRefine(({ bands }, ctx) => {
    bands.forEach((b, i) => {
      const at = (message: string, field: string) =>
        ctx.addIssue({ code: "custom", message, path: ["bands", i, field] });
      if (i === 0 && b.min !== 0) at("The first band starts at 0", "min");
      if (i > 0 && b.min !== bands[i - 1].max)
        at("Each band starts where the one before ends", "min");
      if (i === bands.length - 1 && b.max !== null)
        at("The last band has no upper limit", "max");
      if (i < bands.length - 1 && (b.max === null || b.max <= b.min))
        at("Each band ends above where it starts", "max");
    });
  });
export type PolicyBandsInput = z.infer<typeof policyBandsSchema>;
