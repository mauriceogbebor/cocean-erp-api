import type { PayrollRules } from "@qorrix-erp/contracts";

/**
 * One person's pay for one month, worked in minor units (kobo) so nothing is
 * lost to rounding. Pure: the rules come from the organization's settings and
 * are saved with the run, so a run can always be explained afterwards.
 *
 * PAYE is worked on the full month's pay, annualised: gross less the
 * employee's pension and housing fund, less rent relief, through the tax
 * bands, then divided by twelve. Someone who joined or left during the month
 * gets that share of everything.
 */
export type PayInputs = {
  basic: number;
  housing: number;
  transport: number;
  other: number;
  nhfOptIn: boolean;
  annualRent: number;
  startDate: string;
  exitDate: string | null;
};

export type PayLine = {
  factor: number;
  basic: number;
  housing: number;
  transport: number;
  other: number;
  gross: number;
  pensionEmployee: number;
  nhf: number;
  rentRelief: number;
  paye: number;
  net: number;
  pensionEmployer: number;
  nsitf: number;
  itf: number;
  joiner: boolean;
  leaver: boolean;
};

const k = (n: number) => Math.round(n * 100);
const major = (kobo: number) => kobo / 100;
const DAY = 86_400_000;
const utc = (d: string) =>
  Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

/** First and last day of a YYYY-MM period, and its length in days. */
export function monthOf(period: string) {
  const y = +period.slice(0, 4);
  const m = +period.slice(5, 7);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = `${period}-01`;
  const last = `${period}-${String(days).padStart(2, "0")}`;
  return { first, last, days };
}

/** Tax on annual chargeable income (kobo) through the bands, in kobo. */
export function annualTax(chargeable: number, bands: PayrollRules["taxBands"]) {
  let left = chargeable;
  let tax = 0;
  for (const b of bands) {
    if (left <= 0) break;
    const slice = b.width === null ? left : Math.min(left, k(b.width));
    tax += slice * b.rate;
    left -= slice;
  }
  return Math.round(tax);
}

/** Null when the person wasn't employed on any day of the period. */
export function calcPay(
  p: PayInputs,
  period: string,
  rules: PayrollRules,
): PayLine | null {
  const { first, last, days } = monthOf(period);
  const from = p.startDate > first ? p.startDate : first;
  const to = p.exitDate && p.exitDate < last ? p.exitDate : last;
  if (to < from) return null;
  const worked = Math.round((utc(to) - utc(from)) / DAY) + 1;
  const factor = Math.round((worked / days) * 10_000) / 10_000;
  const share = (n: number) => Math.round(n * factor);

  // The full month, as if they had worked all of it.
  const basic = k(p.basic);
  const housing = k(p.housing);
  const transport = k(p.transport);
  const other = k(p.other);
  const gross = basic + housing + transport + other;
  const pensionable = basic + housing + transport;
  const pensionEmployee = Math.round(pensionable * rules.pensionEmployeePct);
  const pensionEmployer = Math.round(pensionable * rules.pensionEmployerPct);
  const nhf = p.nhfOptIn ? Math.round(basic * rules.nhfPct) : 0;
  const rentRelief = Math.min(
    Math.round(k(p.annualRent) * rules.rentReliefPct),
    k(rules.rentReliefCap),
  );
  const chargeable = Math.max(
    0,
    12 * (gross - pensionEmployee - nhf) - rentRelief,
  );
  const paye =
    gross <= k(rules.taxFreeMonthlyGross)
      ? 0
      : Math.round(annualTax(chargeable, rules.taxBands) / 12);

  // This month's share.
  const parts = {
    basic: share(basic),
    housing: share(housing),
    transport: share(transport),
    other: share(other),
  };
  const g = parts.basic + parts.housing + parts.transport + parts.other;
  const line = {
    ...parts,
    gross: g,
    pensionEmployee: share(pensionEmployee),
    nhf: share(nhf),
    rentRelief: share(Math.round(rentRelief / 12)),
    paye: share(paye),
    pensionEmployer: share(pensionEmployer),
    nsitf: Math.round(g * rules.nsitfPct),
    itf: Math.round(g * rules.itfPct),
  };
  const net = line.gross - line.pensionEmployee - line.nhf - line.paye;
  return {
    factor,
    ...(Object.fromEntries(
      Object.entries({ ...line, net }).map(([key, v]) => [key, major(v)]),
    ) as Omit<PayLine, "factor" | "joiner" | "leaver">),
    joiner: p.startDate > first,
    leaver: !!p.exitDate && p.exitDate < last,
  };
}
