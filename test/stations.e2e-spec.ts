import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { addDays, lagosDate } from "../src/common/dates.js";
import { ADMIN, as, freshDatabase, login, startApp } from "./harness.js";

let app: INestApplication;
const people = {
  blessing: {
    email: "blessing@cocean.test",
    name: "Blessing Okoro",
    roles: ["station"],
  },
  other: {
    email: "ijeoma@cocean.test",
    name: "Ijeoma Uche",
    roles: ["station"],
  },
  obinna: { email: "obinna@cocean.test", name: "Obinna Kalu", roles: ["lpg"] },
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
  ops: {
    email: "chinonso@cocean.test",
    name: "Chinonso Okafor",
    roles: ["operations"],
  },
  md: { email: "kelechi@cocean.test", name: "Kelechi Amadi", roles: ["md"] },
};
type Who = keyof typeof people | "admin";
const PASSWORD = "a-good-long-password";
const u = {} as Record<Who, ReturnType<typeof as>>;
const userIds = {} as Record<Who, string>;
const today = lagosDate();
const ids = {
  station: "",
  plant: "",
  t1: "",
  t2: "",
  lpgTank: "",
  p1: "",
  p2: "",
  p3: "",
  shift2: "",
};

const tank = (
  siteId: string,
  code: string,
  productCode: string,
  openingStock: number,
) =>
  u.admin
    .post("/v1/tanks", {
      siteId,
      code,
      productCode,
      capacity: 33_000,
      safeCapacity: 31_350,
      openingStock,
    })
    .expect(201);
const onHand = async (id: string) =>
  (await u.ops.get(`/v1/tanks/${id}`).expect(200)).body.onHand;
const close = (who: Who, body: Record<string, unknown>) =>
  u[who].post("/v1/shifts", {
    siteId: ids.station,
    shiftDate: today,
    period: "day",
    ...body,
  });

beforeAll(async () => {
  await freshDatabase();
  app = await startApp();
  u.admin = as(
    app,
    (await login(app, ADMIN.email, ADMIN.password)).accessToken,
  );
  for (const [k, p] of Object.entries(people)) {
    userIds[k as Who] = (
      await u.admin.post("/v1/users", { ...p, password: PASSWORD }).expect(201)
    ).body.id;
    u[k as Who] = as(app, (await login(app, p.email, PASSWORD)).accessToken);
  }
  ids.station = (
    await u.admin
      .post("/v1/sites", {
        code: "OWR-01",
        name: "Owerri station",
        kind: "station",
        state: "Imo",
      })
      .expect(201)
  ).body.id;
  ids.plant = (
    await u.admin
      .post("/v1/sites", {
        code: "ABA-LPG",
        name: "Aba LPG plant",
        kind: "lpg_plant",
        state: "Abia",
      })
      .expect(201)
  ).body.id;
  ids.t1 = (await tank(ids.station, "OWR-T1", "PMS", 20_000)).body.id;
  ids.t2 = (await tank(ids.station, "OWR-T2", "AGO", 15_000)).body.id;
  ids.lpgTank = (
    await u.admin
      .post("/v1/tanks", {
        siteId: ids.plant,
        code: "ABA-T1",
        productCode: "LPG",
        capacity: 20_000,
        safeCapacity: 17_000,
        openingStock: 10_000,
      })
      .expect(201)
  ).body.id;
  const pump = (code: string, tankId: string, openingMeter: number) =>
    u.admin
      .post("/v1/pumps", { siteId: ids.station, tankId, code, openingMeter })
      .expect(201);
  ids.p1 = (await pump("P1", ids.t1, 100_000)).body.id;
  ids.p2 = (await pump("P2", ids.t1, 50_000)).body.id;
  ids.p3 = (await pump("P3", ids.t2, 80_000)).body.id;
  const pl = await u.sales
    .post("/v1/price-lists", {
      code: "PL-2026-10",
      validFrom: today,
      lines: [
        { productCode: "PMS", price: 950 },
        { productCode: "AGO", price: 1240 },
        { productCode: "LPG", price: 1050 },
      ],
    })
    .expect(201);
  const sub = await u.sales
    .post(`/v1/price-lists/${pl.body.id}/submit`)
    .expect(200);
  await u.md
    .post(`/v1/approvals/${sub.body.approval.id}/decide`, {
      decision: "approved",
    })
    .expect(200);
});
afterAll(() => app?.close());

describe("who works where", () => {
  it("lets only the administrator assign people to sites, and only assigned people work there", async () => {
    await u.blessing
      .put(`/v1/users/${userIds.blessing}/sites`, { siteIds: [ids.station] })
      .expect(403);
    await u.admin
      .put(`/v1/users/${userIds.blessing}/sites`, { siteIds: [ids.station] })
      .expect(200);
    await u.admin
      .put(`/v1/users/${userIds.obinna}/sites`, { siteIds: [ids.plant] })
      .expect(200);
    const r = await u.other
      .post(`/v1/tanks/${ids.t1}/receipts`, {
        quantity: 5_000,
        waybill: "WB-1",
        receivedOn: today,
      })
      .expect(403);
    expect(r.body.message).toMatch(/aren't assigned to Owerri station/);
  });

  it("receives a delivery into the station's tank against its waybill", async () => {
    await u.blessing
      .post(`/v1/tanks/${ids.t1}/receipts`, {
        quantity: 5_000,
        waybill: "li-2026-0031",
        receivedOn: today,
      })
      .expect(201);
    expect(await onHand(ids.t1)).toBe(25_000);
    const t = await u.ops.get(`/v1/tanks/${ids.t1}`).expect(200);
    expect(t.body.movements[0]).toMatchObject({
      kind: "receipt",
      ref: "WB LI-2026-0031",
      quantity: 5_000,
    });
  });
});

describe("shift close", () => {
  const dayMeters = () => [
    { pumpId: ids.p1, closing: 101_500 },
    { pumpId: ids.p2, closing: 50_800 },
    { pumpId: ids.p3, closing: 80_600 },
  ];

  it("needs every pump and every tank", async () => {
    const r = await close("blessing", {
      meters: dayMeters().slice(0, 2),
      dips: [
        { tankId: ids.t1, quantity: 1 },
        { tankId: ids.t2, quantity: 1 },
      ],
      takings: { cash: 0, pos: 0, transfer: 0 },
    }).expect(422);
    expect(r.body.message).toMatch(/Read every pump: P3 missing/);
    const d = await close("blessing", {
      meters: dayMeters(),
      dips: [{ tankId: ids.t1, quantity: 1 }],
      takings: { cash: 0, pos: 0, transfer: 0 },
    }).expect(422);
    expect(d.body.message).toMatch(/Dip every tank: OWR-T2 missing/);
  });

  it("balances when takings and tanks agree with the meters, booking small dip differences", async () => {
    // Sold 2,300 L PMS at ₦950 and 600 L AGO at ₦1,240: ₦2,929,000. Counted ₦1,500 short: within tolerance.
    const r = await close("blessing", {
      meters: dayMeters(),
      dips: [
        { tankId: ids.t1, quantity: 22_650 },
        { tankId: ids.t2, quantity: 14_400 },
      ],
      takings: { cash: 1_500_000, pos: 1_000_000, transfer: 427_500 },
    }).expect(201);
    expect(r.body).toMatchObject({
      status: "balanced",
      expected: 2_929_000,
      cashVariance: -1_500,
      approval: null,
    });
    expect(r.body.number).toMatch(/^SH-\d{4}-0001$/);
    expect(
      r.body.meters.map((m: { code: string; quantity: number }) => [
        m.code,
        m.quantity,
      ]),
    ).toEqual([
      ["P1", 1_500],
      ["P2", 800],
      ["P3", 600],
    ]);
    expect(
      r.body.tankCheck.find((c: { code: string }) => c.code === "OWR-T1"),
    ).toMatchObject({ book: 22_700, dip: 22_650, variance: -50, within: true });
    expect(await onHand(ids.t1)).toBe(22_650);
    expect(await onHand(ids.t2)).toBe(14_400);
    await close("blessing", {
      meters: dayMeters(),
      dips: [
        { tankId: ids.t1, quantity: 1 },
        { tankId: ids.t2, quantity: 1 },
      ],
      takings: { cash: 0, pos: 0, transfer: 0 },
    }).expect(409);
  });

  it("holds a shift that doesn't balance until Operations decides, and only then can it be banked", async () => {
    // Sold 1,000 L PMS and 400 L AGO: ₦1,446,000. Counted ₦1,300,000, and OWR-T1 is 450 L short.
    const r = await close("blessing", {
      period: "evening",
      meters: [
        { pumpId: ids.p1, closing: 102_500 },
        { pumpId: ids.p2, closing: 50_800 },
        { pumpId: ids.p3, closing: 81_000 },
      ],
      dips: [
        { tankId: ids.t1, quantity: 21_200 },
        { tankId: ids.t2, quantity: 14_000 },
      ],
      takings: { cash: 1_100_000, pos: 200_000, transfer: 0 },
      notes: "Pump attendant changed mid-shift.",
    }).expect(201);
    ids.shift2 = r.body.id;
    expect(r.body).toMatchObject({
      status: "variance_pending",
      expected: 1_446_000,
      cashVariance: -146_000,
    });
    expect(r.body.approval).toMatchObject({
      kind: "shift_variance",
      approverRole: "operations",
      amount: 573_500,
    });
    expect(r.body.approval.reason).toMatch(
      /takings short by ₦146,000.*OWR-T1 short by 450/,
    );
    expect(await onHand(ids.t1)).toBe(21_650);

    const bank = {
      bank: "Zenith Bank",
      bankRef: "ZEN-DEP-0091",
      amount: 1_100_000,
      bankedOn: today,
    };
    await u.finance.post(`/v1/shifts/${ids.shift2}/bank`, bank).expect(409);
    await u.blessing
      .post(`/v1/approvals/${r.body.approval.id}/decide`, {
        decision: "approved",
      })
      .expect(403);
    await u.ops
      .post(`/v1/approvals/${r.body.approval.id}/decide`, {
        decision: "approved",
        note: "Attendant to repay; retrain.",
      })
      .expect(200);
    expect(await onHand(ids.t1)).toBe(21_200);

    await u.blessing.post(`/v1/shifts/${ids.shift2}/bank`, bank).expect(403);
    const banked = await u.finance
      .post(`/v1/shifts/${ids.shift2}/bank`, bank)
      .expect(200);
    expect(banked.body).toMatchObject({
      status: "banked",
      bankedAmount: 1_100_000,
      cashShortAtBank: 0,
    });
    await u.finance.post(`/v1/shifts/${ids.shift2}/bank`, bank).expect(409);
  });

  it("refuses a meter that went backwards", async () => {
    const r = await close("blessing", {
      shiftDate: addDays(today, -1),
      meters: [
        { pumpId: ids.p1, closing: 102_000 },
        { pumpId: ids.p2, closing: 50_800 },
        { pumpId: ids.p3, closing: 81_000 },
      ],
      dips: [
        { tankId: ids.t1, quantity: 1 },
        { tankId: ids.t2, quantity: 1 },
      ],
      takings: { cash: 0, pos: 0, transfer: 0 },
    }).expect(422);
    expect(r.body.message).toMatch(
      /Pump P1's meter went backwards: 102500 at the last close, 102000 now/,
    );
  });
});

describe("LPG", () => {
  const fill = (serial: string, kg: number, who: Who = "obinna") =>
    u[who].post("/v1/fills", {
      siteId: ids.plant,
      tankId: ids.lpgTank,
      serial,
      kg,
    });

  it("never fills a cylinder that is unregistered, condemned, past its test or too small", async () => {
    const cyl = (serial: string, testDueOn: string) =>
      u.obinna
        .post("/v1/cylinders", {
          serial,
          sizeKg: 12.5,
          owner: "Cocean",
          testDueOn,
        })
        .expect(201);
    await cyl("cyl-0001", "2028-06-30");
    await cyl("CYL-0002", addDays(today, -1));
    const c3 = await cyl("CYL-0003", "2028-06-30");
    await u.obinna
      .post("/v1/cylinders", {
        serial: "CYL-0004",
        sizeKg: 13,
        owner: "Cocean",
        testDueOn: "2028-06-30",
      })
      .expect(400);

    expect((await fill("CYL-9999", 12.5).expect(422)).body.message).toMatch(
      /isn't registered/,
    );
    expect((await fill("CYL-0002", 12.5).expect(422)).body.message).toMatch(
      /pressure test was due on .* can't be filled until it is retested/,
    );
    await u.obinna
      .post(`/v1/cylinders/${c3.body.id}/condemn`, {
        reason: "Corroded foot ring, failed visual check.",
      })
      .expect(200);
    expect((await fill("CYL-0003", 12.5).expect(422)).body.message).toMatch(
      /condemned/,
    );
    expect((await fill("CYL-0001", 13).expect(422)).body.message).toMatch(
      /12.5 kg cylinder; 13 kg won't fit/,
    );
    await fill("CYL-0001", 12.5, "blessing").expect(403);

    const ok = await fill("CYL-0001", 12.5).expect(201);
    expect(ok.body).toMatchObject({
      kg: 12.5,
      price: 1050,
      amount: 13_125,
      serial: "CYL-0001",
    });
    expect(await onHand(ids.lpgTank)).toBe(9_987.5);
    const list = await u.ops.get("/v1/cylinders").expect(200);
    expect(
      list.body.find((c: { serial: string }) => c.serial === "CYL-0002")
        .canFill,
    ).toBe(false);
  });

  it("closes the plant's day from its fills and dips", async () => {
    const r = await u.obinna
      .post("/v1/shifts", {
        siteId: ids.plant,
        shiftDate: today,
        period: "day",
        meters: [],
        dips: [{ tankId: ids.lpgTank, quantity: 9_987.5 }],
        takings: { cash: 13_125, pos: 0, transfer: 0 },
      })
      .expect(201);
    expect(r.body).toMatchObject({
      status: "balanced",
      expected: 13_125,
      fills: { count: 1, kg: 12.5, amount: 13_125 },
    });
    expect(
      (await u.obinna.get(`/v1/fills?siteId=${ids.plant}`).expect(200)).body,
    ).toEqual([]);
  });

  it("shows each site's last shift to leadership", async () => {
    const r = await u.md.get("/v1/stations").expect(200);
    expect(
      r.body.find((s: { code: string }) => s.code === "OWR-01"),
    ).toMatchObject({ pumps: 3, lastShift: { status: "banked" } });
    await u.sales.get("/v1/stations").expect(403);
  });
});
