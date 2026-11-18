import { z } from "zod";

const isoDate = z.iso.date();
const money = z.number().min(0).max(1e12);

/**
 * Defaults; each organization sets its own in its settings. Takings within
 * this of what the meters say count as balanced.
 */
export const STATION_RULES = {
  cashToleranceAmount: 5_000,
  cashTolerancePct: 0.002,
} as const;

/** Who may work at which site. Station and LPG actions need it. */
export const userSitesSchema = z.object({ siteIds: z.array(z.uuid()).max(50) });

export const createPumpSchema = z.object({
  siteId: z.uuid(),
  tankId: z.uuid(),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,12}$/, "Codes look like P1 or AGO-2"),
  /** The meter reading when the pump is set up. */
  openingMeter: z.number().min(0).max(1e10),
});
export type CreatePumpInput = z.infer<typeof createPumpSchema>;

/** Product delivered to a station's tank, against the waybill. */
export const stationReceiptSchema = z.object({
  quantity: z.number().positive().max(1e6),
  waybill: z.string().trim().toUpperCase().min(3).max(40),
  receivedOn: isoDate,
});
export type StationReceiptInput = z.infer<typeof stationReceiptSchema>;

/**
 * Closing a shift: every pump's closing meter, a dip of every tank, and the
 * takings counted. Sales come from the meters (and LPG fills); the system
 * works out what the takings and tanks should be and compares.
 */
export const closeShiftSchema = z.object({
  siteId: z.uuid(),
  shiftDate: isoDate,
  period: z.enum(["day", "morning", "evening", "night"]),
  meters: z.array(
    z.object({ pumpId: z.uuid(), closing: z.number().min(0).max(1e10) }),
  ),
  dips: z
    .array(z.object({ tankId: z.uuid(), quantity: z.number().min(0).max(1e8) }))
    .min(1),
  takings: z.object({ cash: money, pos: money, transfer: money }),
  notes: z.string().trim().max(1000).optional(),
});
export type CloseShiftInput = z.infer<typeof closeShiftSchema>;

/** Finance records the cash lodged at the bank for a closed shift. */
export const bankTakingsSchema = z.object({
  bank: z.string().trim().min(2).max(60),
  bankRef: z.string().trim().toUpperCase().min(4).max(60),
  amount: money,
  bankedOn: isoDate,
});
export type BankTakingsInput = z.infer<typeof bankTakingsSchema>;

// ── LPG ─────────────────────────────────────────────────────────────────────
export const cylinderSizes = [3, 5, 6, 12.5, 25, 50] as const;

export const createCylinderSchema = z.object({
  serial: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{4,30}$/, "Use the serial stamped on the cylinder"),
  sizeKg: z
    .number()
    .refine(
      (n) => (cylinderSizes as readonly number[]).includes(n),
      "Sizes are 3, 5, 6, 12.5, 25 or 50 kg",
    ),
  /** The organization, or the customer who owns it. */
  owner: z.string().trim().min(2).max(120),
  /** When its next pressure test is due. Past this it can't be filled. */
  testDueOn: isoDate,
});
export type CreateCylinderInput = z.infer<typeof createCylinderSchema>;

export const fillSchema = z.object({
  siteId: z.uuid(),
  tankId: z.uuid(),
  serial: z.string().trim().toUpperCase().min(4).max(30),
  kg: z.number().positive().max(50),
});
export type FillInput = z.infer<typeof fillSchema>;
