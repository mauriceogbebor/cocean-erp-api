import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const created = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ── Identity and access ─────────────────────────────────────────────────────
export const userStatus = pgEnum("user_status", ["active", "disabled"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: userStatus("status").notNull().default("active"),
    failedLogins: integer("failed_logins").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("users_email_key").on(sql`lower(${t.email})`)],
);

export const roles = pgTable("roles", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  createdAt: created(),
});

export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  description: text("description").notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleKey: text("role_key")
      .notNull()
      .references(() => roles.key, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleKey, t.permissionKey] })],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleKey: text("role_key")
      .notNull()
      .references(() => roles.key),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleKey] })],
);

/** Refresh-token sessions. Only a hash of the token is stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedBy: uuid("replaced_by"),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_idx").on(t.userId),
  ],
);

// ── Audit trail (append-only: a trigger refuses UPDATE and DELETE) ──────────
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    requestId: text("request_id"),
  },
  (t) => [
    index("audit_entity_idx").on(t.entityType, t.entityId),
    index("audit_actor_idx").on(t.actorId),
    index("audit_at_idx").on(t.at),
  ],
);

// ── Master data ─────────────────────────────────────────────────────────────
export const siteKind = pgEnum("site_kind", [
  "depot",
  "station",
  "lpg_plant",
  "office",
  "workshop",
]);

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: siteKind("kind").notNull(),
    state: text("state").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("sites_code_key").on(t.code)],
);

export const products = pgTable("products", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  unit: text("unit").notNull(),
  density: numeric("density", { precision: 6, scale: 4 }),
  /** VAT charged on sale, e.g. 0.075. Zero until Cocean's tax adviser confirms each product. */
  vatRate: numeric("vat_rate", { precision: 5, scale: 4 })
    .notNull()
    .default("0"),
  active: boolean("active").notNull().default(true),
  createdAt: created(),
  updatedAt: updated(),
});

// ── Approvals: routed by kind and amount; maker can never decide ───────────
export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
]);

export const approvalPolicies = pgTable(
  "approval_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    minAmount: numeric("min_amount", { precision: 18, scale: 2 }).notNull(),
    maxAmount: numeric("max_amount", { precision: 18, scale: 2 }),
    approverRole: text("approver_role")
      .notNull()
      .references(() => roles.key),
    active: boolean("active").notNull().default(true),
    createdAt: created(),
  },
  (t) => [index("approval_policies_kind_idx").on(t.kind)],
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    title: text("title").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("NGN"),
    reason: text("reason").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    approverRole: text("approver_role")
      .notNull()
      .references(() => roles.key),
    policyId: uuid("policy_id").references(() => approvalPolicies.id),
    status: approvalStatus("status").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    /** What approving applies, e.g. the new credit terms. Read by the handler. */
    payload: jsonb("payload"),
    createdAt: created(),
  },
  (t) => [
    index("approval_requests_status_idx").on(t.status, t.approverRole),
    index("approval_requests_ref_idx").on(t.ref),
  ],
);

// ── Document numbers: SO-2026-0001, per kind and year ───────────────────────
export const docSequences = pgTable(
  "doc_sequences",
  {
    key: text("key").notNull(),
    year: integer("year").notNull(),
    last: integer("last").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.year] })],
);

// ── Customers ───────────────────────────────────────────────────────────────
export const customerKind = pgEnum("customer_kind", [
  "industrial",
  "reseller",
  "station_operator",
  "government",
]);
export const creditTerms = pgEnum("credit_terms", ["prepaid", "credit"]);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: customerKind("kind").notNull(),
    /** Changed only by an approved credit_limit request. */
    terms: creditTerms("terms").notNull().default("prepaid"),
    creditLimit: numeric("credit_limit", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    creditDays: integer("credit_days").notNull().default(0),
    tin: text("tin"),
    email: text("email"),
    phone: text("phone"),
    address: text("address").notNull(),
    /** Migrated receivable; Finance's ledger takes over from it. */
    openingBalance: numeric("opening_balance", { precision: 18, scale: 2 })
      .notNull()
      .default("0"),
    active: boolean("active").notNull().default(true),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("customers_code_key").on(t.code)],
);

/** Delivery points, each with the receiver who confirms deliveries there. */
export const customerSites = pgTable(
  "customer_sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    name: text("name").notNull(),
    address: text("address").notNull(),
    state: text("state").notNull(),
    receiverName: text("receiver_name").notNull(),
    receiverPhone: text("receiver_phone").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: created(),
  },
  (t) => [index("customer_sites_customer_idx").on(t.customerId)],
);

// ── Price lists: drafted, approved by someone else, then in force ──────────
export const priceListStatus = pgEnum("price_list_status", [
  "draft",
  "pending",
  "approved",
]);

export const priceLists = pgTable(
  "price_lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    validFrom: date("valid_from").notNull(),
    status: priceListStatus("status").notNull().default("draft"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("price_lists_code_key").on(t.code)],
);

export const priceListLines = pgTable(
  "price_list_lines",
  {
    priceListId: uuid("price_list_id")
      .notNull()
      .references(() => priceLists.id, { onDelete: "cascade" }),
    productCode: text("product_code")
      .notNull()
      .references(() => products.code),
    price: numeric("price", { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.priceListId, t.productCode] })],
);

// ── Sales orders ────────────────────────────────────────────────────────────
export const orderStatus = pgEnum("order_status", [
  "awaiting_payment",
  "credit_hold",
  "override_pending",
  "released",
  "cancelled",
  "invoiced",
]);

export const salesOrders = pgTable(
  "sales_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    poRef: text("po_ref").notNull(),
    requestRef: text("request_ref"),
    notes: text("notes"),
    /** The customer's terms when the order was taken. */
    terms: creditTerms("terms").notNull(),
    status: orderStatus("status").notNull(),
    priceListId: uuid("price_list_id")
      .notNull()
      .references(() => priceLists.id),
    total: numeric("total", { precision: 18, scale: 2 }).notNull(),
    /** Credit check at entry: balance owed, limit, and exposure with this order. */
    creditCheck: jsonb("credit_check"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    cancelledReason: text("cancelled_reason"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("sales_orders_number_key").on(t.number),
    index("sales_orders_customer_idx").on(t.customerId, t.status),
  ],
);

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => salesOrders.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    productCode: text("product_code")
      .notNull()
      .references(() => products.code),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    unit: text("unit").notNull(),
    /** Copied from the price list in force; never typed. */
    unitPrice: numeric("unit_price", { precision: 18, scale: 2 }).notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    deliverySiteId: uuid("delivery_site_id")
      .notNull()
      .references(() => customerSites.id),
  },
  (t) => [uniqueIndex("sales_order_lines_no_key").on(t.orderId, t.lineNo)],
);

// ── Receivables: receipts, invoices and the customer ledger ────────────────
export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    bank: text("bank").notNull(),
    bankRef: text("bank_ref").notNull(),
    receivedOn: date("received_on").notNull(),
    notes: text("notes"),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
    reversalReason: text("reversal_reason"),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("receipts_number_key").on(t.number),
    /** One bank transaction is recorded once, whoever records it. */
    uniqueIndex("receipts_bank_ref_key").on(t.bank, t.bankRef),
    index("receipts_customer_idx").on(t.customerId),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => salesOrders.id),
    issuedOn: date("issued_on").notNull(),
    dueOn: date("due_on").notNull(),
    subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull(),
    vat: numeric("vat", { precision: 18, scale: 2 }).notNull(),
    total: numeric("total", { precision: 18, scale: 2 }).notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("invoices_number_key").on(t.number),
    /** One invoice per order until deliveries split them (Phase 3). */
    uniqueIndex("invoices_order_key").on(t.orderId),
    index("invoices_customer_idx").on(t.customerId),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    productCode: text("product_code")
      .notNull()
      .references(() => products.code),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    unit: text("unit").notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 2 }).notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 4 }).notNull(),
    vat: numeric("vat", { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.invoiceId, t.lineNo] })],
);

export const ledgerKind = pgEnum("ledger_kind", [
  "opening",
  "invoice",
  "receipt",
  "receipt_reversal",
]);

/**
 * Every naira a customer owes or has paid, as signed entries: invoices add,
 * receipts subtract. The balance is the sum. Append-only (trigger), so a
 * mistake is corrected by a new entry, never by changing an old one.
 */
export const customerLedger = pgTable(
  "customer_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    kind: ledgerKind("kind").notNull(),
    /** The document's number: INV-…, RCT-…, or OPENING. */
    ref: text("ref").notNull(),
    docId: uuid("doc_id"),
    entryDate: date("entry_date").notNull(),
    /** Positive: the customer owes more. Negative: money in. */
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    /** For invoices: when it falls due. */
    dueOn: date("due_on"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: created(),
  },
  (t) => [index("customer_ledger_customer_idx").on(t.customerId, t.entryDate)],
);

// ── Procurement: suppliers, purchase orders, goods received, supplier bills ─
export const vendorBankStatus = pgEnum("vendor_bank_status", [
  "none",
  "pending",
  "verified",
]);

export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    tin: text("tin"),
    email: text("email"),
    phone: text("phone"),
    address: text("address").notNull(),
    /** Only ever set by an approved vendor_bank request. */
    bankName: text("bank_name"),
    accountNumber: text("account_number"),
    accountName: text("account_name"),
    bankStatus: vendorBankStatus("bank_status").notNull().default("none"),
    bankVerifiedAt: timestamp("bank_verified_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("vendors_code_key").on(t.code)],
);

export const poStatus = pgEnum("po_status", [
  "draft",
  "pending",
  "approved",
  "partially_received",
  "received",
  "cancelled",
]);

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id),
    status: poStatus("status").notNull().default("draft"),
    justification: text("justification").notNull(),
    quoteRef: text("quote_ref"),
    subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull(),
    vat: numeric("vat", { precision: 18, scale: 2 }).notNull(),
    total: numeric("total", { precision: 18, scale: 2 }).notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    cancelledReason: text("cancelled_reason"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("purchase_orders_number_key").on(t.number),
    index("purchase_orders_vendor_idx").on(t.vendorId, t.status),
  ],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poId: uuid("po_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    productCode: text("product_code").references(() => products.code),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    unit: text("unit").notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 2 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 4 }).notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    vat: numeric("vat", { precision: 18, scale: 2 }).notNull(),
    received: numeric("received", { precision: 14, scale: 3 })
      .notNull()
      .default("0"),
    /** Quantity on matched supplier bills. */
    billed: numeric("billed", { precision: 14, scale: 3 })
      .notNull()
      .default("0"),
  },
  (t) => [uniqueIndex("purchase_order_lines_no_key").on(t.poId, t.lineNo)],
);

export const goodsReceipts = pgTable(
  "goods_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    poId: uuid("po_id")
      .notNull()
      .references(() => purchaseOrders.id),
    receivedOn: date("received_on").notNull(),
    deliveryNote: text("delivery_note").notNull(),
    notes: text("notes"),
    receivedBy: uuid("received_by")
      .notNull()
      .references(() => users.id),
    createdAt: created(),
  },
  (t) => [uniqueIndex("goods_receipts_number_key").on(t.number)],
);

export const goodsReceiptLines = pgTable(
  "goods_receipt_lines",
  {
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: "cascade" }),
    poLineId: uuid("po_line_id")
      .notNull()
      .references(() => purchaseOrderLines.id),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.receiptId, t.poLineId] })],
);

export const billStatus = pgEnum("bill_status", [
  "matched",
  "exception",
  "payment_pending",
  "approved",
  "paid",
  "void",
]);

export const supplierBills = pgTable(
  "supplier_bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    poId: uuid("po_id")
      .notNull()
      .references(() => purchaseOrders.id),
    vendorInvoiceNo: text("vendor_invoice_no").notNull(),
    invoiceDate: date("invoice_date").notNull(),
    statedTotal: numeric("stated_total", { precision: 18, scale: 2 }).notNull(),
    subtotal: numeric("subtotal", { precision: 18, scale: 2 }).notNull(),
    vat: numeric("vat", { precision: 18, scale: 2 }).notNull(),
    total: numeric("total", { precision: 18, scale: 2 }).notNull(),
    status: billStatus("status").notNull(),
    /** Why it didn't match: one line per problem. Empty when matched. */
    exceptions: jsonb("exceptions").$type<string[]>().notNull(),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    /** The bank details the payment was approved against. */
    payTo: jsonb("pay_to").$type<{
      bankName: string;
      accountNumber: string;
      accountName: string;
    }>(),
    paymentRef: text("payment_ref"),
    paidOn: date("paid_on"),
    paidBy: uuid("paid_by").references(() => users.id),
    voidReason: text("void_reason"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex("supplier_bills_number_key").on(t.number),
    /** A supplier's invoice is entered once. */
    uniqueIndex("supplier_bills_vendor_invoice_key").on(
      t.vendorId,
      t.vendorInvoiceNo,
    ),
  ],
);

export const supplierBillLines = pgTable(
  "supplier_bill_lines",
  {
    billId: uuid("bill_id")
      .notNull()
      .references(() => supplierBills.id, { onDelete: "cascade" }),
    poLineId: uuid("po_line_id")
      .notNull()
      .references(() => purchaseOrderLines.id),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 2 }).notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    vat: numeric("vat", { precision: 18, scale: 2 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.billId, t.poLineId] })],
);
