# Qorrix ERP: architecture

Qorrix ERP runs a petroleum distributor: depots, tanks, trucks, stations and
LPG plants, with sales, buying, receivables and approvals around them. Each
installation serves one organization (its own deployment and database).

Two repositories:

| Repo                    | What                                                                             | Talks to                                                       |
| ----------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `qorrix-erp-api` (this) | NestJS API, PostgreSQL, migrations, shared contracts                             | PostgreSQL; later trackers, weighbridges, banks, SMS and email |
| `qorrix-erp-platform`   | Next.js web app: screens and design system (and, on `main`/`dev`, the prototype) | This API only                                                  |

## How the web app connects

- The web app never talks to the database. Its server side (Server
  Components and server actions under `/live`) calls `<API_URL>/v1/...`.
- Sign-in is a server action that calls `/v1/auth/login` and keeps the access
  and refresh tokens in httpOnly cookies; the browser never sees them.
- The web app's `proxy.ts` refreshes the access token a minute before it
  expires. A token is exchanged once per web process and the result shared
  for 30 seconds, because pages and prefetches refresh at the same moment and
  the API treats a reused refresh token as theft. The API locks the session
  row while refreshing, so two refreshes can't both succeed. More than one
  web server would need a shared store for that exchange (Redis).
- The web app forwards `X-Forwarded-For`, so the audit trail records the
  person's address, not the web server's.
- CORS allows only the web app's origin (`WEB_ORIGIN`), for any calls made
  from the browser.
- **Shared contracts.** `packages/contracts` is published as
  `@qorrix-erp/contracts`. The web app mirrors the few request schemas its forms
  need until the package is installable from GitHub or a private registry:
  `"@qorrix-erp/contracts": "github:mauriceogbebor/qorrix-erp-api#main&path:packages/contracts"`.

## Inside the API

```
src/
  config/        environment, validated at start
  db/            Drizzle schema, client, migrate and seed entry points
  common/        guards (who you are, what you may do), zod pipe, request ids,
                 org(): the organization's settings, money and business dates
  organization/  the organization's settings (one row), cached per process
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

| Concern   | How                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ledger    | `customer_ledger` holds every opening balance, invoice, receipt and reversal as a signed amount; the balance is the sum. A trigger makes it append-only, so a mistake is corrected with a new entry.                           |
| Receipts  | Finance records money as it shows on the bank statement. Each bank reference is recorded once. A wrong receipt is reversed by a second Finance user, with a reason; the original and its reversal both stay on the account.    |
| Release   | Finance releases an order when money or credit covers it: ledger balance plus released, uninvoiced orders plus this order must fit under the limit (zero for prepaid). Sales can't release.                                    |
| Invoices  | One per released order, at the order's prices. Prices are VAT-inclusive and VAT is shown out of them at the product's rate (zero until the organization confirms). Due date is the issue date plus the customer's credit days. |
| Reporting | Customer statement with running balance. Aged receivables as at any date: money in is applied to the oldest amount due first, the rest aged current, 1-30, 31-60, 61-90, 90+ days past due; unused money is on account.        |

Not yet: posting to a general ledger (open decision), invoicing per delivery
(Phase 3), credit notes, and bank statement import. Opening balances should be
loaded once from the organization's old system, not typed by Sales.

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

## Product movement (Phase 3), built

| Concern    | How                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stock      | `stock_movements` holds every unit into or out of a tank, signed; stock on hand is the sum. A trigger makes it append-only. Movements are posted with the tank row locked, and refused if a tank would go below empty or a receipt above its safe capacity.                                                                                                       |
| Receipts   | Product bought on a purchase order goes into a named tank at the receiving site when the depot records the goods received.                                                                                                                                                                                                                                        |
| Dips       | Within ±0.5% of book (or 50 units) the difference is booked at once. Beyond it a `variance` approval goes to Operations, valued at list price; approval books the variance as measured, refusal means dip again. One open variance per tank.                                                                                                                      |
| Loading    | Operations plans a truck (plate and driver for now; Phase 4 links the fleet) against a released order, one drop per order line, never more than is left to load. The depot loads from the meter, names the tank and fits seals; stock leaves the tank then. The planner can't load.                                                                               |
| Delivery   | Each drop gets a one-time link (192-bit token, stored hashed, 7 days). The receiver enters what arrived and the seal numbers blind; they never see the recorded figures, and the answer tells them nothing about the check. Seals that differ, or more than 0.5% short or over, make an exception. Seal numbers are shown only to planners, loaders and Security. |
| Exceptions | Security closes an exception with a written finding. Until then the delivery can't be invoiced.                                                                                                                                                                                                                                                                   |
| Invoicing  | Each confirmed delivery is invoiced for the quantity received, at the order's price. An order delivered by truck can't also be invoiced whole; it is invoiced once every line is loaded in full and every delivery invoiced. Credit exposure counts released orders less what is already invoiced against them.                                                   |

Each organization sets its tolerances in its settings (defaults in `STOCK_RULES`). To agree with each organization: whether customers pay for loaded or received quantity, and who absorbs transit loss. Not yet: temperature correction to standard volume (dips record temperature for it), tank-to-tank transfers, sending delivery links by SMS (the link is returned to the depot on loading), and rate limiting on the public confirmation endpoint.

## Fleet and tracking (Phase 4), built

| Concern  | How                                                                                                                                                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vehicles | Fleet registers a truck (capacity, compartments that must add up, owner, tracker ID). It goes into service only by a `truck_onboarding` approval from the Head of Operations, and only once every required paper is recorded and in date.                                                 |
| Papers   | Registration, roadworthiness, insurance, NMDPRA permit, tank calibration (placeholders: `REQUIRED_DOCS`). A renewal is a new row; the newest of each kind counts, and the history stays. Papers expiring within 30 days are flagged.                                                      |
| Drivers  | Licence and expiry, last HSE induction (valid 12 months, placeholder), employer. Suspended by Fleet, or by Security while closing a delivery exception; reinstated by Fleet with a reason.                                                                                                |
| Dispatch | One rule (`vehicleIssues`, `driverIssues`) answers on the fleet list, at planning and again at loading: in service, no hold, papers in date, driver licensed, inducted and not suspended, load within capacity, and neither on another open loading. Every reason is given at once.       |
| Tracking | The tracker provider posts batches of positions to `/v1/tracking/pings` with a shared key (constant-time compared). Unknown trackers and future timestamps are ignored. The board shows each tracked truck's last report, how old it is (stale after 15 minutes) and the loading it's on. |

Not yet, waiting on decisions: which tracker provider and its own API (this endpoint is a generic adapter), geofences and route deviation alerts, scans of the papers themselves, workshop work orders, and fuel use per trip.

## Stations and LPG (Phase 5), built

| Concern         | How                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access          | A station or LPG manager works only at the sites they're assigned to (`user_sites`, set by an administrator). Anyone else is refused with the site's name.                                                                                                                                                                                                                                                                    |
| Receiving       | Product arriving from the depot goes into a station or plant tank against the driver's waybill, as an append-only receipt movement.                                                                                                                                                                                                                                                                                           |
| Closing a shift | One shift per site, date and period. Every pump's closing meter (never below the last close) and every tank's dip are required. The meters, priced from the list in force, give litres sold and the takings expected; sales post from each tank, and each tank's book is checked against its dip within `STOCK_RULES`. Takings are cash, POS and transfers; a difference within `STATION_RULES` (₦5,000 or 0.2%) is accepted. |
| Variance        | A shift that doesn't balance raises a `shift_variance` approval (Operations to ₦1m, the MD above) for the cash short plus the value of stock lost. Accepted, the out-of-tolerance tanks are adjusted; refused, stock stays and it is investigated.                                                                                                                                                                            |
| Banking         | Finance records the cash lodgement only once the shift balances or its variance is accepted; cash that didn't reach the bank is shown on the shift.                                                                                                                                                                                                                                                                           |
| LPG             | Cylinders are registered with size, owner and next pressure test. A fill is refused for an unregistered, condemned or test-overdue cylinder, or more gas than it holds; nobody can override it. Each fill is priced and sold from the plant tank at once, and the day's fills are the plant's sales when the day closes.                                                                                                      |

Not yet, waiting on decisions: shift handover between attendants on one day, POS terminal and bank statement feeds, price boards per station, cylinder exchange and deposits, and LPG temperature sensors (out of scope in the proposal).

## Conventions for every module

1. Schema in `src/db/schema.ts`, then `pnpm db:generate --name <change>`.
2. Request schemas and permissions in `packages/contracts`.
3. A service holds the rules and writes audit rows in the same transaction as
   the change; the controller only validates and checks permissions.
4. Anything that needs a second person goes through `ApprovalsService`.
5. e2e tests in `test/` against a real database, one test per rule.
6. Money is `numeric(18,2)` in naira; quantities in litres or kilograms as the
   product says; times are stored in UTC and shown in Africa/Lagos.

## Administration, built

| Concern         | How                                                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users           | An administrator adds people with a temporary password and roles, changes roles, assigns station and plant managers to their sites, disables people (signing them out everywhere) and sets a new temporary password for someone locked out. Nobody can disable themselves or drop their own administrator role. |
| Passwords       | Anyone changes their own password with their current one; every session ends, and the web app signs them straight back in.                                                                                                                                                                                      |
| Approval limits | `PUT /v1/approvals/policies/:kind` replaces the bands for a kind: they start at 0, join up with no gaps, end open-ended, and each approver's role must be able to decide. Old bands stay (inactive) for the record; requests already waiting keep their approver.                                               |
| Reference data  | Sites, products and tanks are set up in the app. Tanks start from the last physical dip; after that stock moves only through recorded movements.                                                                                                                                                                |
| Audit trail     | Readable by anyone with `audit.read`, filtered by kind of record, 50 at a time, with who did it. It can't be edited.                                                                                                                                                                                            |

## People and payroll (Phase 5b), built

| Concern              | How                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staff                | HR (`people.manage`) keeps each person's grade, monthly pay (basic, housing, transport, other), bank, pension fund and RSA PIN, tax ID and the state that receives their PAYE. Pay must sit inside the grade's band; a pay change carries a reason and is audited. Salaries are visible only to HR, Finance and the MD (`people.read`).                                             |
| Joiners and leavers  | A joiner starts as onboarding and goes on payroll only when HR activates them with a bank account nobody else is paid into, a pension fund and PIN, and pay in band. A leaver is paid to their exit date.                                                                                                                                                                           |
| Payroll rules        | In the organization's settings (`payroll`): PAYE bands, the minimum-wage exemption, rent relief, pension shares, housing fund, NSITF, ITF and the pay-jump threshold. Defaults follow the Nigeria Tax Act 2025 (from January 2026) and the Pension Reform Act 2014. Each run saves the rules it was worked with.                                                                    |
| Working a month out  | For everyone active (and leavers still here in the month), in kobo: pension on basic, housing and transport; housing fund on basic for those who consented; PAYE on the full month annualised, after pension, housing fund and rent relief, nothing at or below the minimum wage; then each joiner's or leaver's share of the month (`src/people/pay-calc.ts`).                     |
| Checks               | Blocking: a shared bank account, no bank account, no pension details, pay outside the band. Warning: net pay moving more than the threshold since the last paid month, which needs HR's note to send. Joiners and leavers are marked.                                                                                                                                               |
| Approval and payment | HR sends a clean run as a `payroll` approval (the MD by default) for the cost to the organization. Approved, Finance (`payroll.pay`, never the person who prepared it) downloads the bank file (CSV, net pay per person) and records the payment. A refused run can be worked out again. Each run shows what to remit: PAYE by state, pension by fund, housing fund, NSITF and ITF. |

Not yet, waiting on decisions: leave and absence, loans and salary advances, other deductions (union dues, cooperative), overtime and trip allowances from recorded deliveries, bank-specific file formats, payslips by email, statutory schedules in each authority's own format, and posting payroll to the ledger.

## Organization settings, built

| Concern      | How                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One row      | `organization` holds one row (id 1) of `OrganizationSettings` (contracts): name, legal name, logo, currency, locale, time zone, states or regions, banks, ID formats, default VAT, truck papers, and the stock, station and fleet tolerances. `pnpm db:seed` creates it on Nigerian defaults (`SEED_ORG_NAME` names it); an administrator (`settings.manage`) changes it in the app, and each change is audited. |
| Reading      | Each API process caches the settings (`org()`), so checks read them without a query. A change applies at once in the process that saved it and within a minute in any other. Settings saved by an older release are filled in from the defaults when read.                                                                                                                                                       |
| IDs          | Contract schemas accept any reasonable phone number, plate, bank account or tax ID. The API then checks the field against the organization's pattern, and the message quotes its example. Sites and delivery addresses must use one of its states or regions.                                                                                                                                                    |
| Truck papers | A list of `{ key, label, requiredFor }`. The regulator's permit is just one entry (NMDPRA by default); labels can change freely. Keep keys once papers are recorded against them.                                                                                                                                                                                                                                |
| Sign-in      | `GET /v1/organization/public` gives the name, logo, currency, locale and time zone without an account; everything else needs sign-in.                                                                                                                                                                                                                                                                            |

## Decisions to agree with each organization (first two weeks)

- Ledger in this platform or posting to the organization's existing accounting system.
- VAT treatment per product, and whether price lists stay VAT-inclusive.
- Hosting (the organization's servers or a cloud provider) and single sign-on.
- Tracker (Arc Tracker, Trakzee), weighbridge and bank interfaces.
- Tax and payroll rules confirmed by the organization's tax adviser.
- Opening data to migrate, and from where.
