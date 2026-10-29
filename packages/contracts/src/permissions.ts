/**
 * Every action the API protects. Each endpoint requires one of these; a role
 * is a named set of them. New modules add their own keys here.
 */
export const PERMISSIONS = {
  "users.read": "See user accounts",
  "users.manage": "Create users, disable them and assign roles",
  "roles.read": "See roles and what they allow",
  "audit.read": "Read the audit trail",
  "sites.read": "See depots, stations, plants and offices",
  "sites.manage": "Create and change sites",
  "products.read": "See products",
  "products.manage": "Create and change products",
  "approvals.read": "See approval requests",
  "approvals.request": "Raise an approval request",
  "approvals.decide": "Decide approval requests routed to your role",
  "approvals.policies.manage": "Change approval limits and routing",
  "customers.read": "See customers, delivery sites and credit position",
  "customers.manage": "Create customers and sites; request credit term changes",
  "prices.read": "See price lists",
  "prices.manage": "Draft price lists and submit them for approval",
  "orders.read": "See sales orders",
  "orders.create": "Create sales orders and request credit overrides",
  "orders.cancel": "Cancel orders that haven't been released",
  "orders.release": "Release an order once payment or credit covers it",
  "finance.read": "See receipts, invoices, statements and receivables",
  "receipts.manage": "Record customer payments and reverse wrong ones",
  "invoices.create": "Invoice released orders",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const permissionKeys = Object.keys(PERMISSIONS) as Permission[];
