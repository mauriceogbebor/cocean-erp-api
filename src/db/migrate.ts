import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

/** Applies every pending migration in drizzle/, in order. */
export async function runMigrations(url: string) {
  const { db, pool } = createDb(url);
  try {
    await migrate(db, {
      migrationsFolder: join(import.meta.dirname, "..", "..", "drizzle"),
    });
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  runMigrations(url)
    .then(() => console.log("Migrations applied"))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
