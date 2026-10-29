# Cocean ERP: architecture

Two repositories:

| Repo                    | What                                                                             | Talks to                                                       |
| ----------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `cocean-erp-api` (this) | NestJS API, PostgreSQL, migrations, shared contracts                             | PostgreSQL; later trackers, weighbridges, banks, SMS and email |
| `cocean-erp-platform`   | Next.js web app: screens and design system (and, on `main`/`dev`, the prototype) | This API only                                                  |

## How the web app connects

- The web app never talks to the database. It calls `https://<api>/v1/...`
  from its server side (Next.js route handlers and server actions).
- Sign-in goes through a Next.js server route that calls `/v1/auth/login` and
  keeps the access and refresh tokens in httpOnly cookies; the browser never
  sees them. The route refreshes the access token when it expires.
- The web app's `lib/services` layer already isolates data access, so each
  screen moves from mock data to the API without being rewritten.
- CORS allows only the web app's origin (`WEB_ORIGIN`), for any calls made
  from the browser.
- **Shared contracts.** `packages/contracts` is published as
  `@cocean/contracts`. Until there is a private registry, the web app installs
  it straight from this repo:
  `"@cocean/contracts": "github:mauriceogbebor/cocean-erp-api#main&path:packages/contracts"`
  (pnpm builds it on install). Bump the ref when a contract changes.

## Inside the API

```
src/
  config/        environment, validated at start
  db/            Drizzle schema, client, migrate and seed entry points
  common/        guards (who you are, what you may do), zod pipe, request ids
  auth/          sign-in, refresh rotation, logout, me
  access/        roles and permissions
  users/         user accounts and role assignment
  audit/         append-only audit trail
  master-data/   sites, products (customers, vendors, tanks, trucks next)
  approvals/     routing by kind and amount, maker-checker decisions
  health/        uptime check
packages/contracts/  permissions, roles, approval kinds, request schemas
drizzle/             SQL migrations, applied in order
test/                e2e tests against a real database
```

## Foundation (Phase 1), built

| Concern     | How                                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in     | Email and password (argon2id). 15-minute access token (JWT) and a 7-day refresh token that rotates on every use; reusing an old refresh token revokes every session for that user. Five failed attempts lock the account for 15 minutes.                                         |
| Permissions | Every endpoint needs a signed-in user unless marked `@Public()`, and declares the permissions it needs with `@RequirePermissions()`. Roles and their permissions are rows in the database, loaded on each request, so a removed role or a disabled account takes effect at once. |
| Audit       | Every change writes an `audit_events` row in the same transaction: who, what, before, after, IP, request id. A database trigger refuses UPDATE, DELETE and TRUNCATE on that table, for every user.                                                                               |
| Approvals   | A request is routed by kind and amount to an approver role (`approval_policies`). The maker can never decide; only the routed role can; a rejection needs a reason; a request is decided once (row lock). The maker can withdraw while pending.                                  |
| Master data | Sites (depot, station, LPG plant, office, workshop) and products, with audit. Customers, vendors, tanks, trucks and staff follow with their modules.                                                                                                                             |
| Operations  | `/health` for uptime checks; request ids on every response; helmet security headers; CORS limited to the web app's origin; config validated at start.                                                                                                                            |

## Conventions for every module

1. Schema in `src/db/schema.ts`, then `pnpm db:generate --name <change>`.
2. Request schemas and permissions in `packages/contracts`.
3. A service holds the rules and writes audit rows in the same transaction as
   the change; the controller only validates and checks permissions.
4. Anything that needs a second person goes through `ApprovalsService`.
5. e2e tests in `test/` against a real database, one test per rule.
6. Money is `numeric(18,2)` in naira; quantities in litres or kilograms as the
   product says; times are stored in UTC and shown in Africa/Lagos.

## Decisions still open (with Cocean, first two weeks)

- Ledger in this platform or posting to Cocean's existing accounting system.
- Hosting (Cocean's servers or a cloud provider) and single sign-on.
- Tracker (Arc Tracker, Trakzee), weighbridge and bank interfaces.
- Tax and payroll rules confirmed by Cocean's tax adviser.
- Opening data to migrate, and from where.
