import { sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { docSequences } from "../db/schema.js";
import { lagosYear } from "./dates.js";

/**
 * The next document number for a kind, e.g. SO-2026-0001. Numbers restart
 * each year and never repeat; the row lock makes them safe under load.
 */
export async function nextNumber(tx: Tx, prefix: string, now = new Date()) {
  const year = lagosYear(now);
  const [row] = await tx
    .insert(docSequences)
    .values({ key: prefix, year, last: 1 })
    .onConflictDoUpdate({
      target: [docSequences.key, docSequences.year],
      set: { last: sql`${docSequences.last} + 1` },
    })
    .returning({ last: docSequences.last });
  return `${prefix}-${year}-${String(row.last).padStart(4, "0")}`;
}
