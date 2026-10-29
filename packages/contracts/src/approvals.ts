import type { RoleKey } from "./roles";

/** Kinds of request that need a second person's decision. */
export const APPROVAL_KINDS = {
  credit_override: "Order above a customer's credit limit",
  purchase_order: "Purchase order",
  supplier_payment: "Supplier payment",
  work_order: "Workshop work order",
  truck_onboarding: "New truck into service",
  payroll: "Monthly payroll",
  variance: "Stock or cash variance",
  credit_limit: "Change to a customer's credit terms or limit",
  price_list: "Price list",
  vendor_bank: "Supplier bank details",
} as const;
export type ApprovalKind = keyof typeof APPROVAL_KINDS;
export const approvalKinds = Object.keys(APPROVAL_KINDS) as [
  ApprovalKind,
  ...ApprovalKind[],
];

/**
 * Starting authority bands, in naira. Placeholders from the prototype: Cocean
 * sets the real limits, and they are stored in the database so they can be
 * changed without a release. A band applies when min <= amount < max.
 */
export type PolicyDef = {
  kind: ApprovalKind;
  min: number;
  max: number | null;
  approver: RoleKey;
};

export const DEFAULT_POLICIES: PolicyDef[] = [
  { kind: "credit_override", min: 0, max: null, approver: "md" },
  { kind: "purchase_order", min: 0, max: 5_000_000, approver: "finance" },
  {
    kind: "purchase_order",
    min: 5_000_000,
    max: 25_000_000,
    approver: "executive",
  },
  { kind: "purchase_order", min: 25_000_000, max: null, approver: "md" },
  { kind: "supplier_payment", min: 0, max: 25_000_000, approver: "finance" },
  { kind: "supplier_payment", min: 25_000_000, max: null, approver: "md" },
  { kind: "work_order", min: 0, max: 1_000_000, approver: "operations" },
  { kind: "work_order", min: 1_000_000, max: null, approver: "executive" },
  { kind: "truck_onboarding", min: 0, max: null, approver: "executive" },
  { kind: "payroll", min: 0, max: null, approver: "md" },
  { kind: "variance", min: 0, max: null, approver: "operations" },
  { kind: "credit_limit", min: 0, max: 50_000_000, approver: "finance" },
  { kind: "credit_limit", min: 50_000_000, max: null, approver: "md" },
  { kind: "price_list", min: 0, max: null, approver: "md" },
  { kind: "vendor_bank", min: 0, max: null, approver: "finance" },
];
