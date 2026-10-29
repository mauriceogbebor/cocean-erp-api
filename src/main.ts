import { createApp } from "./bootstrap.js";
import { loadEnv } from "./config/env.js";

async function main() {
  const env = loadEnv();
  const app = await createApp(env);
  await app.listen(env.PORT);
  console.log(`Cocean ERP API listening on :${env.PORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
