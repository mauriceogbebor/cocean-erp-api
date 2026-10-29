import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import type { Actor } from "../common/auth-context.js";
import { DB } from "../common/tokens.js";

/** A database handle or an open transaction: audit rows commit with the change. */
type Executor = Pick<Db, "insert">;

export type AuditInput = {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
};

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async record(exec: Executor, actor: Actor, e: AuditInput) {
    await exec.insert(auditEvents).values({
      actorId: actor.userId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      before: e.before ?? null,
      after: e.after ?? null,
      ip: actor.ip ?? null,
      requestId: actor.requestId ?? null,
    });
  }

  /** Newest first, 50 at a time; pass the last id seen as `before` for more. */
  list(q: {
    entityType?: string;
    entityId?: string;
    actorId?: string;
    before?: number;
  }) {
    const where: SQL[] = [];
    if (q.entityType) where.push(eq(auditEvents.entityType, q.entityType));
    if (q.entityId) where.push(eq(auditEvents.entityId, q.entityId));
    if (q.actorId) where.push(eq(auditEvents.actorId, q.actorId));
    if (q.before) where.push(lt(auditEvents.id, q.before));
    return this.db
      .select()
      .from(auditEvents)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(auditEvents.id))
      .limit(50);
  }
}
