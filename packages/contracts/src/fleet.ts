import { z } from "zod";

const isoDate = z.iso.date();
const phone = z
  .string()
  .trim()
  .regex(/^\+?[\d ()-]{7,20}$/, "Enter a phone number");
/** Checked against the organization's plate format after this. */
export const plateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9 -]{1,14}$/, "Enter the number plate")
  // "riv 430 bn" and "RIV-430-BN" are the same plate.
  .transform((p) => p.replace(/[\s-]+/g, "-"));

export const vehicleKinds = [
  "tanker",
  "lpg_bridger",
  "flatbed",
  "other",
] as const;
/** Defaults; each organization sets its own in its settings. */
export const FLEET_RULES = {
  /** A driver's HSE induction is valid this many days. */
  inductionValidDays: 365,
  /** A tracker that hasn't reported for this long is shown as stale. */
  trackerStaleMinutes: 15,
  /** A truck is due a service this many days after the last one... */
  serviceIntervalDays: 90,
  /** ...or after this many kilometres, whichever comes first. */
  serviceIntervalKm: 10_000,
  /** A finished job may cost this much over its estimate before it needs approving again. */
  workOrderOverrunPct: 0.1,
} as const;

export const createVehicleSchema = z
  .object({
    plate: plateSchema,
    kind: z.enum(vehicleKinds),
    /** Litres for tankers, kilograms for LPG bridgers. */
    capacity: z.number().positive().max(100_000),
    /** Each compartment's capacity, front to back. They must add up to the capacity. */
    compartments: z.array(z.number().positive()).max(8).optional(),
    ownership: z.enum(["owned", "transporter"]),
    transporterName: z.string().trim().min(3).max(200).optional(),
    trackerId: z.string().trim().min(3).max(60).optional(),
  })
  .refine((v) => v.ownership === "owned" || !!v.transporterName, {
    message: "Name the transporter who owns it",
    path: ["transporterName"],
  })
  .refine(
    (v) =>
      !v.compartments?.length ||
      Math.abs(v.compartments.reduce((a, c) => a + c, 0) - v.capacity) < 0.5,
    {
      message: "Compartments must add up to the capacity",
      path: ["compartments"],
    },
  );
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;

export const vehicleDocumentSchema = z.object({
  /** One of the organization's vehicle document keys. */
  kind: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,39}$/),
  number: z.string().trim().min(3).max(60),
  issuer: z.string().trim().min(2).max(120),
  expiresOn: isoDate,
});
export type VehicleDocumentInput = z.infer<typeof vehicleDocumentSchema>;

export const createDriverSchema = z.object({
  name: z.string().trim().min(3).max(120),
  phone,
  licenceNumber: z.string().trim().toUpperCase().min(6).max(30),
  licenceExpiresOn: isoDate,
  /** Date of the last HSE induction. Without one the driver can't be dispatched. */
  inductedOn: isoDate.optional(),
  /** The transporter they drive for; blank for the organization's own drivers. */
  employer: z.string().trim().max(200).optional(),
});
export type CreateDriverInput = z.infer<typeof createDriverSchema>;

export const updateDriverSchema = z
  .object({
    phone,
    licenceNumber: z.string().trim().toUpperCase().min(6).max(30),
    licenceExpiresOn: isoDate,
    inductedOn: isoDate,
  })
  .partial();

/** Positions from the tracker provider, by the tracker's own id. */
export const trackerPingsSchema = z.object({
  pings: z
    .array(
      z.object({
        trackerId: z.string().trim().min(3).max(60),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        speedKph: z.number().min(0).max(250).optional(),
        recordedAt: z.iso.datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(500),
});
export type TrackerPingsInput = z.infer<typeof trackerPingsSchema>;
