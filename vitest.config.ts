import { defineConfig } from "vitest/config";

/** e2e tests run against a real PostgreSQL database (TEST_DATABASE_URL). */
export default defineConfig({
  test: {
    include: ["test/**/*.e2e-spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
