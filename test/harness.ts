import type { INestApplication } from "@nestjs/common";
import { Client } from "pg";
import request from "supertest";
import { createApp } from "../src/bootstrap.js";
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { seed } from "../src/db/seed.js";

export const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  "postgres://cocean:cocean@localhost:5432/cocean_test";
export const ADMIN = {
  email: "admin@cocean.test",
  password: "admin-password-123",
};

/** A fresh database: drop everything, migrate from zero, seed. */
export async function freshDatabase() {
  const c = new Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query(
    "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
  );
  await c.end();
  await runMigrations(TEST_DB);
  const { db, pool } = createDb(TEST_DB);
  await seed(db, ADMIN);
  await pool.end();
}

export async function startApp() {
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DB,
    JWT_SECRET: "test-secret-that-is-long-enough-for-hs256-signing",
  });
  const app = await createApp(env);
  await app.init();
  return app;
}

export async function login(
  app: INestApplication,
  email: string,
  password: string,
) {
  const r = await request(app.getHttpServer())
    .post("/v1/auth/login")
    .send({ email, password })
    .expect(200);
  return r.body as { accessToken: string; refreshToken: string };
}

/** Supertest bound to a user's token. */
export function as(app: INestApplication, token: string) {
  const s = () => request(app.getHttpServer());
  const auth = { Authorization: `Bearer ${token}` };
  return {
    get: (url: string) => s().get(url).set(auth),
    post: (url: string, body?: object) =>
      s()
        .post(url)
        .set(auth)
        .send(body ?? {}),
    patch: (url: string, body?: object) =>
      s()
        .patch(url)
        .set(auth)
        .send(body ?? {}),
  };
}
