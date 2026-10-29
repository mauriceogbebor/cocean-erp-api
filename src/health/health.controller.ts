import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { Public } from "../common/auth-context.js";
import { DB } from "../common/tokens.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** For load balancers and uptime checks: is the API up and the database reachable? */
  @Public()
  @Get()
  async check() {
    try {
      await this.db.execute(sql`select 1`);
      return { status: "ok", database: "ok" };
    } catch {
      throw new ServiceUnavailableException({
        status: "error",
        database: "unreachable",
      });
    }
  }
}
