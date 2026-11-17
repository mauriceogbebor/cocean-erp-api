import { org } from "./org.js";

/**
 * Business dates (today, overdue, expired) follow the organization's time
 * zone, not the server's or UTC.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (timeZone: string) => {
  let f = formatters.get(timeZone);
  if (!f)
    formatters.set(
      timeZone,
      (f = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })),
    );
  return f;
};

/** Today's date where the organization is, as YYYY-MM-DD. */
export const businessDate = (d = new Date()) =>
  formatter(org().timeZone).format(d);
export const businessYear = (d = new Date()) =>
  Number(businessDate(d).slice(0, 4));

const day = 86_400_000;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** A calendar date plus n days, as YYYY-MM-DD. */
export const addDays = (iso: string, n: number) =>
  new Date(utc(iso) + n * day).toISOString().slice(0, 10);

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export const daysBetween = (from: string, to: string) =>
  Math.round((utc(to) - utc(from)) / day);
