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
