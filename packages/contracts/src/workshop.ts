import { z } from "zod";

// ── Workshop: work orders, repair costs and servicing ───────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const money = z.number().min(0).max(1e11);

export const workOrderKinds = [
  "repair",
  "service",
  "tyres",
  "accident",
  "inspection",
] as const;
export type WorkOrderKind = (typeof workOrderKinds)[number];

/**
 * draft: opened, being looked at and priced.
 * submitted: estimate waiting for approval.
 * approved: work can go ahead.
 * rejected: estimate turned down; price it again or cancel.
 * overrun: finished, but cost more than the estimate allows; waiting for approval.
 * completed, cancelled: closed.
 */
export const workOrderStatuses = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "overrun",
  "completed",
  "cancelled",
] as const;
export type WorkOrderStatus = (typeof workOrderStatuses)[number];
export const OPEN_WORK_ORDER: WorkOrderStatus[] = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "overrun",
];

export const workLineKinds = ["part", "labour", "outside"] as const;
export type WorkLineKind = (typeof workLineKinds)[number];

export const workLineSchema = z.object({
  kind: z.enum(workLineKinds),
  description: z.string().trim().min(2).max(160),
  quantity: z.number().positive().max(10_000),
  unitCost: money,
});
export type WorkLine = z.infer<typeof workLineSchema>;

const lines = z
  .array(workLineSchema)
  .min(1, "Add at least one part, labour or outside job")
  .max(40);

export const createWorkOrderSchema = z.object({
  vehicleId: z.string().uuid(),
  kind: z.enum(workOrderKinds),
  title: z.string().trim().min(5, "Say what's wrong or what's due").max(120),
  description: z.string().trim().max(1000).optional(),
  /** Keep the truck off the road until the work is done. */
  offRoad: z.boolean().default(true),
  odometerKm: z.number().int().min(0).max(5_000_000).optional(),
});
export type CreateWorkOrderInput = z.input<typeof createWorkOrderSchema>;

export const submitWorkOrderSchema = z.object({
  lines,
  /** The outside workshop doing the job, if not done in-house. */
  supplierName: z.string().trim().min(2).max(120).optional(),
  note: z.string().trim().max(500).optional(),
});
export type SubmitWorkOrderInput = z.input<typeof submitWorkOrderSchema>;

export const completeWorkOrderSchema = z.object({
  /** What the job actually cost. */
  lines,
  completedOn: isoDate,
  odometerKm: z.number().int().min(0).max(5_000_000).optional(),
  /** Required when the cost is over what the estimate allows. */
  note: z.string().trim().max(500).optional(),
});
export type CompleteWorkOrderInput = z.input<typeof completeWorkOrderSchema>;

export const cancelWorkOrderSchema = z.object({
  reason: z.string().trim().min(5, "Say why it's cancelled").max(300),
});
export type CancelWorkOrderInput = z.infer<typeof cancelWorkOrderSchema>;

export const workshopCostsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/** Totals by kind of line. */
export function lineTotals(ls: WorkLine[]) {
  const t = { part: 0, labour: 0, outside: 0, total: 0 };
  for (const l of ls) {
    const v = Math.round(l.quantity * l.unitCost * 100) / 100;
    t[l.kind] += v;
    t.total += v;
  }
  for (const k of Object.keys(t) as (keyof typeof t)[])
    t[k] = Math.round(t[k] * 100) / 100;
  return t;
}
