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
