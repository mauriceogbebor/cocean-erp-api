/**
 * Money is worked in minor units (kobo for naira, cents for dollars) as
 * integers, and stored in major units with two decimals.
 */
export const kobo = (n: number | string) => Math.round(Number(n) * 100);
export const toMajor = (k: number) => (k / 100).toFixed(2);

/** A priced line: amount = quantity × price, VAT on top at the line's rate. */
export const priceLine = (
  quantity: number,
  unitPrice: number,
  vatRate: number,
) => {
  const amount = Math.round(quantity * kobo(unitPrice));
  const vat = Math.round(amount * vatRate);
  return { amount, vat };
};
