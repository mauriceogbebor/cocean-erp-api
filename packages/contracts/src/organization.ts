import { z } from "zod";
import { STATION_RULES } from "./stations";
import { STOCK_RULES } from "./stock";
import { FLEET_RULES, vehicleKinds } from "./fleet";
import { DEFAULT_PAYROLL_RULES, payrollRulesSchema } from "./people";

/**
 * Everything that differs between the organizations running Qorrix ERP.
 * One installation serves one organization, so there is one of these. The
 * defaults suit a Nigerian petroleum distributor; an administrator changes
 * them on the Settings screen and every check reads them from there.
 */

export const NIGERIAN_STATES = [
  "Abia",
  "Adamawa",
  "Akwa Ibom",
  "Anambra",
  "Bauchi",
  "Bayelsa",
  "Benue",
  "Borno",
  "Cross River",
  "Delta",
  "Ebonyi",
  "Edo",
  "Ekiti",
  "Enugu",
  "FCT",
  "Gombe",
  "Imo",
  "Jigawa",
  "Kaduna",
  "Kano",
  "Katsina",
  "Kebbi",
  "Kogi",
  "Kwara",
  "Lagos",
  "Nasarawa",
  "Niger",
  "Ogun",
  "Ondo",
  "Osun",
  "Oyo",
  "Plateau",
  "Rivers",
  "Sokoto",
  "Taraba",
  "Yobe",
  "Zamfara",
];

export const NIGERIAN_BANKS = [
  "Access Bank",
  "Citibank",
  "Ecobank",
  "Fidelity Bank",
  "First Bank",
  "FCMB",
  "Globus Bank",
  "Guaranty Trust Bank",
  "Jaiz Bank",
  "Keystone Bank",
  "Optimus Bank",
  "Parallex Bank",
  "Polaris Bank",
  "Premium Trust Bank",
  "Providus Bank",
  "Signature Bank",
  "Stanbic IBTC",
  "Standard Chartered",
  "Sterling Bank",
  "SunTrust Bank",
  "Titan Trust Bank",
  "Union Bank",
  "United Bank for Africa",
  "Unity Bank",
  "Wema Bank",
  "Zenith Bank",
];

const docKey = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, "Use lower-case letters, digits and _");

export const vehicleDocumentTypeSchema = z.object({
  key: docKey,
  label: z.string().trim().min(3).max(120),
  /** Vehicle kinds that can't be dispatched without it, in date. */
  requiredFor: z.array(z.enum(vehicleKinds)).max(vehicleKinds.length),
});

/** A format the organization's IDs follow, checked by the API. */
export const formatSchema = z
  .object({
    pattern: z.string().min(1).max(200),
    example: z.string().trim().min(1).max(40),
  })
  .refine(
    (f) => {
      try {
        return new RegExp(f.pattern).test(f.example);
      } catch {
        return false;
      }
    },
    { message: "The example must match the pattern", path: ["pattern"] },
  );
export const formatKeys = ["phone", "plate", "bankAccount", "taxId"] as const;
export type FormatKey = (typeof formatKeys)[number];
export const formatLabels: Record<FormatKey, string> = {
  phone: "Phone numbers",
  plate: "Number plates",
  bankAccount: "Bank account numbers",
  taxId: "Tax IDs",
};

const pct = z.number().min(0).max(0.2);
const list = (max: number) =>
  z
    .array(z.string().trim().min(2).max(80))
    .min(1)
    .max(max)
    .refine((l) => new Set(l).size === l.length, "Each entry once");

export const organizationSettingsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(200).default(""),
  /** A PNG, JPEG or SVG as a data URL, shown in the header and on sign-in. */
  logo: z
    .string()
    .max(300_000, "Use a logo under 200 KB")
    .regex(/^data:image\/(png|jpeg|svg\+xml);base64,/, "PNG, JPEG or SVG only")
    .nullable()
    .default(null),
  currency: z.object({
    code: z.string().trim().toUpperCase().length(3),
    symbol: z.string().trim().min(1).max(4),
  }),
  /** BCP 47, for number and date formats, e.g. en-NG. */
  locale: z.string().trim().min(2).max(20),
  /** IANA zone; business dates (today, overdue, expiry) follow it. */
  timeZone: z.string().trim().min(3).max(60),
  /** States or regions, for sites and delivery addresses. */
  regions: list(100),
  /** Banks customers pay into and suppliers are paid from. */
  banks: list(100),
  formats: z.object({
    phone: formatSchema,
    plate: formatSchema,
    bankAccount: formatSchema,
    taxId: formatSchema,
  }),
  /** VAT on supplier lines unless the line says otherwise. */
  defaultVatRate: z.number().min(0).max(0.5),
  /** What the regulator's permit and other truck papers are called here. */
  vehicleDocuments: z
    .array(vehicleDocumentTypeSchema)
    .min(1)
    .max(20)
    .refine(
      (l) => new Set(l.map((d) => d.key)).size === l.length,
      "Each document key once",
    ),
  stock: z.object({
    dipTolerancePct: pct,
    dipToleranceMin: z.number().min(0).max(10_000),
    deliveryTolerancePct: pct,
    deliveryLinkDays: z.number().int().min(1).max(30),
  }),
  stations: z.object({
    cashToleranceAmount: z.number().min(0).max(1e9),
    cashTolerancePct: pct,
  }),
  payroll: payrollRulesSchema,
  fleet: z.object({
    inductionValidDays: z.number().int().min(30).max(1_095),
    trackerStaleMinutes: z.number().int().min(1).max(1_440),
  }),
});
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>;
export const updateOrganizationSchema = organizationSettingsSchema;
export type UpdateOrganizationInput = z.input<typeof updateOrganizationSchema>;

/** Where a new installation starts: a Nigerian petroleum distributor. */
export const DEFAULT_ORGANIZATION: OrganizationSettings = {
  name: "Your organization",
  legalName: "",
  logo: null,
  currency: { code: "NGN", symbol: "₦" },
  locale: "en-NG",
  timeZone: "Africa/Lagos",
  regions: NIGERIAN_STATES,
  banks: NIGERIAN_BANKS,
  formats: {
    phone: { pattern: "^(\\+234|0)[789][01]\\d{8}$", example: "08031234567" },
    plate: { pattern: "^[A-Z]{3}-\\d{3}-[A-Z]{2}$", example: "RIV-430-BN" },
    bankAccount: { pattern: "^\\d{10}$", example: "0123456789" },
    taxId: { pattern: "^\\d{8}-\\d{4}$", example: "12345678-0001" },
  },
  defaultVatRate: 0.075,
  vehicleDocuments: [
    {
      key: "registration",
      label: "Vehicle registration",
      requiredFor: [...vehicleKinds],
    },
    {
      key: "roadworthiness",
      label: "Roadworthiness certificate",
      requiredFor: [...vehicleKinds],
    },
    { key: "insurance", label: "Insurance", requiredFor: [...vehicleKinds] },
    {
      key: "nmdpra_permit",
      label: "NMDPRA permit to carry petroleum products",
      requiredFor: ["tanker", "lpg_bridger"],
    },
    {
      key: "calibration",
      label: "Tank calibration certificate",
      requiredFor: ["tanker", "lpg_bridger"],
    },
  ],
  stock: { ...STOCK_RULES },
  stations: {
    cashToleranceAmount: STATION_RULES.cashToleranceAmount,
    cashTolerancePct: STATION_RULES.cashTolerancePct,
  },
  fleet: { ...FLEET_RULES },
  payroll: DEFAULT_PAYROLL_RULES,
};

/** What anyone may see before signing in. */
export type PublicOrganization = Pick<
  OrganizationSettings,
  "name" | "logo" | "currency" | "locale" | "timeZone"
>;
