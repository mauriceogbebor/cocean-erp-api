/** Money is worked in kobo (integers) and stored in naira with two decimals. */
export const kobo = (n: number | string) => Math.round(Number(n) * 100);
export const toNaira = (k: number) => (k / 100).toFixed(2);
export const naira = (n: number) =>
  `₦${n.toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;

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
