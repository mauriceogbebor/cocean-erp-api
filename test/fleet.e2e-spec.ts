import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Client } from "pg";
import request from "supertest";
import { addDays, lagosDate } from "../src/common/dates.js";
import {
  ADMIN,
  as,
  freshDatabase,
  login,
  readyDriver,
  readyTruck,
  startApp,
  TEST_DB,
  TRACKER_KEY,
} from "./harness.js";

let app: INestApplication;
const people = {
  fleet: { email: "emeka@cocean.test", name: "Emeka Obi", roles: ["fleet"] },
  exec: {
    email: "adaeze@cocean.test",
    name: "Adaeze Nwosu",
    roles: ["executive"],
  },
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
  security: {
    email: "musa@cocean.test",
    name: "Musa Abdullahi",
    roles: ["security"],
  },
};
type Who = keyof typeof people | "admin";
const PASSWORD = "a-good-long-password";
const u = {} as Record<Who, ReturnType<typeof as>>;
const today = lagosDate();
const ids = {
  depot: "",
  tank: "",
  customer: "",
  site: "",
  truck: "",
  driver: "",
  spare: "",
};
const doc = (kind: string, expiresOn = "2030-12-31") => ({
  kind,
  number: `${kind.toUpperCase()}-1`,
  issuer: "Rivers State",
  expiresOn,
});
const PAPERS = [
  "registration",
  "roadworthiness",
  "insurance",
  "nmdpra_permit",
  "calibration",
];

async function releasedOrder(litres: number) {
  const o = await u.sales
    .post("/v1/orders", {
      customerId: ids.customer,
      poRef: `RC-${litres}`,
      lines: [
        { productCode: "AGO", quantity: litres, deliverySiteId: ids.site },
      ],
    })
    .expect(201);
  expect(o.body.status).toBe("released");
  return o.body as { id: string; lines: { id: string }[] };
}
const plan = (
  order: { id: string; lines: { id: string }[] },
  quantity: number,
  vehicleId = ids.truck,
  driverId = ids.driver,
) =>
  u.ops.post("/v1/liftings", {
    orderId: order.id,
    siteId: ids.depot,
    vehicleId,
    driverId,
    drops: [{ orderLineId: order.lines[0].id, quantity }],
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
  ids.tank = (
    await u.admin
      .post("/v1/tanks", {
        siteId: ids.depot,
        code: "ONN-T01",
        productCode: "AGO",
        capacity: 1_000_000,
        safeCapacity: 950_000,
        openingStock: 500_000,
      })
      .expect(201)
  ).body.id;
  const c = await u.sales
    .post("/v1/customers", {
      code: "CUS-107",
      name: "Riverside Construction Ltd",
      kind: "industrial",
      address: "12 Aba Road, Port Harcourt",
      requestedTerms: {
        terms: "credit",
        creditLimit: 100_000_000,
        creditDays: 30,
        reason: "Long-standing customer, pays on time.",
      },
    })
    .expect(201);
  ids.customer = c.body.id;
  await u.md
    .post(`/v1/approvals/${c.body.pendingTermsRequest.id}/decide`, {
      decision: "approved",
    })
    .expect(200);
  ids.site = (
    await u.sales
      .post(`/v1/customers/${ids.customer}/sites`, {
        name: "Bridge site",
        address: "Km 14 East-West Road",
        state: "Rivers",
        receiverName: "Grace Nwankwo",
        receiverPhone: "08031234567",
      })
      .expect(201)
  ).body.id;
  const pl = await u.sales
    .post("/v1/price-lists", {
      code: "PL-2026-10",
      validFrom: today,
      lines: [{ productCode: "AGO", price: 1240 }],
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

describe("vehicles into service", () => {
  it("registers a tanker; compartments must add up and plates are unique", async () => {
    const truck = {
      plate: "riv 430 bn".replace(/ /g, ""),
      kind: "tanker",
      capacity: 33_000,
      ownership: "owned",
      trackerId: "ARC-88123",
    };
    await u.ops.post("/v1/vehicles", truck).expect(403);
    await u.fleet
      .post("/v1/vehicles", { ...truck, compartments: [11_000, 11_000] })
      .expect(400);
    await u.fleet
      .post("/v1/vehicles", { ...truck, ownership: "transporter" })
      .expect(400);
    const v = await u.fleet
      .post("/v1/vehicles", {
        ...truck,
        compartments: [11_000, 11_000, 11_000],
      })
      .expect(201);
    ids.truck = v.body.id;
    expect(v.body).toMatchObject({ plate: "RIV-430-BN", status: "onboarding" });
    expect(v.body.issues).toEqual(
      expect.arrayContaining([
        "Not yet approved into service",
        "No insurance on record",
      ]),
    );
    await u.fleet
      .post("/v1/vehicles", {
        ...truck,
        plate: "RIV-430-BN",
        trackerId: undefined,
      })
      .expect(409);
  });

  it("won't go to the Head of Operations until every paper is there and in date", async () => {
    const r = await u.fleet
      .post(`/v1/vehicles/${ids.truck}/submit`)
      .expect(422);
    expect(r.body.message).toMatch(/No vehicle registration on record/);
    for (const kind of PAPERS)
      await u.fleet
        .post(
          `/v1/vehicles/${ids.truck}/documents`,
          kind === "insurance" ? doc(kind, addDays(today, -1)) : doc(kind),
        )
        .expect(201);
    const expired = await u.fleet
      .post(`/v1/vehicles/${ids.truck}/submit`)
      .expect(422);
    expect(expired.body.message).toMatch(/Insurance expired on/);
    // A renewal is a new paper; the latest counts.
    await u.fleet
      .post(
        `/v1/vehicles/${ids.truck}/documents`,
        doc("insurance", addDays(today, 20)),
      )
      .expect(201);
    const list = await u.ops.get("/v1/vehicles").expect(200);
    expect(list.body[0].expiringSoon).toEqual(["insurance"]);

    const s = await u.fleet
      .post(`/v1/vehicles/${ids.truck}/submit`)
      .expect(200);
    expect(s.body).toMatchObject({ status: "pending_approval" });
    expect(s.body.approval).toMatchObject({
      kind: "truck_onboarding",
      approverRole: "executive",
    });
    await u.fleet
      .post(`/v1/approvals/${s.body.approval.id}/decide`, {
        decision: "approved",
      })
      .expect(403);
    await u.exec
      .post(`/v1/approvals/${s.body.approval.id}/decide`, {
        decision: "approved",
      })
      .expect(200);
    const v = await u.fleet.get(`/v1/vehicles/${ids.truck}`).expect(200);
    expect(v.body).toMatchObject({ status: "active", issues: [] });
  });
});

describe("dispatch checks", () => {
  it("refuses a driver without an HSE induction until one is recorded", async () => {
    const d = await u.fleet
      .post("/v1/drivers", {
        name: "Sunday Okon",
        phone: "08051234567",
        licenceNumber: "riv-dl-0001",
        licenceExpiresOn: "2030-06-30",
      })
      .expect(201);
    ids.driver = d.body.id;
    expect(d.body.issues).toEqual(["No HSE induction on record"]);
    await u.fleet
      .post("/v1/drivers", {
        name: "Someone Else",
        phone: "08059999999",
        licenceNumber: "RIV-DL-0001",
        licenceExpiresOn: "2030-06-30",
      })
      .expect(409);
    const o = await releasedOrder(30_000);
    const r = await plan(o, 30_000).expect(422);
    expect(r.body.message).toMatch(/Sunday Okon: No HSE induction on record/);
    const ok = await u.fleet
      .patch(`/v1/drivers/${ids.driver}`, { inductedOn: today })
      .expect(200);
    expect(ok.body.issues).toEqual([]);
    const fits = await plan(o, 30_000).expect(201);
    expect(fits.body).toMatchObject({
      truckPlate: "RIV-430-BN",
      driverName: "Sunday Okon",
      driverPhone: "08051234567",
    });
    // One truck, one loading at a time.
    const o2 = await releasedOrder(1_000);
    const busy = await plan(o2, 1_000).expect(409);
    expect(busy.body.message).toMatch(/RIV-430-BN is already on LI-/);
    await u.ops
      .post(`/v1/liftings/${fits.body.id}/cancel`, {
        reason: "Re-planning with a spare truck.",
      })
      .expect(200);
  });

  it("refuses a truck on hold or a load bigger than its tank", async () => {
    const o = await releasedOrder(5_000);
    await u.fleet
      .post(`/v1/vehicles/${ids.truck}/hold`, {
        reason: "Brake fault reported at Eleme.",
      })
      .expect(200);
    const held = await plan(o, 5_000).expect(422);
    expect(held.body.message).toMatch(
      /RIV-430-BN: On hold: Brake fault reported at Eleme/,
    );
    await u.fleet.post(`/v1/vehicles/${ids.truck}/clear-hold`).expect(200);
    ids.spare = await readyTruck(u.fleet, u.exec, "ABA-207-AA", {
      capacity: 4_000,
    });
    const big = await plan(o, 5_000, ids.spare).expect(422);
    expect(big.body.message).toMatch(/ABA-207-AA holds 4,000; 5,000 won't fit/);
  });

  it("checks again at loading, in case papers lapsed after planning", async () => {
    const o = await releasedOrder(10_000);
    const l = await plan(o, 10_000).expect(201);
    await u.fleet
      .post(
        `/v1/vehicles/${ids.truck}/documents`,
        doc("roadworthiness", addDays(today, -3)),
      )
      .expect(201);
    const body = {
      drops: [
        {
          dropId: l.body.drops[0].id,
          tankId: ids.tank,
          loadedQuantity: 10_000,
          seals: ["S-3001"],
        },
      ],
    };
    const r = await u.depot
      .post(`/v1/liftings/${l.body.id}/load`, body)
      .expect(422);
    expect(r.body.message).toMatch(/Roadworthiness certificate expired/);
    await u.fleet
      .post(`/v1/vehicles/${ids.truck}/documents`, doc("roadworthiness"))
      .expect(201);
    await u.depot.post(`/v1/liftings/${l.body.id}/load`, body).expect(200);
  });
});

describe("tracking", () => {
  it("takes positions only with the tracker key, and shows each truck's last report", async () => {
    const ping = (trackerId: string, minutesAgo: number) => ({
      trackerId,
      lat: 4.7731,
      lng: 7.0085,
      speedKph: 48,
      recordedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    });
    const send = (key?: string) => {
      const r = request(app.getHttpServer()).post("/v1/tracking/pings");
      return (key ? r.set("x-tracker-key", key) : r).send({
        pings: [
          ping("ARC-88123", 3),
          ping("ARC-88123", 1),
          ping("UNKNOWN-1", 1),
        ],
      });
    };
    await send().expect(401);
    await send("wrong-key").expect(401);
    const r = await send(TRACKER_KEY).expect(200);
    expect(r.body).toEqual({ accepted: 2, ignored: 1 });
    const board = await u.ops.get("/v1/tracking").expect(200);
    expect(board.body).toHaveLength(1);
    expect(board.body[0]).toMatchObject({
      plate: "RIV-430-BN",
      stale: false,
      minutesSinceReport: 1,
      position: { lat: 4.7731, lng: 7.0085, speedKph: 48 },
      lifting: {
        number: expect.stringMatching(/^LI-/),
        driverName: "Sunday Okon",
      },
    });
  });
});

describe("Security and drivers", () => {
  it("suspends the driver while closing a delivery case, and stops their next dispatch", async () => {
    const o = await releasedOrder(2_000);
    const driver = await readyDriver(
      u.fleet,
      "Kunle Bakare",
      "08061234567",
      "ABA-DL-0002",
    );
    const l = await plan(o, 2_000, ids.spare, driver).expect(201);
    const loaded = await u.depot
      .post(`/v1/liftings/${l.body.id}/load`, {
        drops: [
          {
            dropId: l.body.drops[0].id,
            tankId: ids.tank,
            loadedQuantity: 2_000,
            seals: ["S-4001"],
          },
        ],
      })
      .expect(200);
    await request(app.getHttpServer())
      .post("/v1/deliveries/confirm")
      .send({
        token: loaded.body.deliveryLinks[0].token,
        receiverName: "Grace Nwankwo",
        receivedQuantity: 1_500,
        seals: ["S-9999"],
      })
      .expect(200);
    await u.security
      .post(`/v1/deliveries/${l.body.drops[0].id}/resolve`, {
        finding: "Seal cut and 500 L missing; driver admitted a stop.",
        suspendDriver: true,
      })
      .expect(200);
    const list = await u.fleet.get("/v1/drivers").expect(200);
    const kunle = list.body.find(
      (d: { name: string }) => d.name === "Kunle Bakare",
    );
    expect(kunle).toMatchObject({ status: "suspended" });
    expect(kunle.issues[0]).toMatch(/^Suspended: Delivery exception on LI-/);

    const next = await releasedOrder(1_000);
    const refused = await plan(next, 1_000, ids.spare, driver).expect(422);
    expect(refused.body.message).toMatch(/Kunle Bakare: Suspended/);
    await u.fleet
      .post(`/v1/drivers/${driver}/reinstate`, {
        reason: "Retrained; transporter guarantees him.",
      })
      .expect(200);
    await plan(next, 1_000, ids.spare, driver).expect(201);
  });

  it("keeps the audit trail of who put a truck into service", async () => {
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    const r = await c.query(
      "select action from audit_events where entity_type = 'vehicle' and entity_id = $1 order by id",
      [ids.truck],
    );
    await c.end();
    expect(r.rows.map((x) => x.action)).toEqual(
      expect.arrayContaining([
        "vehicle.registered",
        "vehicle.submitted",
        "vehicle.into_service",
        "vehicle.held",
        "vehicle.hold_cleared",
      ]),
    );
  });
});
