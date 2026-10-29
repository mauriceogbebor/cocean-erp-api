import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Client } from "pg";
import request from "supertest";
import { lagosDate } from "../src/common/dates.js";
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
  md: { email: "kelechi@cocean.test", name: "Kelechi Amadi", roles: ["md"] },
  ops: {
    email: "chinonso@cocean.test",
    name: "Chinonso Okafor",
    roles: ["operations"],
  },
  depot: { email: "sani@cocean.test", name: "Sani Garba", roles: ["depot"] },
  both: {
    email: "ada@cocean.test",
    name: "Ada Eke",
    roles: ["operations", "depot"],
  },
  security: {
    email: "musa@cocean.test",
    name: "Musa Abdullahi",
    roles: ["security"],
  },
  buyer: {
    email: "ifeoma@cocean.test",
    name: "Ifeoma Nnaji",
    roles: ["procurement"],
  },
};
type Who = keyof typeof people | "admin";
const PASSWORD = "a-good-long-password";
const u = {} as Record<Who, ReturnType<typeof as>>;
const today = lagosDate();
const ids = {
  depot: "",
  tank: "",
  vendor: "",
  po: "",
  poLine: "",
  customer: "",
  bridge: "",
  plant: "",
  order: "",
  lifting: "",
};
const links: string[] = [];
const drops: string[] = [];

const approve = (who: Who, id: string) =>
  u[who]
    .post(`/v1/approvals/${id}/decide`, { decision: "approved" })
    .expect(200);
const onHand = async () =>
  (await u.depot.get(`/v1/tanks/${ids.tank}`).expect(200)).body.onHand;
const confirm = (body: object) =>
  request(app.getHttpServer()).post("/v1/deliveries/confirm").send(body);

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
  ids.depot = (
    await u.admin
      .post("/v1/sites", {
        code: "ONN-DEP",
        name: "Onne depot",
        kind: "depot",
        state: "Rivers",
      })
      .expect(201)
  ).body.id;
  // A supplier with verified bank details, a customer on ₦60m credit, an approved price list.
  const v = await u.buyer
    .post("/v1/vendors", {
      code: "VEN-040",
      name: "Gulf Products Trading Ltd",
      address: "Plot 3, Trans-Amadi, Port Harcourt",
      bank: {
        bankName: "Access Bank",
        accountNumber: "0691111111",
        accountName: "GULF PRODUCTS TRADING",
        reason: "From their signed onboarding form.",
      },
    })
    .expect(201);
  ids.vendor = v.body.id;
  await approve("finance", v.body.pendingBankRequest.id);
  const c = await u.sales
    .post("/v1/customers", {
      code: "CUS-107",
      name: "Riverside Construction Ltd",
      kind: "industrial",
      address: "12 Aba Road, Port Harcourt",
      requestedTerms: {
        terms: "credit",
        creditLimit: 60_000_000,
        creditDays: 30,
        reason: "Two bridge sites running together.",
      },
    })
    .expect(201);
  ids.customer = c.body.id;
  await approve("md", c.body.pendingTermsRequest.id);
  const site = (name: string) => ({
    name,
    address: "Km 14 East-West Road, Eleme",
    state: "Rivers",
    receiverName: "Grace Nwankwo",
    receiverPhone: "08031234567",
  });
  ids.bridge = (
    await u.sales
      .post(`/v1/customers/${ids.customer}/sites`, site("Bridge site"))
      .expect(201)
  ).body.id;
  ids.plant = (
    await u.sales
      .post(`/v1/customers/${ids.customer}/sites`, site("Batching plant"))
      .expect(201)
  ).body.id;
  const pl = await u.sales
    .post("/v1/price-lists", {
      code: "PL-2026-10",
      validFrom: today,
      lines: [{ productCode: "AGO", price: 1240 }],
    })
    .expect(201);
  await approve(
    "md",
    (await u.sales.post(`/v1/price-lists/${pl.body.id}/submit`).expect(200))
      .body.approval.id,
  );
});
afterAll(() => app?.close());

describe("tanks and stock", () => {
  it("sets up a tank with its opening stock; only the administrator can", async () => {
    const tank = {
      siteId: ids.depot,
      code: "onn-t01",
      productCode: "AGO",
      capacity: 1_000_000,
      safeCapacity: 950_000,
      openingStock: 100_000,
    };
    await u.depot.post("/v1/tanks", tank).expect(403);
    await u.admin
      .post("/v1/tanks", { ...tank, safeCapacity: 1_100_000 })
      .expect(400);
    ids.tank = (await u.admin.post("/v1/tanks", tank).expect(201)).body.id;
    const list = await u.ops.get(`/v1/tanks?siteId=${ids.depot}`).expect(200);
    expect(list.body[0]).toMatchObject({
      code: "ONN-T01",
      onHand: 100_000,
      ullage: 850_000,
      unit: "L",
    });
  });

  it("receives bought product into a tank, never above its safe capacity", async () => {
    const po = await u.buyer
      .post("/v1/purchase-orders", {
        vendorId: ids.vendor,
        siteId: ids.depot,
        justification: "Restock AGO at Onne ahead of the November contracts.",
        lines: [
          {
            productCode: "AGO",
            description: "AGO, bulk",
            quantity: 900_000,
            unit: "L",
            unitPrice: 1000,
            vatRate: 0.075,
          },
        ],
      })
      .expect(201);
    ids.po = po.body.id;
    ids.poLine = po.body.lines[0].id;
    const sub = await u.buyer
      .post(`/v1/purchase-orders/${ids.po}/submit`)
      .expect(200);
    expect(sub.body.approval.approverRole).toBe("md");
    await approve("md", sub.body.approval.id);

    const receive = (quantity: number, tankId?: string) =>
      u.depot.post(`/v1/purchase-orders/${ids.po}/receipts`, {
        receivedOn: today,
        deliveryNote: "GPT-WB-2210",
        lines: [
          { lineId: ids.poLine, quantity, ...(tankId ? { tankId } : {}) },
        ],
      });
    const noTank = await receive(400_000).expect(422);
    expect(noTank.body.message).toMatch(
      /choose the tank it went into \(ONN-T01\)/,
    );
    await receive(400_000, ids.tank).expect(201);
    expect(await onHand()).toBe(500_000);
    const full = await receive(500_000, ids.tank).expect(422);
    expect(full.body.message).toMatch(/above its safe capacity of 950,000/);
    await receive(300_000, ids.tank).expect(201);
    expect(await onHand()).toBe(800_000);
  });

  it("books a dip within tolerance at once", async () => {
    const d = await u.depot
      .post(`/v1/tanks/${ids.tank}/dips`, {
        quantity: 799_500,
        temperature: 31.5,
        dippedOn: today,
      })
      .expect(201);
    expect(d.body).toMatchObject({
      status: "within_tolerance",
      book: 800_000,
      variance: -500,
      approval: null,
    });
    expect(await onHand()).toBe(799_500);
  });

  it("holds a dip beyond tolerance until Operations approves the variance", async () => {
    const d = await u.depot
      .post(`/v1/tanks/${ids.tank}/dips`, {
        quantity: 790_000,
        dippedOn: today,
        notes: "Checked twice.",
      })
      .expect(201);
    expect(d.body).toMatchObject({
      status: "variance_pending",
      variance: -9_500,
    });
    expect(d.body.approval).toMatchObject({
      kind: "variance",
      approverRole: "operations",
      amount: 11_780_000,
    });
    expect(await onHand()).toBe(799_500);
    await u.depot
      .post(`/v1/tanks/${ids.tank}/dips`, {
        quantity: 790_000,
        dippedOn: today,
      })
      .expect(409);
    await u.depot
      .post(`/v1/approvals/${d.body.approval.id}/decide`, {
        decision: "approved",
      })
      .expect(403);
    await approve("ops", d.body.approval.id);
    expect(await onHand()).toBe(790_000);
    const t = await u.ops.get(`/v1/tanks/${ids.tank}`).expect(200);
    expect(t.body.dips[0].status).toBe("variance_approved");
    expect(t.body.movements[0]).toMatchObject({
      kind: "variance_adjustment",
      quantity: -9_500,
    });
  });

  it("refuses to change a stock movement, even directly in the database", async () => {
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    try {
      await expect(
        c.query("UPDATE stock_movements SET quantity = 0"),
      ).rejects.toThrow(/append-only/);
      await expect(c.query("DELETE FROM stock_movements")).rejects.toThrow(
        /append-only/,
      );
    } finally {
      await c.end();
    }
  });
});

describe("loading and delivery", () => {
  it("plans one truck for two drops against a released order", async () => {
    const o = await u.sales
      .post("/v1/orders", {
        customerId: ids.customer,
        poRef: "RC-PO-91",
        lines: [
          { productCode: "AGO", quantity: 20_000, deliverySiteId: ids.bridge },
          { productCode: "AGO", quantity: 20_000, deliverySiteId: ids.plant },
        ],
      })
      .expect(201);
    expect(o.body.status).toBe("released");
    ids.order = o.body.id;
    const truck = {
      orderId: ids.order,
      siteId: ids.depot,
      truckPlate: "riv430bn",
      driverName: "Sunday Okon",
      driverPhone: "08051234567",
    };
    await u.depot.post("/v1/liftings", { ...truck, drops: [] }).expect(403);
    const l = await u.ops
      .post("/v1/liftings", {
        ...truck,
        drops: o.body.lines.map((x: { id: string }) => ({
          orderLineId: x.id,
          quantity: 20_000,
        })),
      })
      .expect(201);
    ids.lifting = l.body.id;
    expect(l.body).toMatchObject({
      status: "planned",
      truckPlate: "RIV-430-BN",
    });
    expect(l.body.number).toMatch(/^LI-\d{4}-0001$/);
    drops.push(...l.body.drops.map((d: { id: string }) => d.id));

    const more = await u.ops
      .post("/v1/liftings", {
        ...truck,
        drops: [{ orderLineId: o.body.lines[0].id, quantity: 1 }],
      })
      .expect(422);
    expect(more.body.message).toMatch(/only 0 is still to load/);
    const whole = await u.finance
      .post(`/v1/orders/${ids.order}/invoice`)
      .expect(409);
    expect(whole.body.message).toMatch(/invoice each delivery/);
  });

  it("loads from the meter, takes stock out, and issues one link per drop", async () => {
    const load = (overrides: Partial<{ q: number; seals: string[][] }> = {}) =>
      u.depot.post(`/v1/liftings/${ids.lifting}/load`, {
        drops: drops.map((dropId, i) => ({
          dropId,
          tankId: ids.tank,
          loadedQuantity: i === 0 && overrides.q ? overrides.q : 20_000,
          seals:
            overrides.seals?.[i] ??
            (i === 0 ? ["S-1001", "S-1002"] : ["S-1003"]),
        })),
      });
    await load({ q: 20_100 }).expect(422);
    const dup = await load({ seals: [["S-1001"], ["S-1001"]] }).expect(422);
    expect(dup.body.message).toMatch(/seal number is used twice/);
    const r = await load().expect(200);
    expect(r.body.status).toBe("in_transit");
    expect(r.body.deliveryLinks).toHaveLength(2);
    links.push(
      ...drops.map(
        (id) =>
          r.body.deliveryLinks.find((x: { dropId: string }) => x.dropId === id)
            .token,
      ),
    );
    expect(JSON.stringify(r.body.drops)).not.toContain("tokenHash");
    expect(await onHand()).toBe(750_000);
    const again = await u.ops.get(`/v1/liftings/${ids.lifting}`).expect(200);
    expect(again.body).not.toHaveProperty("deliveryLinks");
    expect(again.body.drops[0].seals).toEqual(["S-1001", "S-1002"]);
    const sales = await u.sales.get(`/v1/liftings/${ids.lifting}`).expect(200);
    expect(sales.body.drops[0].seals).toBeNull();
  });

  it("confirms a delivery blind, once, and tells the receiver nothing about the check", async () => {
    const r = await confirm({
      token: links[0],
      receiverName: "Grace Nwankwo",
      receivedQuantity: 19_990,
      seals: ["s-1002", "S-1001"],
    }).expect(200);
    expect(r.body).toEqual({
      recorded: true,
      reference: expect.stringMatching(/^LI-/),
      message: expect.stringMatching(/recorded/),
    });
    await confirm({
      token: links[0],
      receiverName: "Grace Nwankwo",
      receivedQuantity: 19_990,
      seals: ["S-1001"],
    }).expect(404);
    const l = await u.ops.get(`/v1/liftings/${ids.lifting}`).expect(200);
    expect(
      l.body.drops.find((d: { id: string }) => d.id === drops[0]),
    ).toMatchObject({ status: "delivered", exceptions: [] });
    expect(l.body.status).toBe("in_transit");
  });

  it("turns wrong seals or a short delivery into an exception, without saying so to the receiver", async () => {
    const r = await confirm({
      token: links[1],
      receiverName: "Emeka Ude",
      receivedQuantity: 19_000,
      seals: ["S-9999"],
    }).expect(200);
    expect(JSON.stringify(r.body)).not.toMatch(/S-1003|short|seal/i);
    const l = await u.security.get(`/v1/liftings/${ids.lifting}`).expect(200);
    expect(l.body.status).toBe("exception");
    expect(
      l.body.drops.find((d: { id: string }) => d.id === drops[1]).exceptions,
    ).toEqual([
      expect.stringMatching(/seals the receiver entered don't match/),
      expect.stringMatching(/short by 1,000 \(5.00%\)/),
    ]);
  });

  it("invoices each confirmed delivery for what was received; an exception waits for Security", async () => {
    const first = await u.finance
      .post(`/v1/deliveries/${drops[0]}/invoice`)
      .expect(201);
    expect(first.body).toMatchObject({ total: 24_787_600, dropId: drops[0] });
    expect(first.body.lines[0]).toMatchObject({ quantity: 19_990 });
    await u.finance.post(`/v1/deliveries/${drops[0]}/invoice`).expect(409);
    const held = await u.finance
      .post(`/v1/deliveries/${drops[1]}/invoice`)
      .expect(409);
    expect(held.body.message).toMatch(/open exception/);

    const c = await u.sales.get(`/v1/customers/${ids.customer}`).expect(200);
    // ₦49.6m ordered: ₦24.79m invoiced is on the ledger, the rest still counts as open.
    expect(c.body.credit).toMatchObject({
      balance: 24_787_600,
      openOrders: 24_812_400,
      exposure: 49_600_000,
    });

    const finding = {
      finding:
        "Seal S-1003 cut at a stop in Eleme; driver suspended, transporter charged for 1,000 L.",
    };
    await u.sales
      .post(`/v1/deliveries/${drops[1]}/resolve`, finding)
      .expect(403);
    await u.security
      .post(`/v1/deliveries/${drops[1]}/resolve`, { finding: "short" })
      .expect(400);
    await u.security
      .post(`/v1/deliveries/${drops[1]}/resolve`, finding)
      .expect(200);
    expect(
      (await u.ops.get(`/v1/liftings/${ids.lifting}`).expect(200)).body.status,
    ).toBe("delivered");

    const second = await u.finance
      .post(`/v1/deliveries/${drops[1]}/invoice`)
      .expect(201);
    expect(second.body.total).toBe(23_560_000);
    expect(
      (await u.sales.get(`/v1/orders/${ids.order}`).expect(200)).body.status,
    ).toBe("invoiced");
    const after = await u.sales
      .get(`/v1/customers/${ids.customer}`)
      .expect(200);
    expect(after.body.credit).toMatchObject({
      balance: 48_347_600,
      openOrders: 0,
    });
  });

  it("keeps planning and loading with different people, and expires old links", async () => {
    const o = await u.sales
      .post("/v1/orders", {
        customerId: ids.customer,
        poRef: "RC-PO-92",
        lines: [
          { productCode: "AGO", quantity: 1_000, deliverySiteId: ids.bridge },
        ],
      })
      .expect(201);
    const l = await u.both
      .post("/v1/liftings", {
        orderId: o.body.id,
        siteId: ids.depot,
        truckPlate: "ABA-207-AA",
        driverName: "Kunle Bakare",
        driverPhone: "08061234567",
        drops: [{ orderLineId: o.body.lines[0].id, quantity: 1_000 }],
      })
      .expect(201);
    const body = {
      drops: [
        {
          dropId: l.body.drops[0].id,
          tankId: ids.tank,
          loadedQuantity: 1_000,
          seals: ["S-2001"],
        },
      ],
    };
    const r = await u.both
      .post(`/v1/liftings/${l.body.id}/load`, body)
      .expect(403);
    expect(r.body.message).toMatch(/planned the truck can't also load it/);
    const loaded = await u.depot
      .post(`/v1/liftings/${l.body.id}/load`, body)
      .expect(200);

    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    await c.query(
      "UPDATE lifting_drops SET token_expires_at = now() - interval '1 minute' WHERE id = $1",
      [l.body.drops[0].id],
    );
    await c.end();
    await confirm({
      token: loaded.body.deliveryLinks[0].token,
      receiverName: "Grace Nwankwo",
      receivedQuantity: 1_000,
      seals: ["S-2001"],
    }).expect(410);
    await u.ops
      .post(`/v1/liftings/${l.body.id}/cancel`, {
        reason: "Trying to cancel a loaded truck.",
      })
      .expect(409);
  });
});
