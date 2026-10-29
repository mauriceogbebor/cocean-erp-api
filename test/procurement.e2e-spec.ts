import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { addDays, lagosDate } from "../src/common/dates.js";
import { ADMIN, as, freshDatabase, login, startApp } from "./harness.js";

let app: INestApplication;
const people = {
  buyer: {
    email: "femi@cocean.test",
    name: "Femi Ojo",
    roles: ["procurement"],
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
  exec: {
    email: "ifeanyi@cocean.test",
    name: "Ifeanyi Nwosu",
    roles: ["executive"],
  },
  depot: { email: "bayo@cocean.test", name: "Bayo Lawal", roles: ["depot"] },
  both: {
    email: "sade@cocean.test",
    name: "Sade Bakare",
    roles: ["procurement", "depot"],
  },
  sales: {
    email: "tunde@cocean.test",
    name: "Tunde Adeyemi",
    roles: ["sales"],
  },
};
type Who = keyof typeof people | "admin";
const PASSWORD = "a-good-long-password";
const u = {} as Record<Who, ReturnType<typeof as>>;
const today = lagosDate();
const ids = { site: "", vendor: "", po: "", line: "", bill: "" };

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
const tyres = (quantity = 40, unitPrice = 186_000) => ({
  description: "Tyre 315/80R22.5, steer axle",
  quantity,
  unit: "each",
  unitPrice,
  vatRate: 0.075,
});
const bill = (
  vendorInvoiceNo: string,
  quantity: number,
  unitPrice: number,
  statedTotal: number,
) =>
  u.finance.post("/v1/bills", {
    purchaseOrderId: ids.po,
    vendorInvoiceNo,
    invoiceDate: today,
    statedTotal,
    lines: [{ lineId: ids.line, quantity, unitPrice }],
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
  ids.site = (
    await u.admin
      .post("/v1/sites", {
        code: "ONN-DEP",
        name: "Onne depot",
        kind: "depot",
        state: "Rivers",
      })
      .expect(201)
  ).body.id;
});
afterAll(() => app?.close());

describe("suppliers and bank details", () => {
  it("holds new bank details until Finance verifies them", async () => {
    const r = await u.buyer
      .post("/v1/vendors", {
        code: "ven-031",
        name: "Delta Tyres & Parts Ltd",
        address: "22 Ikwerre Road, Port Harcourt",
        bank: {
          bankName: "Zenith Bank",
          accountNumber: "1012345678",
          accountName: "DELTA TYRES AND PARTS LTD",
          reason:
            "From the supplier's letterhead; confirmed by phone with their accounts.",
        },
      })
      .expect(201);
    ids.vendor = r.body.id;
    expect(r.body).toMatchObject({
      code: "VEN-031",
      bankStatus: "pending",
      accountNumber: null,
    });
    expect(r.body.pendingBankRequest).toMatchObject({
      kind: "vendor_bank",
      approverRole: "finance",
    });
    await decide("buyer", r.body.pendingBankRequest.id, "approved").expect(403);
    await decide("finance", r.body.pendingBankRequest.id, "approved").expect(
      200,
    );
    const v = await u.finance.get(`/v1/vendors/${ids.vendor}`).expect(200);
    expect(v.body).toMatchObject({
      bankStatus: "verified",
      accountNumber: "1012345678",
    });
  });

  it("keeps the old details when a change is refused", async () => {
    const r = await u.buyer
      .post(`/v1/vendors/${ids.vendor}/bank-details`, {
        bankName: "Opay",
        accountNumber: "8099999999",
        accountName: "DELTA TYRES",
        reason: "Email from the supplier asking us to pay a new account.",
      })
      .expect(201);
    expect(
      (await u.buyer.get(`/v1/vendors/${ids.vendor}`).expect(200)).body
        .bankStatus,
    ).toBe("pending");
    await decide(
      "finance2",
      r.body.id,
      "rejected",
      "Not confirmed by phone; looks like fraud.",
    ).expect(200);
    const v = await u.buyer.get(`/v1/vendors/${ids.vendor}`).expect(200);
    expect(v.body).toMatchObject({
      bankStatus: "verified",
      accountNumber: "1012345678",
      bankName: "Zenith Bank",
    });
  });

  it("keeps suppliers to the roles that need them", async () => {
    await u.sales.get("/v1/vendors").expect(403);
    await u.depot.post("/v1/vendors", {}).expect(403);
  });
});

describe("purchase orders and goods received", () => {
  it("prices the order with VAT and routes it by total", async () => {
    const r = await u.buyer
      .post("/v1/purchase-orders", {
        vendorId: ids.vendor,
        siteId: ids.site,
        justification: "Steer tyres for six trucks failing inspection.",
        quoteRef: "DT-Q-2210",
        lines: [tyres(36)],
      })
      .expect(201);
    ids.po = r.body.id;
    expect(r.body.number).toMatch(/^PO-\d{4}-0001$/);
    await u.buyer
      .put(`/v1/purchase-orders/${ids.po}/lines`, { lines: [tyres(40)] })
      .expect(200);
    const sub = await u.buyer
      .post(`/v1/purchase-orders/${ids.po}/submit`)
      .expect(200);
    expect(sub.body).toMatchObject({
      status: "pending",
      subtotal: 7_440_000,
      vat: 558_000,
      total: 7_998_000,
    });
    expect(sub.body.approval).toMatchObject({
      kind: "purchase_order",
      approverRole: "executive",
      amount: 7_998_000,
    });
    ids.line = sub.body.lines[0].id;

    await u.buyer
      .put(`/v1/purchase-orders/${ids.po}/lines`, { lines: [tyres(1)] })
      .expect(409);
    await u.buyer
      .post(`/v1/purchase-orders/${ids.po}/cancel`, {
        reason: "Changed our minds.",
      })
      .expect(409);
    await u.depot
      .post(`/v1/purchase-orders/${ids.po}/receipts`, {
        receivedOn: today,
        deliveryNote: "DN-1",
        lines: [{ lineId: ids.line, quantity: 1 }],
      })
      .expect(409);
    const f = await decide("finance", sub.body.approval.id, "approved").expect(
      403,
    );
    expect(f.body.message).toMatch(/outside your approval authority/);
    await decide("exec", sub.body.approval.id, "approved").expect(200);
    expect(
      (await u.buyer.get(`/v1/purchase-orders/${ids.po}`).expect(200)).body
        .status,
    ).toBe("approved");
  });

  it("lets the depot receive what was ordered, never more", async () => {
    const grn = (quantity: number, receivedOn = today) =>
      u.depot.post(`/v1/purchase-orders/${ids.po}/receipts`, {
        receivedOn,
        deliveryNote: "DT-WB-7781",
        lines: [{ lineId: ids.line, quantity }],
      });
    await u.buyer
      .post(`/v1/purchase-orders/${ids.po}/receipts`, {
        receivedOn: today,
        deliveryNote: "X1",
        lines: [{ lineId: ids.line, quantity: 1 }],
      })
      .expect(403);
    await grn(1, addDays(today, 1)).expect(422);
    const r = await grn(30).expect(201);
    expect(r.body.goodsReceipt.number).toMatch(/^GRN-\d{4}-0001$/);
    expect(r.body).toMatchObject({ status: "partially_received" });
    expect(r.body.lines[0]).toMatchObject({ received: 30 });
    const over = await grn(11).expect(422);
    expect(over.body.message).toMatch(/only 10 each still due/);
    await u.buyer
      .post(`/v1/purchase-orders/${ids.po}/cancel`, {
        reason: "Changed our minds.",
      })
      .expect(409);
  });

  it("won't let the person who raised an order receive it", async () => {
    const po = await u.both
      .post("/v1/purchase-orders", {
        vendorId: ids.vendor,
        siteId: ids.site,
        justification: "Small spares for the forklift.",
        lines: [
          {
            description: "Hydraulic hose",
            quantity: 2,
            unit: "each",
            unitPrice: 45_000,
            vatRate: 0.075,
          },
        ],
      })
      .expect(201);
    const sub = await u.both
      .post(`/v1/purchase-orders/${po.body.id}/submit`)
      .expect(200);
    expect(sub.body.approval.approverRole).toBe("finance");
    await decide("finance", sub.body.approval.id, "approved").expect(200);
    const r = await u.both
      .post(`/v1/purchase-orders/${po.body.id}/receipts`, {
        receivedOn: today,
        deliveryNote: "DN-77",
        lines: [{ lineId: sub.body.lines[0].id, quantity: 2 }],
      })
      .expect(403);
    expect(r.body.message).toMatch(/raised the order can't receive it/);
    const c = await u.both
      .post(`/v1/purchase-orders/${po.body.id}/cancel`, {
        reason: "Bought from petty cash instead.",
      })
      .expect(200);
    expect(c.body.status).toBe("cancelled");
  });
});

describe("supplier invoices and payment", () => {
  it("puts a bill for more than was received on exception, and won't pay it", async () => {
    const r = await bill("DT/INV/0931", 40, 186_000, 7_998_000).expect(201);
    expect(r.body.status).toBe("exception");
    expect(r.body.exceptions).toEqual([
      expect.stringMatching(/billed 40 each, but only 30 received/),
    ]);
    await u.finance.post(`/v1/bills/${r.body.id}/request-payment`).expect(409);
    await u.finance
      .post(`/v1/bills/${r.body.id}/void`, {
        reason: "Supplier to reissue for 30.",
      })
      .expect(200);
  });

  it("catches a price above the order and a total that doesn't add up", async () => {
    const r = await bill("DT/INV/0932", 30, 190_000, 6_200_000).expect(201);
    expect(r.body.exceptions).toEqual([
      expect.stringMatching(/price ₦190,000, the order says ₦186,000/),
      expect.stringMatching(/total ₦6,200,000 doesn't agree.*₦6,127,500/),
    ]);
    await u.finance
      .post(`/v1/bills/${r.body.id}/void`, {
        reason: "Wrong price; supplier to reissue.",
      })
      .expect(200);
  });

  it("matches a correct bill once, and never bills the same goods twice", async () => {
    const r = await bill("DT/INV/0933", 30, 186_000, 5_998_500).expect(201);
    ids.bill = r.body.id;
    expect(r.body).toMatchObject({
      status: "matched",
      exceptions: [],
      subtotal: 5_580_000,
      vat: 418_500,
      total: 5_998_500,
    });
    await bill("DT/INV/0933", 30, 186_000, 5_998_500).expect(409);
    const again = await bill("DT/INV/0934", 30, 186_000, 5_998_500).expect(201);
    expect(again.body.exceptions[0]).toMatch(
      /only 0 received and not yet billed/,
    );
    await u.finance
      .post(`/v1/bills/${again.body.id}/void`, {
        reason: "Duplicate of DT/INV/0933.",
      })
      .expect(200);
    expect(
      (await u.buyer.get(`/v1/purchase-orders/${ids.po}`).expect(200)).body
        .lines[0],
    ).toMatchObject({
      received: 30,
      billed: 30,
    });
  });

  it("needs a second person to approve payment, and checks the bank details again before paying", async () => {
    const req = await u.finance
      .post(`/v1/bills/${ids.bill}/request-payment`)
      .expect(200);
    expect(req.body).toMatchObject({
      status: "payment_pending",
      payTo: { accountNumber: "1012345678" },
    });
    expect(req.body.approval).toMatchObject({
      kind: "supplier_payment",
      approverRole: "finance",
      amount: 5_998_500,
    });
    await decide("finance", req.body.approval.id, "approved").expect(403);
    await decide("finance2", req.body.approval.id, "approved").expect(200);

    const p = await u.finance.get("/v1/payables").expect(200);
    expect(p.body.vendors[0]).toMatchObject({
      code: "VEN-031",
      owed: 5_998_500,
      exceptions: 0,
      stages: { approved: 5_998_500 },
    });

    // The bank details change after approval: the approval lapses.
    const change = await u.buyer
      .post(`/v1/vendors/${ids.vendor}/bank-details`, {
        bankName: "Access Bank",
        accountNumber: "0691234567",
        accountName: "DELTA TYRES AND PARTS LTD",
        reason: "Supplier moved banks; confirmed in person at their office.",
      })
      .expect(201);
    await decide("finance", change.body.id, "approved").expect(200);
    const paid = { paymentRef: "ZEN-TRF-55120", paidOn: today };
    const lapsed = await u.finance
      .post(`/v1/bills/${ids.bill}/paid`, paid)
      .expect(409);
    expect(lapsed.body.message).toMatch(/approval has lapsed/);
    expect(
      (await u.finance.get(`/v1/bills/${ids.bill}`).expect(200)).body.status,
    ).toBe("matched");

    const again = await u.finance
      .post(`/v1/bills/${ids.bill}/request-payment`)
      .expect(200);
    expect(again.body.payTo.accountNumber).toBe("0691234567");
    await decide("finance2", again.body.approval.id, "approved").expect(200);
    const done = await u.finance
      .post(`/v1/bills/${ids.bill}/paid`, paid)
      .expect(200);
    expect(done.body).toMatchObject({
      status: "paid",
      paymentRef: "ZEN-TRF-55120",
    });
    expect((await u.exec.get("/v1/payables").expect(200)).body.totalOwed).toBe(
      0,
    );
  });
});
