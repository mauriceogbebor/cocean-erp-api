import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
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
    createdAt: created(),
  },
  (t) => [
    index("approval_requests_status_idx").on(t.status, t.approverRole),
    index("approval_requests_ref_idx").on(t.ref),
  ],
);
