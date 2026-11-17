# Qorrix ERP API: rules for contributors and agents

Qorrix Technologies Limited builds Qorrix ERP for petroleum distributors. Each
installation serves one organization. Read `docs/architecture.md` first.
Never commit credentials, `.env` files or any customer's data.

- NestJS 12 is ESM-only: this package is `"type": "module"`, and relative
  imports end in `.js`.
- Inject every constructor dependency with `@Inject(Token)`. Tests (Vitest) and
  `pnpm dev` (tsx) don't emit decorator metadata, so type-based injection
  silently breaks.
- Every endpoint is signed-in by default. Mark exceptions `@Public()` and
  declare `@RequirePermissions()` on everything else. Rules live in services,
  never only in the web app.
- Every change writes an audit row in the same transaction
  (`AuditService.record(tx, actor, …)`). `audit_events` is append-only by
  trigger; don't try to work around it.
- Anything that needs a second person goes through `ApprovalsService`: the
  maker never decides, and only the routed role decides.
- Permissions, roles, approval kinds and request schemas live in
  `packages/contracts`, shared with the web app. Changing one is a contract
  change: update the web app's dependency in the same piece of work.
- Every schema change is a new migration (`pnpm db:generate`). Never edit one
  that has run.
- Money is `numeric(18,2)`; never floats in the database. Times are UTC.
- `pnpm test` must pass. Add an e2e test for each rule you add.
- Nothing about a particular organization goes in code. Its name, currency,
  time zone, formats, lists, truck papers and tolerances are organization
  settings: read them with `org()` (`src/common/org.ts`), format money with
  `money()`, dates with `businessDate()`, and check IDs by naming the field's
  format in `ZodPipe` (`new ZodPipe(schema, { phone: "phone" })`). Contract
  schemas stay loose; the API applies the organization's format. A new
  setting needs a default in `DEFAULT_ORGANIZATION` (Nigerian values).
- Approval limits and roles are data too (seeded, then changed in the app).
