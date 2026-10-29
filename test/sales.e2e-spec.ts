import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { lagosDate } from "../src/common/dates.js";
import { ADMIN, as, freshDatabase, login, startApp } from "./harness.js";

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
  md: { email: "kelechi@cocean.test", name: "Kelechi Amadi", roles: ["md"] },
  ops: {
    email: "chidi@cocean.test",
    name: "Chidi Okafor",
    roles: ["operations"],
  },
  depot: { email: "bayo@cocean.test", name: "Bayo Lawal", roles: ["depot"] },
};
type Who = keyof typeof people;
const PASSWORD = "a-good-long-password";
const u = {} as Record<Who, ReturnType<typeof as>>;

const site = (name: string) => ({
  name,
  address: "Plot 4, Trans-Amadi Industrial Layout",
  state: "Rivers",
  receiverName: "Grace Eze",
  receiverPhone: "08031234567",
});
const decide = (
  who: Who,
  id: string,
  decision: "approved" | "rejected",
  note?: string,
) =>
  u[who].post(`/v1/approvals/${id}/decide`, {
    decision,
    ...(note ? { note } : {}),
  });

const ids = {
  riverside: "",
  riversideSite: "",
  harbour: "",
  harbourSite: "",
  list: "",
};

beforeAll(async () => {
  await freshDatabase();
  app = await startApp();
  const admin = as(
    app,
    (await login(app, ADMIN.email, ADMIN.password)).accessToken,
  );
  for (const [k, p] of Object.entries(people)) {
    await admin.post("/v1/users", { ...p, password: PASSWORD }).expect(201);
    u[k as Who] = as(app, (await login(app, p.email, PASSWORD)).accessToken);
  }
});
afterAll(() => app?.close());

describe("customers and credit terms", () => {
  it("starts a new customer on prepaid and sends the credit asked for to Finance", async () => {
    const r = await u.sales
      .post("/v1/customers", {
        code: "cus-107",
        name: "Riverside Construction Ltd",
        kind: "industrial",
        address: "12 Aba Road, Port Harcourt",
        openingBalance: 5_000_000,
        requestedTerms: {
          terms: "credit",
          creditLimit: 40_000_000,
          creditDays: 30,
          reason: "Three years with us, pays in 27 days on average.",
        },
      })
      .expect(201);
    expect(r.body).toMatchObject({
      code: "CUS-107",
      terms: "prepaid",
      creditLimit: 0,
    });
    expect(r.body.pendingTermsRequest).toMatchObject({
      kind: "credit_limit",
      approverRole: "finance",
      status: "pending",
    });
    ids.riverside = r.body.id;
    const s = await u.sales
      .post(`/v1/customers/${ids.riverside}/sites`, site("Bridge site"))
      .expect(201);
    ids.riversideSite = s.body.id;

    // The maker can't approve their own customer's credit.
    await decide("sales", r.body.pendingTermsRequest.id, "approved").expect(
      403,
    );
    await decide("finance", r.body.pendingTermsRequest.id, "approved").expect(
      200,
    );

    const c = await u.sales.get(`/v1/customers/${ids.riverside}`).expect(200);
    expect(c.body).toMatchObject({
      terms: "credit",
      creditLimit: 40_000_000,
      creditDays: 30,
    });
    expect(c.body.credit).toMatchObject({
      limit: 40_000_000,
      balance: 5_000_000,
      available: 35_000_000,
    });
  });

  it("routes a big limit to the MD and changes nothing until it is decided", async () => {
    const r = await u.sales
      .post(`/v1/customers/${ids.riverside}/credit-terms`, {
        terms: "credit",
        creditLimit: 60_000_000,
        creditDays: 45,
        reason: "New contract for the second bridge.",
      })
      .expect(201);
    expect(r.body.approverRole).toBe("md");
    await u.sales
      .post(`/v1/customers/${ids.riverside}/credit-terms`, {
        terms: "credit",
        creditLimit: 70_000_000,
        creditDays: 45,
        reason: "Asking again while one is pending.",
      })
      .expect(409);
    await decide(
      "md",
      r.body.id,
      "rejected",
      "Keep it at 40m until the first bridge is paid.",
    ).expect(200);
    const c = await u.sales.get(`/v1/customers/${ids.riverside}`).expect(200);
    expect(c.body.creditLimit).toBe(40_000_000);
  });

  it("keeps customers away from roles that don't need them", async () => {
    await u.depot.get("/v1/customers").expect(403);
    await u.ops.get("/v1/customers").expect(200);
    await u.ops.post("/v1/customers", {}).expect(403);
  });

  it("adds a prepaid customer", async () => {
    const r = await u.sales
      .post("/v1/customers", {
        code: "CUS-210",
        name: "Harbour Fuels Ltd",
        kind: "reseller",
        address: "3 Wharf Road, Apapa, Lagos",
      })
      .expect(201);
    expect(r.body.pendingTermsRequest).toBeNull();
    ids.harbour = r.body.id;
    ids.harbourSite = (
      await u.sales
        .post(`/v1/customers/${ids.harbour}/sites`, site("Apapa depot"))
        .expect(201)
    ).body.id;
    await u.sales
      .post("/v1/customers", {
        code: "CUS-210",
        name: "Dup Ltd",
        kind: "reseller",
        address: "Somewhere 1",
      })
      .expect(409);
  });
});

describe("price lists", () => {
  const order = () => ({
    customerId: ids.harbour,
    poRef: "HF-PO-881",
    lines: [
      { productCode: "AGO", quantity: 10_000, deliverySiteId: ids.harbourSite },
    ],
  });

  it("refuses to price an order before any list is approved", async () => {
    const r = await u.sales.post("/v1/orders", order()).expect(422);
    expect(r.body.message).toMatch(/No approved price list/);
  });

  it("needs the MD to approve a list, and freezes it while pending", async () => {
    const created = await u.sales
      .post("/v1/price-lists", {
        code: "PL-2026-10",
        validFrom: lagosDate(),
        lines: [
          { productCode: "AGO", price: 1240 },
          { productCode: "PMS", price: 950 },
        ],
      })
      .expect(201);
    ids.list = created.body.id;
    expect(created.body.status).toBe("draft");

    const sub = await u.sales
      .post(`/v1/price-lists/${ids.list}/submit`)
      .expect(200);
    expect(sub.body.approval).toMatchObject({
      kind: "price_list",
      approverRole: "md",
    });
    await u.sales
      .put(`/v1/price-lists/${ids.list}/lines`, {
        lines: [{ productCode: "AGO", price: 1 }],
      })
      .expect(409);
    await u.sales.post("/v1/orders", order()).expect(422);

    // Rejected goes back to draft for Sales to fix and resubmit.
    await decide(
      "md",
      sub.body.approval.id,
      "rejected",
      "AGO is below cost; recheck.",
    ).expect(200);
    expect(
      (await u.sales.get(`/v1/price-lists/${ids.list}`).expect(200)).body
        .status,
    ).toBe("draft");
    await u.sales
      .put(`/v1/price-lists/${ids.list}/lines`, {
        lines: [
          { productCode: "AGO", price: 1240 },
          { productCode: "PMS", price: 950 },
        ],
      })
      .expect(200);
    const again = await u.sales
      .post(`/v1/price-lists/${ids.list}/submit`)
      .expect(200);
    await decide("md", again.body.approval.id, "approved").expect(200);

    const inForce = await u.sales.get("/v1/price-lists/in-force").expect(200);
    expect(inForce.body).toMatchObject({
      code: "PL-2026-10",
      status: "approved",
    });
  });

  it("ignores a newer list that isn't approved yet", async () => {
    await u.sales
      .post("/v1/price-lists", {
        code: "PL-2026-11",
        validFrom: lagosDate(),
        lines: [{ productCode: "AGO", price: 9999 }],
      })
      .expect(201);
    expect(
      (await u.sales.get("/v1/price-lists/in-force").expect(200)).body.code,
    ).toBe("PL-2026-10");
  });

  it("refuses an unknown product", async () => {
    await u.sales
      .post("/v1/price-lists", {
        code: "PL-2026-12",
        validFrom: lagosDate(),
        lines: [{ productCode: "XYZ", price: 10 }],
      })
      .expect(422);
  });
});

describe("sales orders", () => {
  const line = (
    quantity: number,
    deliverySiteId = ids.riversideSite,
    productCode = "AGO",
  ) => ({
    productCode,
    quantity,
    deliverySiteId,
  });
  const riverside = (lines: ReturnType<typeof line>[], poRef = "RC-PO-1") => ({
    customerId: ids.riverside,
    poRef,
    lines,
  });

  it("sends a prepaid order to wait for payment, at the list price whatever is typed", async () => {
    const r = await u.sales
      .post("/v1/orders", {
        customerId: ids.harbour,
        poRef: "HF-PO-881",
        lines: [{ ...line(10_000, ids.harbourSite), unitPrice: 1 }],
      })
      .expect(201);
    expect(r.body).toMatchObject({
      status: "awaiting_payment",
      terms: "prepaid",
      total: 12_400_000,
    });
    expect(r.body.number).toMatch(/^SO-\d{4}-0001$/);
    expect(r.body.lines[0]).toMatchObject({
      unitPrice: 1240,
      amount: 12_400_000,
      unit: "L",
    });
  });

  it("releases a credit order within the limit", async () => {
    const r = await u.sales
      .post("/v1/orders", riverside([line(20_000)]))
      .expect(201);
    expect(r.body).toMatchObject({ status: "released", total: 24_800_000 });
    expect(r.body.number).toMatch(/-0002$/);
    expect(r.body.releasedAt).toBeTruthy();
    const c = await u.sales.get(`/v1/customers/${ids.riverside}`).expect(200);
    expect(c.body.credit).toMatchObject({
      openOrders: 24_800_000,
      exposure: 29_800_000,
    });
  });

  it("refuses a delivery site that isn't the customer's, and a product not on the list", async () => {
    await u.sales
      .post("/v1/orders", riverside([line(1000, ids.harbourSite)]))
      .expect(422);
    const r = await u.sales
      .post("/v1/orders", riverside([line(1000, ids.riversideSite, "DPK")]))
      .expect(422);
    expect(r.body.message).toMatch(/isn't on price list PL-2026-10/);
  });

  it("puts an order over the limit on hold; the MD's approval releases it", async () => {
    const held = await u.sales
      .post("/v1/orders", riverside([line(20_000)], "RC-PO-2"))
      .expect(201);
    expect(held.body).toMatchObject({ status: "credit_hold" });
    expect(held.body.creditCheck).toMatchObject({
      limit: 40_000_000,
      exposure: 54_600_000,
      over: 14_600_000,
    });

    await u.sales
      .post(`/v1/orders/${held.body.id}/override`, { reason: "short" })
      .expect(400);
    const o = await u.sales
      .post(`/v1/orders/${held.body.id}/override`, {
        reason: "Bridge pour can't wait; pays in 27 days.",
      })
      .expect(200);
    expect(o.body).toMatchObject({ status: "override_pending" });
    expect(o.body.approval).toMatchObject({
      kind: "credit_override",
      approverRole: "md",
      amount: 24_800_000,
    });
    expect(o.body.approval.reason).toMatch(/over\)$/);

    await u.sales
      .post(`/v1/orders/${held.body.id}/cancel`, {
        reason: "Customer changed plans.",
      })
      .expect(409);
    await decide("finance", o.body.approval.id, "approved").expect(403);
    await decide("md", o.body.approval.id, "approved", "One-off.").expect(200);

    const after = await u.ops.get(`/v1/orders/${held.body.id}`).expect(200);
    expect(after.body).toMatchObject({ status: "released" });
    expect(after.body.releasedAt).toBeTruthy();
  });

  it("puts a refused override back on hold, where it can be cancelled", async () => {
    const held = await u.sales
      .post("/v1/orders", riverside([line(5_000)], "RC-PO-3"))
      .expect(201);
    expect(held.body.status).toBe("credit_hold");
    const o = await u.sales
      .post(`/v1/orders/${held.body.id}/override`, {
        reason: "Small top-up for the site generator.",
      })
      .expect(200);
    await decide(
      "md",
      o.body.approval.id,
      "rejected",
      "Collect the first invoice first.",
    ).expect(200);
    expect(
      (await u.sales.get(`/v1/orders/${held.body.id}`).expect(200)).body.status,
    ).toBe("credit_hold");

    const c = await u.sales
      .post(`/v1/orders/${held.body.id}/cancel`, {
        reason: "Customer will pay first.",
      })
      .expect(200);
    expect(c.body).toMatchObject({
      status: "cancelled",
      cancelledReason: "Customer will pay first.",
    });
    await u.sales
      .post(`/v1/orders/${held.body.id}/cancel`, {
        reason: "Customer will pay first.",
      })
      .expect(409);
  });

  it("won't cancel a released order, and only Sales enters orders", async () => {
    const list = await u.ops.get("/v1/orders?status=released").expect(200);
    expect(list.body.length).toBe(2);
    await u.sales
      .post(`/v1/orders/${list.body[0].id}/cancel`, {
        reason: "Trying to cancel.",
      })
      .expect(409);
    await u.ops.post("/v1/orders", riverside([line(1)])).expect(403);
    await u.depot.get("/v1/orders").expect(403);
  });
});
