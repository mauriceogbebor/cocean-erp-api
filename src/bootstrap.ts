import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { requestId } from "./common/request-id.js";
import type { Env } from "./config/env.js";
import { createDb } from "./db/client.js";

/** Builds the app; used by main.ts and by the tests. */
export async function createApp(env: Env) {
  const { db, pool } = createDb(env.DATABASE_URL);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(env, db),
    { logger: env.NODE_ENV === "test" ? false : ["log", "warn", "error"] },
  );
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(requestId);
  app.enableCors({ origin: env.WEB_ORIGIN.split(","), credentials: true });
  app.setGlobalPrefix("v1", { exclude: ["health"] });
  app.enableShutdownHooks();
  const close = app.close.bind(app);
  app.close = async () => {
    await close();
    await pool.end();
  };
  return app;
}
