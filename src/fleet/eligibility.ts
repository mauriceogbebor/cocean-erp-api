import type { vehicleKinds } from "@qorrix-erp/contracts";
import { addDays } from "../common/dates.js";
import { org } from "../common/org.js";

type Vehicle = {
  status: string;
  kind: (typeof vehicleKinds)[number];
  holdReason: string | null;
};
type Doc = { kind: string; expiresOn: string };
type Driver = {
  status: string;
  licenceExpiresOn: string;
  inductedOn: string | null;
  suspendedReason: string | null;
};

/** The latest paper of each kind (renewals are new rows). */
export function latestDocs<T extends Doc & { createdAt: Date }>(docs: T[]) {
  const out = new Map<string, T>();
  for (const d of [...docs].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  ))
    out.set(d.kind, d);
  return out;
}

/**
 * Why a vehicle can't be dispatched today; empty when it can. Pure, so the
 * same answer appears on the fleet list, at planning and at loading.
 */
export function vehicleIssues(
  v: Vehicle,
  docs: Doc[],
  today: string,
  opts: { forOnboarding?: boolean } = {},
) {
  const issues: string[] = [];
  if (!opts.forOnboarding) {
    if (v.status === "onboarding" || v.status === "pending_approval")
      issues.push("Not yet approved into service");
    if (v.status === "retired") issues.push("Retired");
  }
  if (v.holdReason) issues.push(`On hold: ${v.holdReason}`);
  const latest = new Map(docs.map((d) => [d.kind, d]));
  // Papers the organization requires for this kind of vehicle.
  for (const doc of org().vehicleDocuments) {
    if (!doc.requiredFor.includes(v.kind)) continue;
    const d = latest.get(doc.key);
    if (!d) issues.push(`No ${inSentence(doc.label)} on record`);
    else if (d.expiresOn < today)
      issues.push(`${doc.label} expired on ${d.expiresOn}`);
  }
  return issues;
}

/** "Vehicle registration" → "vehicle registration"; "NMDPRA permit" stays. */
const inSentence = (label: string) =>
  /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;

export function driverIssues(d: Driver, today: string) {
  const issues: string[] = [];
  if (d.status === "suspended")
    issues.push(
      `Suspended${d.suspendedReason ? `: ${d.suspendedReason}` : ""}`,
    );
  if (d.licenceExpiresOn < today)
    issues.push(`Licence expired on ${d.licenceExpiresOn}`);
  if (!d.inductedOn) issues.push("No HSE induction on record");
  else if (addDays(d.inductedOn, org().fleet.inductionValidDays) < today)
    issues.push(`HSE induction from ${d.inductedOn} has lapsed`);
  return issues;
}

/** Papers running out within this many days are flagged on the fleet list. */
export const EXPIRING_DAYS = 30;
