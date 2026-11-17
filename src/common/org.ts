import {
  DEFAULT_ORGANIZATION,
  type FormatKey,
  type OrganizationSettings,
} from "@qorrix-erp/contracts";

/**
 * The organization this installation serves, as last loaded by
 * OrganizationService. Plain functions read it so that dates, money and
 * tolerances follow the organization's settings everywhere.
 */
let current: OrganizationSettings = DEFAULT_ORGANIZATION;
const patterns = new Map<string, RegExp>();

export const org = () => current;
export const setOrg = (s: OrganizationSettings) => {
  current = s;
  patterns.clear();
};

/** An amount in the organization's currency, e.g. ₦1,250,000. */
export const money = (n: number) =>
  `${current.currency.symbol}${n.toLocaleString(current.locale, { maximumFractionDigits: 2 })}`;

/** A quantity in the organization's number format. */
export const num = (n: number) => n.toLocaleString(current.locale);

/** Whether a value follows one of the organization's formats. */
export function matchesFormat(key: FormatKey, value: string) {
  const f = current.formats[key];
  let re = patterns.get(f.pattern);
  if (!re) patterns.set(f.pattern, (re = new RegExp(f.pattern)));
  return re.test(value);
}
