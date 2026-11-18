import { ForbiddenException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { sites, userSites } from "../db/schema.js";
import type { AuthUser } from "../common/auth-context.js";

/** Station and plant work is done only by people assigned to that site. */
export async function assertSiteAccess(
  exec: Db | Tx,
  user: AuthUser,
  siteId: string,
) {
  const [row] = await exec
    .select({ name: sites.name })
    .from(userSites)
    .innerJoin(sites, eq(sites.id, userSites.siteId))
    .where(and(eq(userSites.userId, user.id), eq(userSites.siteId, siteId)));
  if (!row) {
    const [s] = await exec
      .select({ name: sites.name })
      .from(sites)
      .where(eq(sites.id, siteId));
    throw new ForbiddenException(
      `You aren't assigned to ${s?.name ?? "this site"}`,
    );
  }
}
