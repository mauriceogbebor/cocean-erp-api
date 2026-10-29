import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Client } from "pg";
import { addDays, lagosDate } from "../src/common/dates.js";
import {
  ADMIN,
  as,
  freshDatabase,
  login,
  startApp,
  TEST_DB,
} from "./harness.js";

let app: INestApplication;
const people = {
  sales: {
    email: "tunde@cocean.test",
    name: "Tunde Adeyemi",
    roles: ["sales"],
  },
  finance: {
    email: "amina@cocean.test",
    name: "Amina Bello",
    roles: ["finance"],
  },
  finance2: {
    email: "ngozi@cocean.test",
    name: "Ngozi Eze",
    roles: ["finance"],
  },
  md: { email: "kelechi@cocean.test", name: "Kelechi Amadi", roles: ["md"] },
  depot: { email: "bayo@cocean.test", name: "Bayo Lawal", roles: ["depot"] },
};
type Who = keyof typeof people | "admin";
const PASSWORD = "a-good-long-password";
const u = {} as Record<Who, ReturnType<typeof as>>;
const today = lagosDate();
const ids = {
  riverside: "",
  rSite: "",
  harbour: "",
  hSite: "",
  prepaidOrder: "",
  heldOrder: "",
};

const site = (name: string) => ({
  name,
  address: "Plot 4, Trans-Amadi Industrial Layout",
  state: "Rivers",
  receiverName: "Grace Eze",
  receiverPhone: "08031234567",
});
const approve = (id: string) =>
  u.md.post(`/v1/approvals/${id}/decide`, { decision: "approved" }).expect(200);
const order = (
  customerId: string,
  deliverySiteId: string,
  quantity: number,
  productCode = "AGO",
) =>
  u.sales
    .post("/v1/orders", {
      customerId,
      poRef: "PO-REF-1",
      lines: [{ productCode, quantity, deliverySiteId }],
    })
    .expect(201);
const receipt = (
  customerId: string,
  amount: number,
  bankRef: string,
  receivedOn = today,
) =>
  u.finance.post("/v1/receipts", {
    customerId,
    amount,
    bank: "GTBank",
    bankRef,
    receivedOn,
  });

beforeAll(async () => {
  await freshDatabase();
  app = await startApp();
  u.admin = as(
    app,
    (await login(app, ADMIN.email, ADMIN.password)).accessToken,
  );
  for (const [k, p] of Object.entries(people)) {
    await u.admin.post("/v1/users", { ...p, password: PASSWORD }).expect(201);
    u[k as Who] = as(app, (await login(app, p.email, PASSWORD)).accessToken);
  }
  const r = await u.sales
    .post("/v1/customers", {
      code: "CUS-107",
      name: "Riverside Construction Ltd",
      kind: "industrial",
      address: "12 Aba Road, Port Harcourt",
      openingBalance: 5_000_000,
      requestedTerms: {
        terms: "credit",
        creditLimit: 40_000_000,
        creditDays: 30,
        reason: "Three years, pays on time.",
      },
    })
    .expect(201);
  ids.riverside = r.body.id;
  await u.finance
    .post(`/v1/approvals/${r.body.pendingTermsRequest.id}/decide`, {
      decision: "approved",
    })
    .expect(200);
  ids.rSite = (
    await u.sales
      .post(`/v1/customers/${ids.riverside}/sites`, site("Bridge site"))
      .expect(201)
  ).body.id;
  const h = await u.sales
    .post("/v1/customers", {
      code: "CUS-210",
      name: "Harbour Fuels Ltd",
      kind: "reseller",
      address: "3 Wharf Road, Apapa",
    })
    .expect(201);
  ids.harbour = h.body.id;
  ids.hSite = (
    await u.sales
      .post(`/v1/customers/${ids.harbour}/sites`, site("Apapa depot"))
      .expect(201)
  ).body.id;
  const pl = await u.sales
    .post("/v1/price-lists", {
      code: "PL-2026-10",
      validFrom: today,
      lines: [
        { productCode: "AGO", price: 1240 },
        { productCode: "PMS", price: 950 },
      ],
    })
    .expect(201);
  await approve(
    (await u.sales.post(`/v1/price-lists/${pl.body.id}/submit`).expect(200))
      .body.approval.id,
  );
});
afterAll(() => app?.close());

describe("prepaid orders and receipts", () => {
  it("won't release a prepaid order before the money is in", async () => {
    const o = await order(ids.harbour, ids.hSite, 10_000);
    ids.prepaidOrder = o.body.id;
    expect(o.body).toMatchObject({
      status: "awaiting_payment",
      total: 12_400_000,
    });
    await u.sales.post(`/v1/orders/${ids.prepaidOrder}/release`).expect(403);
    const r = await u.finance
      .post(`/v1/orders/${ids.prepaidOrder}/release`)
      .expect(409);
    expect(r.body.message).toMatch(/₦12,400,000 short/);
  });

  it("records a receipt once per bank reference, and never in the future", async () => {
    const r = await receipt(ids.harbour, 10_000_000, "ft-2610-88123").expect(
      201,
    );
    expect(r.body).toMatchObject({
      amount: 10_000_000,
      bankRef: "FT-2610-88123",
    });
    expect(r.body.number).toMatch(/^RCT-\d{4}-0001$/);
    const dup = await receipt(
      ids.riverside,
      10_000_000,
      "FT-2610-88123",
    ).expect(409);
    expect(dup.body.message).toMatch(/already recorded as RCT-/);
    await receipt(ids.harbour, 1, "FT-FUTURE-1", addDays(today, 1)).expect(422);
    await u.sales
      .post("/v1/receipts", {
        customerId: ids.harbour,
        amount: 1,
        bank: "GTBank",
        bankRef: "X-0001",
        receivedOn: today,
      })
      .expect(403);
  });

  it("releases once payment covers the order, not before", async () => {
    const short = await u.finance
      .post(`/v1/orders/${ids.prepaidOrder}/release`)
      .expect(409);
    expect(short.body.message).toMatch(
      /₦10,000,000 paid and unused.*₦2,400,000 short/,
    );
    await receipt(ids.harbour, 2_400_000, "FT-2610-88190").expect(201);
    const r = await u.finance
      .post(`/v1/orders/${ids.prepaidOrder}/release`)
      .expect(200);
    expect(r.body.status).toBe("released");
  });

  it("invoices the released order once, and the account nets to zero", async () => {
    const inv = await u.finance
      .post(`/v1/orders/${ids.prepaidOrder}/invoice`)
      .expect(201);
    expect(inv.body).toMatchObject({
      total: 12_400_000,
      vat: 0,
      issuedOn: today,
      dueOn: today,
    });
    expect(inv.body.number).toMatch(/^INV-\d{4}-0001$/);
    expect(inv.body.lines[0]).toMatchObject({
      description: "Automotive gas oil (diesel)",
      quantity: 10_000,
    });
    await u.finance.post(`/v1/orders/${ids.prepaidOrder}/invoice`).expect(409);
    await u.sales
      .post(`/v1/orders/${ids.prepaidOrder}/cancel`, {
        reason: "Trying after invoice.",
      })
      .expect(409);
    expect(
      (await u.sales.get(`/v1/orders/${ids.prepaidOrder}`).expect(200)).body
        .status,
    ).toBe("invoiced");

    const st = await u.sales
      .get(`/v1/customers/${ids.harbour}/statement`)
      .expect(200);
    expect(st.body.balance).toBe(0);
    expect(
      st.body.entries.map((e: { kind: string; balance: number }) => [
        e.kind,
        e.balance,
      ]),
    ).toEqual([
      ["receipt", -10_000_000],
      ["receipt", -12_400_000],
      ["invoice", 0],
    ]);
  });
});

describe("credit customers", () => {
  it("takes payment against a held order and releases it", async () => {
    const first = await order(ids.riverside, ids.rSite, 20_000);
    expect(first.body.status).toBe("released");
    const inv = await u.finance
      .post(`/v1/orders/${first.body.id}/invoice`)
      .expect(201);
    expect(inv.body.dueOn).toBe(addDays(today, 30));

    const held = await order(ids.riverside, ids.rSite, 20_000);
    ids.heldOrder = held.body.id;
    expect(held.body.status).toBe("credit_hold");
    const still = await u.finance
      .post(`/v1/orders/${ids.heldOrder}/release`)
      .expect(409);
    expect(still.body.message).toMatch(/Still ₦14,600,000 over/);

    await receipt(ids.riverside, 20_000_000, "NIP-000123456").expect(201);
    expect(
      (await u.finance.post(`/v1/orders/${ids.heldOrder}/release`).expect(200))
        .body.status,
    ).toBe("released");
    const c = await u.sales.get(`/v1/customers/${ids.riverside}`).expect(200);
    expect(c.body.credit).toMatchObject({
      balance: 9_800_000,
      openOrders: 24_800_000,
      exposure: 34_600_000,
    });
  });

  it("shows VAT out of a VAT-inclusive price", async () => {
    await u.admin.patch("/v1/products/PMS", { vatRate: 0.075 }).expect(200);
    const o = await order(ids.riverside, ids.rSite, 1_000, "PMS");
    expect(o.body).toMatchObject({ status: "released", total: 950_000 });
    const inv = await u.finance
      .post(`/v1/orders/${o.body.id}/invoice`)
      .expect(201);
    expect(inv.body).toMatchObject({
      total: 950_000,
      vat: 66_279.07,
      subtotal: 883_720.93,
    });
    expect(inv.body.lines[0]).toMatchObject({
      vatRate: 0.075,
      vat: 66_279.07,
      amount: 883_720.93,
    });
  });

  it("reverses a wrong receipt only by a second person, keeping both entries", async () => {
    const r = await receipt(ids.riverside, 3_000_000, "NIP-WRONG-01").expect(
      201,
    );
    const why = { reason: "Paid by a different customer; wrong account." };
    await u.finance.post(`/v1/receipts/${r.body.id}/reverse`, why).expect(403);
    const rev = await u.finance2
      .post(`/v1/receipts/${r.body.id}/reverse`, why)
      .expect(200);
    expect(rev.body.reversedAt).toBeTruthy();
    await u.finance2.post(`/v1/receipts/${r.body.id}/reverse`, why).expect(409);
    const st = await u.finance
      .get(`/v1/customers/${ids.riverside}/statement`)
      .expect(200);
    expect(
      st.body.entries.slice(-2).map((e: { kind: string }) => e.kind),
    ).toEqual(["receipt", "receipt_reversal"]);
    expect(st.body.balance).toBe(10_750_000);
  });

  it("refuses to change or delete a ledger entry, even directly in the database", async () => {
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await expect(
        c.query("UPDATE customer_ledger SET amount = 0"),
      ).rejects.toThrow(/append-only/);
      await expect(c.query("DELETE FROM customer_ledger")).rejects.toThrow(
        /append-only/,
      );
    } finally {
      await c.end();
    }
  });
});

describe("receivables", () => {
  it("applies money to the oldest amount first and ages what is left", async () => {
    const now = await u.finance.get("/v1/receivables").expect(200);
    const r = now.body.customers.find(
      (x: { code: string }) => x.code === "CUS-107",
    );
    // ₦20m paid clears the ₦5m opening balance, then ₦15m of the first invoice.
    expect(r).toMatchObject({
      balance: 10_750_000,
      current: 10_750_000,
      overdue: 0,
      onAccount: 0,
    });
    expect(
      now.body.customers.find((x: { code: string }) => x.code === "CUS-210"),
    ).toBeUndefined();

    const later = await u.md
      .get(`/v1/receivables?asOf=${addDays(today, 45)}`)
      .expect(200);
    const l = later.body.customers.find(
      (x: { code: string }) => x.code === "CUS-107",
    );
    expect(l).toMatchObject({
      current: 0,
      "1-30": 10_750_000,
      overdue: 10_750_000,
    });
    expect(later.body.totals.overdue).toBe(10_750_000);
  });

  it("is visible to Sales and leadership, not to the depot", async () => {
    await u.sales.get("/v1/receivables").expect(200);
    await u.depot.get("/v1/receivables").expect(403);
    await u.depot.get(`/v1/customers/${ids.riverside}/statement`).expect(403);
  });
});
