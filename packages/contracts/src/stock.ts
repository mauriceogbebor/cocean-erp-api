import { z } from "zod";

const isoDate = z.iso.date();
const qty = z.number().positive().max(1e8);

/**
 * Placeholder tolerances until Cocean's operations and HSE teams set them.
 * They live here so the API and the web app apply the same numbers.
 */
export const STOCK_RULES = {
  /** A dip within this of book stock is booked automatically as a gain or loss. */
  dipTolerancePct: 0.005,
  /** …or within this many units, whichever is larger (small tanks). */
  dipToleranceMin: 50,
  /** Received within this of loaded counts as delivered in full. */
  deliveryTolerancePct: 0.005,
  /** A delivery link works for this many days. */
  deliveryLinkDays: 7,
} as const;

export const createTankSchema = z
  .object({
    siteId: z.uuid(),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{2,20}$/, "Codes look like ONN-T04"),
    productCode: z.string().trim().toUpperCase(),
    /** Nominal capacity, in the product's unit. */
    capacity: qty,
    /** The most it may hold: 95% for liquids, 85% for LPG, as HSE sets. */
    safeCapacity: qty,
    /** Stock already in the tank when it is set up, from the last physical dip. */
    openingStock: z.number().min(0).max(1e8).default(0),
  })
  .refine((v) => v.safeCapacity <= v.capacity, {
    message: "Safe capacity can't exceed the tank's capacity",
    path: ["safeCapacity"],
  })
  .refine((v) => v.openingStock <= v.safeCapacity, {
    message: "Opening stock is above safe capacity",
    path: ["openingStock"],
  });
export type CreateTankInput = z.infer<typeof createTankSchema>;

/** A physical measurement of what is in a tank. */
export const dipSchema = z.object({
  quantity: z.number().min(0).max(1e8),
  /** Product temperature in °C, recorded for later volume correction. */
  temperature: z.number().min(-10).max(80).optional(),
  dippedOn: isoDate,
  notes: z.string().trim().max(500).optional(),
});
export type DipInput = z.infer<typeof dipSchema>;

const plate = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}-?\d{3}-?[A-Z]{2}$/, "Plates look like RIV-430-BN");

/** Operations plans one truck against a released order: one drop per order line. */
export const planLiftingSchema = z.object({
  orderId: z.uuid(),
  /** The depot it loads at. */
  siteId: z.uuid(),
  truckPlate: plate,
  driverName: z.string().trim().min(3).max(120),
  driverPhone: z
    .string()
    .trim()
    .regex(
      /^(\+234|0)[789][01]\d{8}$/,
      "Enter a Nigerian number, like 08031234567",
    ),
  drops: z
    .array(z.object({ orderLineId: z.uuid(), quantity: qty }))
    .min(1)
    .max(6)
    .refine(
      (d) => new Set(d.map((x) => x.orderLineId)).size === d.length,
      "Each order line appears once",
    ),
});
export type PlanLiftingInput = z.infer<typeof planLiftingSchema>;

const seal = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{4,20}$/, "Seal numbers are 4–20 letters and digits");

/** The depot records what went into the truck, from the meter, and the seals fitted. */
export const loadLiftingSchema = z.object({
  drops: z
    .array(
      z.object({
        dropId: z.uuid(),
        tankId: z.uuid(),
        loadedQuantity: qty,
        seals: z
          .array(seal)
          .min(1)
          .max(12)
          .refine(
            (s) => new Set(s).size === s.length,
            "Each seal is listed once",
          ),
      }),
    )
    .min(1),
});
export type LoadLiftingInput = z.infer<typeof loadLiftingSchema>;

/** The customer's receiver confirms, blind: they never see the recorded seals or quantity. */
export const confirmDeliverySchema = z.object({
  token: z.string().trim().min(20).max(100),
  receiverName: z.string().trim().min(3).max(120),
  receivedQuantity: z.number().min(0).max(1e8),
  seals: z.array(seal).min(1).max(12),
  notes: z.string().trim().max(500).optional(),
});
export type ConfirmDeliveryInput = z.infer<typeof confirmDeliverySchema>;

export const resolveDeliverySchema = z.object({
  /** What the investigation found and what happens next. */
  finding: z
    .string()
    .trim()
    .min(20, "Record what was found and what happens next"),
});
