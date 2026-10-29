# Cocean ERP API

The backend for Cocean Nigeria Integrated Limited's ERP, built by Qorrix
Technologies Limited. NestJS 12 (ESM) over PostgreSQL 16 with Drizzle ORM.

The web app lives in its own repository (`cocean-erp-platform`) and talks to
this API over HTTPS. Shared roles, permissions and request schemas are in
`packages/contracts` (`@cocean/contracts`), which the web app installs so both
sides validate the same way. See `docs/architecture.md`.

## Run it locally

Needs Node 22.12+, pnpm 10 and Docker (or a local PostgreSQL 16).

```bash
pnpm install
pnpm db:up                      # PostgreSQL in Docker on :5432
cp .env.example .env            # then edit
set -a; source .env; set +a
pnpm db:migrate                 # builds, then applies migrations
pnpm db:seed                    # roles, permissions, approval limits, products, first admin
pnpm dev                        # http://localhost:4000, restarts on change
```

Check it: `curl localhost:4000/health`.

## Tests

End-to-end tests rebuild a test database from scratch on every run.

```bash
createdb -h localhost -U cocean cocean_test   # once
pnpm test        # TEST_DATABASE_URL defaults to postgres://cocean:cocean@localhost:5432/cocean_test
```

## Endpoints (v1)

| Method             | Path                                                                                       | Permission                                           |
| ------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| GET                | /health                                                                                    | public                                               |
| POST               | /v1/auth/login, /v1/auth/refresh, /v1/auth/logout                                          | public                                               |
| GET                | /v1/auth/me                                                                                | signed in                                            |
| GET                | /v1/users                                                                                  | users.read                                           |
| POST               | /v1/users · PATCH /v1/users/:id/roles · PATCH /v1/users/:id/status                         | users.manage                                         |
| GET                | /v1/roles · /v1/permissions                                                                | roles.read                                           |
| GET                | /v1/audit?entityType&entityId&actorId&before                                               | audit.read                                           |
| GET · POST · PATCH | /v1/sites, /v1/products                                                                    | sites.* / products.*                                 |
| GET                | /v1/approvals?scope=mine\|raised\|all&status= · /v1/approvals/:id · /v1/approvals/policies | approvals.read                                       |
| POST               | /v1/approvals                                                                              | approvals.request                                    |
| POST               | /v1/approvals/:id/decide                                                                   | approvals.decide, the routed role, and not the maker |
| POST               | /v1/approvals/:id/withdraw                                                                 | approvals.request, maker only                        |
| GET                | /v1/customers · /v1/customers/:id (with sites and credit position)                         | customers.read                                       |
| POST · PATCH       | /v1/customers · /v1/customers/:id · POST /v1/customers/:id/sites                           | customers.manage                                     |
| POST               | /v1/customers/:id/credit-terms (raises a credit_limit approval)                            | customers.manage, approvals.request                  |
| GET                | /v1/price-lists · /v1/price-lists/in-force?date= · /v1/price-lists/:id                     | prices.read                                          |
| POST · PUT         | /v1/price-lists · /v1/price-lists/:id/lines (draft only)                                   | prices.manage                                        |
| POST               | /v1/price-lists/:id/submit (raises a price_list approval)                                  | prices.manage, approvals.request                     |
| GET                | /v1/orders?status&customerId · /v1/orders/:id                                              | orders.read                                          |
| POST               | /v1/orders                                                                                 | orders.create                                        |
| POST               | /v1/orders/:id/override (raises a credit_override approval)                                | orders.create, approvals.request                     |
| POST               | /v1/orders/:id/cancel                                                                      | orders.cancel                                        |

`credit_limit`, `price_list` and `credit_override` requests are raised only
from the record they are about; `POST /v1/approvals` refuses them.

## Changing the schema

Edit `src/db/schema.ts`, then `pnpm db:generate --name <change>` and commit the
SQL in `drizzle/`. Never edit a migration that has already run anywhere.

## Containers

`docker compose --profile api up` runs PostgreSQL and the API together. The
image runs migrations and the reference-data seed on start; both are safe to
repeat.
