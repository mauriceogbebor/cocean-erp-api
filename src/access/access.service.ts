import { Inject, Injectable } from "@nestjs/common";
import type { Permission, RoleKey } from "@cocean/contracts";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  permissions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from "../db/schema.js";
import type { AuthUser } from "../common/auth-context.js";
import { DB } from "../common/tokens.js";

@Injectable()
export class AccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** An active user with their roles and the union of their permissions. */
  async loadUser(id: string): Promise<AuthUser | null> {
    const [u] = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(and(eq(users.id, id), eq(users.status, "active")))
      .limit(1);
    if (!u) return null;
    const rows = await this.db
      .select({ role: userRoles.roleKey, perm: rolePermissions.permissionKey })
      .from(userRoles)
      .leftJoin(rolePermissions, eq(rolePermissions.roleKey, userRoles.roleKey))
      .where(eq(userRoles.userId, id));
    const roleSet = new Set<RoleKey>();
    const permSet = new Set<Permission>();
    for (const r of rows) {
      roleSet.add(r.role as RoleKey);
      if (r.perm) permSet.add(r.perm as Permission);
    }
    return {
      ...u,
      roles: [...roleSet].sort(),
      permissions: [...permSet].sort(),
    };
  }

  async listRoles() {
    const rs = await this.db.select().from(roles).orderBy(asc(roles.key));
    const grants = await this.db.select().from(rolePermissions);
    return rs.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: grants
        .filter((g) => g.roleKey === r.key)
        .map((g) => g.permissionKey)
        .sort(),
    }));
  }

  listPermissions() {
    return this.db.select().from(permissions).orderBy(asc(permissions.key));
  }
}
