import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { hash, verify } from "@node-rs/argon2";
import type { LoginInput } from "@cocean/contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { AccessService } from "../access/access.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../common/auth-context.js";
import { DB, ENV } from "../common/tokens.js";
import type { Env } from "../config/env.js";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
// Verified against when the email is unknown, so timing doesn't reveal it.
const DUMMY_HASH = hash("not-a-real-password-for-timing");

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async login(input: LoginInput, actor: Actor, userAgent?: string) {
    const [u] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${input.email}`)
      .limit(1);
    const bad = new UnauthorizedException("Email or password is incorrect");
    if (!u) {
      await verify(await DUMMY_HASH, input.password).catch(() => false);
      throw bad;
    }
    if (u.status !== "active")
      throw new UnauthorizedException("This account is disabled");
    if (u.lockedUntil && u.lockedUntil > new Date())
      throw new UnauthorizedException(
        "Too many failed attempts. Try again in 15 minutes or ask an administrator.",
      );

    const ok = await verify(u.passwordHash, input.password).catch(() => false);
    if (!ok) {
      const failed = u.failedLogins + 1;
      const lock = failed >= MAX_FAILED;
      await this.db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({
            failedLogins: lock ? 0 : failed,
            lockedUntil: lock
              ? new Date(Date.now() + LOCK_MINUTES * 60_000)
              : null,
          })
          .where(eq(users.id, u.id));
        await this.audit.record(
          tx,
          { ...actor, userId: u.id },
          {
            action: lock ? "auth.locked" : "auth.failed",
            entityType: "user",
            entityId: u.id,
          },
        );
      });
      throw bad;
    }

    return this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, u.id));
      await this.audit.record(
        tx,
        { ...actor, userId: u.id },
        {
          action: "auth.login",
          entityType: "user",
          entityId: u.id,
        },
      );
      return this.issue(tx, u.id, actor, userAgent);
    });
  }

  /**
   * Swaps a refresh token for a new pair. Each token works once; presenting
   * one that was already used revokes every session for that user.
   */
  async refresh(token: string, actor: Actor, userAgent?: string) {
    const [s] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, sha256(token)))
      .limit(1);
    const expired = new UnauthorizedException(
      "Your session has expired. Sign in again.",
    );
    if (!s) throw expired;
    if (s.revokedAt) {
      if (s.replacedBy) {
        await this.db.transaction(async (tx) => {
          await tx
            .update(sessions)
            .set({ revokedAt: new Date() })
            .where(
              and(eq(sessions.userId, s.userId), isNull(sessions.revokedAt)),
            );
          await this.audit.record(
            tx,
            { ...actor, userId: s.userId },
            {
              action: "auth.refresh_reuse",
              entityType: "user",
              entityId: s.userId,
            },
          );
        });
      }
      throw expired;
    }
    if (s.expiresAt < new Date()) throw expired;
    if (!(await this.access.loadUser(s.userId))) throw expired;

    return this.db.transaction(async (tx) => {
      const pair = await this.issue(tx, s.userId, actor, userAgent);
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), replacedBy: pair.sessionId })
        .where(eq(sessions.id, s.id));
      return pair;
    });
  }

  async logout(token: string, actor: Actor) {
    const [s] = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt)),
      )
      .returning({ userId: sessions.userId });
    if (s)
      await this.audit.record(
        this.db,
        { ...actor, userId: s.userId },
        {
          action: "auth.logout",
          entityType: "user",
          entityId: s.userId,
        },
      );
  }

  private async issue(
    exec: Pick<Db, "insert">,
    userId: string,
    actor: Actor,
    userAgent?: string,
  ) {
    const refreshToken = randomBytes(32).toString("base64url");
    const [s] = await exec
      .insert(sessions)
      .values({
        userId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(
          Date.now() + this.env.REFRESH_TOKEN_DAYS * 86_400_000,
        ),
        userAgent: userAgent?.slice(0, 300) ?? null,
        ip: actor.ip ?? null,
      })
      .returning({ id: sessions.id });
    const accessToken = await this.jwt.signAsync({ sub: userId });
    return {
      sessionId: s.id,
      accessToken,
      refreshToken,
      expiresIn: this.env.ACCESS_TOKEN_MINUTES * 60,
    };
  }
}
