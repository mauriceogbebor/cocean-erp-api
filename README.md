# Qorrix ERP API

The backend of Qorrix ERP, an ERP for petroleum distributors built by Qorrix
Technologies Limited: depots, tanks, trucks, stations and LPG plants, with
sales, buying, receivables and approvals around them. NestJS 12 (ESM) over
PostgreSQL 16 with Drizzle ORM.

Each installation serves one organization. Its name, logo, currency, time
zone, formats (phone numbers, plates, bank accounts, tax IDs), states, banks,
truck papers and tolerances are its **organization settings**
(`/v1/organization`), which an administrator changes in the app. A new
installation starts on Nigerian defaults.

The web app lives in its own repository and talks to
this API over HTTPS. Shared roles, permissions and request schemas are in
`packages/contracts` (`@qorrix-erp/contracts`), which the web app installs so both
sides validate the same way. See `docs/architecture.md`.

## Run it locally

Needs Node 22.12+, pnpm 10 and Docker (or a local PostgreSQL 16).

```bash
pnpm install
pnpm db:up                      # PostgreSQL in Docker on :5432
cp .env.example .env            # then edit
set -a; source .env; set +a
pnpm db:migrate                 # builds, then applies migrations
pnpm db:seed                    # roles, permissions, approval limits, products, settings, first admin
pnpm dev                        # http://localhost:4000, restarts on change
```

Check it: `curl localhost:4000/health`.

### Sample data

For development, demos and trial runs, load Northwind Petroleum, a made-up
Nigerian distributor with the people and records the clickable demo uses (Kelechi, Adaeze, Tunde, Amina, Chidinma, Ifeoma, Chinonso, Sani, Musa, Emeka, Blessing, Obinna, Halima in HR and Ifeanyi the administrator; two customers, an
approved price list, tanks at Onne with stock, two suppliers, three trucks and two drivers, the Owerri station with three pumps and the Aba LPG plant with four cylinders, and five pay grades with eleven staff, one still onboarding):

```bash
SAMPLE_PASSWORD=choose-a-password pnpm db:seed:sample
```

Everyone signs in as `first.last@northwind.example` with that password. It refuses
to run in production and does nothing if it has run before.

## Tests

End-to-end tests rebuild a test database from scratch on every run.

```bash
createdb -h localhost -U erp erp_test   # once
pnpm test        # TEST_DATABASE_URL defaults to postgres://erp:erp@localhost:5432/erp_test
```

## Endpoints (v1)

| Method             | Path                                                                                                                     | Permission                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| GET                | /health                                                                                                                  | public                                               |
| POST               | /v1/auth/login, /v1/auth/refresh, /v1/auth/logout                                                                        | public                                               |
| GET                | /v1/auth/me                                                                                                              | signed in                                            |
| GET                | /v1/users                                                                                                                | users.read                                           |
| POST               | /v1/users · PATCH /v1/users/:id/roles · PATCH /v1/users/:id/status                                                       | users.manage                                         |
| GET                | /v1/roles · /v1/permissions                                                                                              | roles.read                                           |
| GET                | /v1/audit?entityType&entityId&actorId&before                                                                             | audit.read                                           |
| GET · POST · PATCH | /v1/sites, /v1/products                                                                                                  | sites.* / products.*                                 |
| GET                | /v1/approvals?scope=mine\|raised\|all&status= · /v1/approvals/:id · /v1/approvals/policies                               | approvals.read                                       |
| POST               | /v1/approvals                                                                                                            | approvals.request                                    |
| POST               | /v1/approvals/:id/decide                                                                                                 | approvals.decide, the routed role, and not the maker |
| POST               | /v1/approvals/:id/withdraw                                                                                               | approvals.request, maker only                        |
| GET                | /v1/customers · /v1/customers/:id (with sites and credit position)                                                       | customers.read                                       |
| POST · PATCH       | /v1/customers · /v1/customers/:id · POST /v1/customers/:id/sites                                                         | customers.manage                                     |
| POST               | /v1/customers/:id/credit-terms (raises a credit_limit approval)                                                          | customers.manage, approvals.request                  |
| GET                | /v1/price-lists · /v1/price-lists/in-force?date= · /v1/price-lists/:id                                                   | prices.read                                          |
| POST · PUT         | /v1/price-lists · /v1/price-lists/:id/lines (draft only)                                                                 | prices.manage                                        |
| POST               | /v1/price-lists/:id/submit (raises a price_list approval)                                                                | prices.manage, approvals.request                     |
| GET                | /v1/orders?status&customerId · /v1/orders/:id                                                                            | orders.read                                          |
| POST               | /v1/orders                                                                                                               | orders.create                                        |
| POST               | /v1/orders/:id/override (raises a credit_override approval)                                                              | orders.create, approvals.request                     |
| POST               | /v1/orders/:id/cancel                                                                                                    | orders.cancel                                        |
| POST               | /v1/orders/:id/release (re-runs the payment or credit check)                                                             | orders.release                                       |
| GET                | /v1/receipts?customerId · /v1/invoices?customerId · /v1/invoices/:id                                                     | finance.read                                         |
| POST               | /v1/receipts · /v1/receipts/:id/reverse (not by the person who recorded it)                                              | receipts.manage                                      |
| POST               | /v1/orders/:id/invoice                                                                                                   | invoices.create                                      |
| GET                | /v1/customers/:id/statement · /v1/receivables?asOf=                                                                      | finance.read                                         |
| GET                | /v1/vendors · /v1/vendors/:id                                                                                            | vendors.read                                         |
| POST · PATCH       | /v1/vendors · /v1/vendors/:id                                                                                            | vendors.manage                                       |
| POST               | /v1/vendors/:id/bank-details (raises a vendor_bank approval)                                                             | vendors.manage, approvals.request                    |
| GET                | /v1/purchase-orders?status&vendorId · /v1/purchase-orders/:id · /v1/bills · /v1/payables                                 | purchase_orders.read                                 |
| POST · PUT         | /v1/purchase-orders · /v1/purchase-orders/:id/lines (draft) · /:id/cancel                                                | purchase_orders.manage                               |
| POST               | /v1/purchase-orders/:id/submit (raises a purchase_order approval)                                                        | purchase_orders.manage, approvals.request            |
| POST               | /v1/purchase-orders/:id/receipts (goods received; not by the person who raised the order)                                | goods.receive                                        |
| POST               | /v1/bills · /v1/bills/:id/void · /v1/bills/:id/paid                                                                      | bills.manage                                         |
| POST               | /v1/bills/:id/request-payment (raises a supplier_payment approval)                                                       | bills.manage, approvals.request                      |
| GET                | /v1/tanks?siteId · /v1/tanks/:id (stock on hand, ullage, movements, dips)                                                | stock.read                                           |
| POST               | /v1/tanks (with opening stock)                                                                                           | tanks.manage                                         |
| POST               | /v1/tanks/:id/dips (beyond tolerance raises a variance approval)                                                         | stock.dip                                            |
| GET                | /v1/liftings?status&orderId · /v1/liftings/:id (seals only for planners, loaders, Security)                              | liftings.read                                        |
| POST               | /v1/liftings · /v1/liftings/:id/cancel                                                                                   | liftings.plan                                        |
| POST               | /v1/liftings/:id/load (returns each drop's one-time delivery link)                                                       | liftings.load, not the planner                       |
| POST               | /v1/deliveries/confirm (the receiver's link; no account)                                                                 | public, one-time token                               |
| POST               | /v1/deliveries/:id/resolve                                                                                               | deliveries.resolve                                   |
| POST               | /v1/deliveries/:id/invoice (for the quantity received)                                                                   | invoices.create                                      |
| GET                | /v1/vehicles · /v1/vehicles/:id (papers, issues, last position) · /v1/drivers · /v1/tracking                             | fleet.read                                           |
| POST · PATCH       | /v1/vehicles · /:id/documents · /:id/hold · /:id/clear-hold · /v1/drivers · /drivers/:id · /:id/suspend · /:id/reinstate | fleet.manage                                         |
| POST               | /v1/vehicles/:id/submit (raises a truck_onboarding approval)                                                             | fleet.manage, approvals.request                      |
| POST               | /v1/tracking/pings (from the tracker provider)                                                                           | public, `X-Tracker-Key` = `TRACKER_API_KEY`          |
| GET                | /v1/organization/public (name, logo, currency, locale, time zone)                                                        | public                                               |
| GET · PUT          | /v1/organization (settings) · PUT needs settings.manage                                                                  | signed in · settings.manage                          |
| GET                | /v1/stations · /v1/pumps · /v1/shifts · /v1/shifts/:id · /v1/cylinders · /v1/fills (open fills at a plant)               | stations.read                                        |
| PUT · POST         | /v1/users/:id/sites · /v1/pumps                                                                                          | stations.manage                                      |
| POST               | /v1/tanks/:id/receipts · /v1/shifts (close) · /v1/fills · /v1/cylinders · /v1/cylinders/:id/condemn (own sites only)     | stations.operate                                     |
| POST               | /v1/shifts/:id/bank                                                                                                      | takings.bank                                         |
| GET                | /v1/grades · /v1/employees · /v1/employees/:id                                                                           | people.read                                          |
| POST · PUT         | /v1/grades · /v1/grades/:id · /v1/employees · /v1/employees/:id · /v1/employees/:id/pay · /activate · /exit              | people.manage                                        |
| GET                | /v1/payroll-runs · /v1/payroll-runs/:id · /v1/payroll-runs/:id/payslips/:employeeId                                      | payroll.read                                         |
| POST               | /v1/payroll-runs (work a month out) · /v1/payroll-runs/:id/submit                                                        | payroll.prepare                                      |
| GET · POST         | /v1/payroll-runs/:id/bank-file (CSV) · /v1/payroll-runs/:id/pay                                                          | payroll.pay                                          |

`credit_limit`, `price_list`, `credit_override`, `vendor_bank`, `purchase_order` and `supplier_payment`, `variance`, `truck_onboarding` and `shift_variance` requests are raised only
from the record they are about; `POST /v1/approvals` refuses them.

## Changing the schema

Edit `src/db/schema.ts`, then `pnpm db:generate --name <change>` and commit the
SQL in `drizzle/`. Never edit a migration that has already run anywhere.

## Containers

`docker compose --profile api up` runs PostgreSQL and the API together. The
image runs migrations and the reference-data seed on start; both are safe to
repeat.
