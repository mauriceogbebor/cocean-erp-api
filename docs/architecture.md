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

## Sales and customers (Phase 2), built

| Concern      | How                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customers    | A new customer starts prepaid with no credit. Credit terms and limits change only through a `credit_limit` approval (Finance up to ₦50m, the MD above); the change applies when it is approved, inside the same transaction as the decision.               |
| Price lists  | Drafted by Sales, approved by the MD. A pending list can't be edited; a rejected one goes back to draft. The list in force is the approved one with the latest start date on or before today (Africa/Lagos).                                               |
| Orders       | Prices are copied from the list in force onto each line; a price sent with the order is ignored. Delivery sites must belong to the customer. Numbers are `SO-<year>-<0001>`, gap-free per year.                                                            |
| Credit check | Prepaid orders wait for payment. Credit orders are released when the opening balance, released orders and this order fit under the limit; otherwise they go on credit hold, with the check stored on the order. The customer row is locked while checking. |
| Override     | Sales can ask for a held order to go ahead (`credit_override`, MD). Approval releases it; rejection or withdrawal puts it back on hold. Only held or awaiting-payment orders can be cancelled, with a reason.                                              |
| Effects      | `ApprovalHandlers` lets a module say what a decision does to its record. The handler runs in the decision's transaction, so the decision and its effect can't disagree.                                                                                    |

## Receivables (Phase 2), built

| Concern   | How                                                                                                                                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger    | `customer_ledger` holds every opening balance, invoice, receipt and reversal as a signed amount; the balance is the sum. A trigger makes it append-only, so a mistake is corrected with a new entry.                        |
| Receipts  | Finance records money as it shows on the bank statement. Each bank reference is recorded once. A wrong receipt is reversed by a second Finance user, with a reason; the original and its reversal both stay on the account. |
| Release   | Finance releases an order when money or credit covers it: ledger balance plus released, uninvoiced orders plus this order must fit under the limit (zero for prepaid). Sales can't release.                                 |
| Invoices  | One per released order, at the order's prices. Prices are VAT-inclusive and VAT is shown out of them at the product's rate (zero until Cocean confirms). Due date is the issue date plus the customer's credit days.        |
| Reporting | Customer statement with running balance. Aged receivables as at any date: money in is applied to the oldest amount due first, the rest aged current, 1-30, 31-60, 61-90, 90+ days past due; unused money is on account.     |

Not yet: posting to a general ledger (open decision), invoicing per delivery
(Phase 3), credit notes, and bank statement import. Opening balances should be
loaded once from Cocean's old system, not typed by Sales.

## Procurement (Phase 2), built

| Concern         | How                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Suppliers       | Procurement creates suppliers. Bank details are set only by a `vendor_bank` approval decided by Finance; while a change is pending the supplier can't be paid, and a refused change leaves the old details in place.                                                                      |
| Purchase order  | Drafted by Procurement at the supplier's quoted price plus VAT, and routed by total: Finance up to ₦5m, the Head of Operations to ₦25m, the MD above. Approved orders can be received; rejected ones go back to draft.                                                                    |
| Goods received  | The depot records what arrived, line by line, against the supplier's delivery note. Nobody receives more than is still due, and the person who raised the order can't receive it.                                                                                                         |
| Three-way match | Finance enters the supplier's invoice as printed. Each line must be at the order's price and within what was received and not yet billed, and the printed total must agree with the lines plus VAT (₦1 rounding). Otherwise it is an exception, kept with the reasons, and can't be paid. |
| Payment         | A matched bill is put up for payment (`supplier_payment`: Finance to ₦25m, the MD above) to the supplier's verified bank details, which are saved with the request. If they change before payment is recorded, the approval lapses.                                                       |

Not yet: requisitions before the PO, partial-price tolerances, returns to
supplier, withholding tax on payment, and posting stock receipts to inventory
(Phase 3).

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
- VAT treatment per product, and whether price lists stay VAT-inclusive.
- Hosting (Cocean's servers or a cloud provider) and single sign-on.
- Tracker (Arc Tracker, Trakzee), weighbridge and bank interfaces.
- Tax and payroll rules confirmed by Cocean's tax adviser.
- Opening data to migrate, and from where.
