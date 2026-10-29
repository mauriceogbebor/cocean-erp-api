import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import type { CreateUserInput, RoleKey } from "@cocean/contracts";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions, userRoles, users } from "../db/schema.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../common/auth-context.js";
import { DB } from "../common/tokens.js";

const publicFields = {
  id: users.id,
  email: users.email,
  name: users.name,
  status: users.status,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
};

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list() {
    const us = await this.db
      .select(publicFields)
      .from(users)
      .orderBy(asc(users.name));
    const rs = await this.db.select().from(userRoles);
    return us.map((u) => ({
      ...u,
      roles: rs
        .filter((r) => r.userId === u.id)
        .map((r) => r.roleKey)
        .sort(),
    }));
  }

  async create(input: CreateUserInput, actor: Actor) {
    const [dup] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email}`)
      .limit(1);
    if (dup)
      throw new ConflictException("A user with this email already exists");
    const passwordHash = await hash(input.password);
    return this.db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash })
        .returning(publicFields);
      await tx
        .insert(userRoles)
        .values(input.roles.map((roleKey) => ({ userId: u.id, roleKey })));
      const after = { ...u, roles: [...input.roles].sort() };
      await this.audit.record(tx, actor, {
        action: "user.created",
        entityType: "user",
        entityId: u.id,
        after,
      });
      return after;
    });
  }

  async setRoles(id: string, next: RoleKey[], actor: Actor) {
    if (actor.userId === id && !next.includes("admin"))
      throw new BadRequestException(
        "You can't remove your own administrator role",
      );
    return this.db.transaction(async (tx) => {
      const [u] = await tx
        .select(publicFields)
        .from(users)
        .where(eq(users.id, id));
      if (!u) throw new NotFoundException("User not found");
      const before = (
        await tx.select().from(userRoles).where(eq(userRoles.userId, id))
      )
        .map((r) => r.roleKey)
        .sort();
      await tx.delete(userRoles).where(eq(userRoles.userId, id));
      if (next.length)
        await tx
          .insert(userRoles)
          .values(next.map((roleKey) => ({ userId: id, roleKey })));
      const after = [...new Set(next)].sort();
      await this.audit.record(tx, actor, {
        action: "user.roles_changed",
        entityType: "user",
        entityId: id,
        before: { roles: before },
        after: { roles: after },
      });
      return { ...u, roles: after };
    });
  }

  async setStatus(id: string, status: "active" | "disabled", actor: Actor) {
    if (actor.userId === id && status === "disabled")
      throw new BadRequestException("You can't disable your own account");
    return this.db.transaction(async (tx) => {
      const [u] = await tx
        .update(users)
        .set({ status, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning(publicFields);
      if (!u) throw new NotFoundException("User not found");
      // Disabling signs the person out everywhere.
      if (status === "disabled")
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(eq(sessions.userId, id));
      await this.audit.record(tx, actor, {
        action: status === "disabled" ? "user.disabled" : "user.enabled",
        entityType: "user",
        entityId: id,
      });
      return u;
    });
  }
}
