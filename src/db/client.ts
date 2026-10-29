import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(url: string) {
  const pool = new Pool({ connectionString: url, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}

/** An open transaction, for services that write as part of a larger change. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
