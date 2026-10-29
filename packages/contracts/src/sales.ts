import { z } from "zod";

const money = z.number().nonnegative().max(1e14);
const phone = z
  .string()
  .trim()
  .regex(
    /^(\+234|0)[789][01]\d{8}$/,
    "Enter a Nigerian number, like 08031234567",
  );

export const customerKinds = [
  "industrial",
  "reseller",
  "station_operator",
  "government",
] as const;
export const creditTerms = ["prepaid", "credit"] as const;

/**
 * A new customer starts on prepaid terms or with no credit; any credit limit
 * asked for here is raised as an approval and applies only once approved.
 */
export const createCustomerSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^CUS-\d{3,6}$/, "Codes look like CUS-107"),
  name: z.string().trim().min(3).max(200),
  kind: z.enum(customerKinds),
  tin: z
    .string()
    .trim()
    .regex(/^\d{8}-\d{4}$/, "Tax IDs look like 12345678-0001")
    .optional(),
  email: z.email().optional(),
  phone: phone.optional(),
  address: z.string().trim().min(5).max(500),
  /** Receivable brought over from the old system. Replaced by Finance's ledger. */
  openingBalance: money.default(0),
  requestedTerms: z
    .object({
      terms: z.enum(creditTerms),
      creditLimit: money,
      creditDays: z.number().int().min(0).max(120),
      reason: z.string().trim().min(10),
    })
    .optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    name: z.string().trim().min(3).max(200),
    kind: z.enum(customerKinds),
    email: z.email().nullable(),
    phone: phone.nullable(),
    address: z.string().trim().min(5).max(500),
    active: z.boolean(),
  })
  .partial();

/** Credit terms change only through an approval. */
export const creditTermsSchema = z
  .object({
    terms: z.enum(creditTerms),
    creditLimit: money,
    creditDays: z.number().int().min(0).max(120),
    reason: z.string().trim().min(10, "Say why the terms should change"),
  })
  .refine(
    (v) => v.terms === "credit" || (v.creditLimit === 0 && v.creditDays === 0),
    {
      message: "Prepaid customers have no credit limit or days",
      path: ["creditLimit"],
    },
  );
export type CreditTermsInput = z.infer<typeof creditTermsSchema>;

/** A delivery point, with the receiver who confirms deliveries there. */
export const customerSiteSchema = z.object({
  name: z.string().trim().min(3).max(200),
  address: z.string().trim().min(5).max(500),
  state: z.string().trim().min(2).max(60),
  receiverName: z.string().trim().min(3).max(120),
  receiverPhone: phone,
});
export type CustomerSiteInput = z.infer<typeof customerSiteSchema>;

const isoDate = z.iso.date();

export const priceListSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^PL-\d{4}-\d{2}[A-Z]?$/, "Codes look like PL-2026-10"),
  validFrom: isoDate,
  lines: z
    .array(
      z.object({
        productCode: z.string().trim().toUpperCase(),
        price: z.number().positive().max(1e9),
      }),
    )
    .min(1)
    .refine(
      (ls) => new Set(ls.map((l) => l.productCode)).size === ls.length,
      "Each product appears once",
    ),
});
export type PriceListInput = z.infer<typeof priceListSchema>;

export const createOrderSchema = z.object({
  customerId: z.uuid(),
  poRef: z.string().trim().min(3).max(60),
  /** The customer request this came from: email or letter reference. */
  requestRef: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({
        productCode: z.string().trim().toUpperCase(),
        quantity: z.number().positive().max(1e7),
        deliverySiteId: z.uuid(),
      }),
    )
    .min(1)
    .max(20),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const reasonSchema = z.object({
  reason: z.string().trim().min(10, "Give a reason"),
});
