import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  DEFAULT_ORGANIZATION,
  organizationSettingsSchema,
  type OrganizationSettings,
  type PublicOrganization,
} from "@qorrix-erp/contracts";
import { eq } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../common/auth-context.js";
import { org, setOrg } from "../common/org.js";
import { DB } from "../common/tokens.js";
import type { Db, Tx } from "../db/client.js";
import { organization } from "../db/schema.js";

/** How often each API process picks up settings changed by another. */
const RELOAD_MS = 60_000;

/**
 * The organization's settings: one row, cached in the process (common/org)
 * so every check reads them without a query. A change applies at once in
 * the process that saved it and within a minute in any other.
 */
@Injectable()
export class OrganizationService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    await this.load();
    this.timer = setInterval(() => void this.load().catch(() => {}), RELOAD_MS);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Reads the row, creating it with the defaults on a new installation. */
  async load(exec: Db | Tx = this.db) {
    const [row] = await exec
      .select()
      .from(organization)
      .where(eq(organization.id, 1));
    if (!row) {
      await exec
        .insert(organization)
        .values({ id: 1, settings: DEFAULT_ORGANIZATION })
        .onConflictDoNothing();
      setOrg(DEFAULT_ORGANIZATION);
      return DEFAULT_ORGANIZATION;
    }
    // Fill in anything added since the row was saved, so a newer release
    // never meets settings without a key it needs.
    const s = organizationSettingsSchema.parse({
      ...DEFAULT_ORGANIZATION,
      ...(row.settings as object),
    });
    setOrg(s);
    return s;
  }

  get(): OrganizationSettings {
    return org();
  }

  publicView(): PublicOrganization {
    const { name, logo, currency, locale, timeZone } = org();
    return { name, logo, currency, locale, timeZone };
  }

  async update(input: OrganizationSettings, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const before = await this.load(tx);
      await tx
        .insert(organization)
        .values({ id: 1, settings: input, updatedBy: actor.userId })
        .onConflictDoUpdate({
          target: organization.id,
          set: {
            settings: input,
            updatedBy: actor.userId,
            updatedAt: new Date(),
          },
        });
      await this.audit.record(tx, actor, {
        action: "organization.updated",
        entityType: "organization",
        entityId: "1",
        // The logo is large and adds nothing to the trail.
        before: { ...before, logo: before.logo ? "(image)" : null },
        after: { ...input, logo: input.logo ? "(image)" : null },
      });
      setOrg(input);
      return input;
    });
  }
}
