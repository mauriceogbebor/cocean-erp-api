/** Cocean works in West Africa Time; business dates follow Lagos, not UTC. */
const lagos = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Lagos",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's date in Lagos as YYYY-MM-DD. */
export const lagosDate = (d = new Date()) => lagos.format(d);
export const lagosYear = (d = new Date()) => Number(lagosDate(d).slice(0, 4));

const day = 86_400_000;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** A calendar date plus n days, as YYYY-MM-DD. */
export const addDays = (iso: string, n: number) =>
  new Date(utc(iso) + n * day).toISOString().slice(0, 10);

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export const daysBetween = (from: string, to: string) =>
  Math.round((utc(to) - utc(from)) / day);
