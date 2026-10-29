import { pathToFileURL } from "node:url";
import { hash } from "@node-rs/argon2";
import {
  DEFAULT_POLICIES,
  PERMISSIONS,
  ROLES,
  type RoleKey,
} from "@cocean/contracts";
import { eq, sql } from "drizzle-orm";
import { createDb, type Db } from "./client.js";
import {
  approvalPolicies,
  permissions,
  products,
  rolePermissions,
  roles,
  userRoles,
  users,
} from "./schema.js";

/** Product reference data. Densities are placeholders until Cocean confirms its source. */
const PRODUCTS = [
  {
    code: "AGO",
    name: "Automotive gas oil (diesel)",
    unit: "L",
    density: "0.8320",
  },
  {
    code: "PMS",
    name: "Premium motor spirit (petrol)",
    unit: "L",
    density: "0.7400",
  },
  { code: "DPK", name: "Dual-purpose kerosene", unit: "L", density: "0.8000" },
  { code: "LPG", name: "Liquefied petroleum gas", unit: "kg", density: null },
  { code: "BIT", name: "Bitumen", unit: "kg", density: null },
];

/**
 * Brings the reference data in line with @cocean/contracts. Safe to run again:
 * roles and permissions are upserted, role grants are replaced, and policies
 * and products are only inserted when missing so changes made in the app stay.
 */
export async function seed(
  db: Db,
  admin?: { email: string; password: string; name?: string },
) {
  await db.transaction(async (tx) => {
    for (const [key, description] of Object.entries(PERMISSIONS))
      await tx
        .insert(permissions)
        .values({ key, description })
        .onConflictDoUpdate({ target: permissions.key, set: { description } });

    for (const [key, role] of Object.entries(ROLES)) {
      await tx
        .insert(roles)
        .values({ key, name: role.name, description: role.description })
        .onConflictDoUpdate({
          target: roles.key,
          set: { name: role.name, description: role.description },
        });
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleKey, key));
      if (role.permissions.length)
        await tx
          .insert(rolePermissions)
          .values(
            role.permissions.map((p) => ({ roleKey: key, permissionKey: p })),
          );
    }

    // Bands are added only for kinds that have none yet, so limits Cocean
    // changes in the app are kept and new kinds still get a starting band.
    const have = new Set(
      (
        await tx
          .selectDistinct({ kind: approvalPolicies.kind })
          .from(approvalPolicies)
      ).map((r) => r.kind),
    );
    const missing = DEFAULT_POLICIES.filter((p) => !have.has(p.kind));
    if (missing.length)
      await tx.insert(approvalPolicies).values(
        missing.map((p) => ({
          kind: p.kind,
          minAmount: String(p.min),
          maxAmount: p.max === null ? null : String(p.max),
          approverRole: p.approver,
        })),
      );

    await tx.insert(products).values(PRODUCTS).onConflictDoNothing();

    if (admin) {
      const existing = await tx
        .select({ id: userRoles.userId })
        .from(userRoles)
        .where(eq(userRoles.roleKey, "admin" satisfies RoleKey))
        .limit(1);
      if (!existing.length) {
        const [u] = await tx
          .insert(users)
          .values({
            email: admin.email.toLowerCase(),
            name: admin.name ?? "System administrator",
            passwordHash: await hash(admin.password),
          })
          .returning({ id: users.id });
        await tx.insert(userRoles).values({ userId: u.id, roleKey: "admin" });
      }
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (password && password.length < 12)
    throw new Error("SEED_ADMIN_PASSWORD must be at least 12 characters");
  const { db, pool } = createDb(url);
  seed(db, email && password ? { email, password } : undefined)
    .then(() => console.log("Reference data seeded"))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => pool.end());
}
