import { z } from "zod";

const isoDate = z.iso.date();

/** Money received from a customer, as it appears on Cocean's bank statement. */
export const createReceiptSchema = z.object({
  customerId: z.uuid(),
  amount: z.number().positive().max(1e14),
  bank: z.string().trim().min(2).max(60),
  /** The bank's own reference: session ID, teller or transfer reference. */
  bankRef: z.string().trim().toUpperCase().min(4).max(60),
  receivedOn: isoDate,
  notes: z.string().trim().max(500).optional(),
});
export type CreateReceiptInput = z.infer<typeof createReceiptSchema>;

export const receivablesQuerySchema = z.object({ asOf: isoDate.optional() });

/** Ageing buckets, by days past the due date. */
export const AGEING_BUCKETS = [
  "current",
  "1-30",
  "31-60",
  "61-90",
  "90+",
] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];
