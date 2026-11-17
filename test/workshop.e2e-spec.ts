import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import {
  ADMIN,
  as,
  freshDatabase,
  login,
  readyTruck,
  startApp,
} from "./harness.js";

let app: INestApplication;
const people = {
  fleet: { email: "ngozi@erp.test", name: "Ngozi Eze", roles: ["fleet"] },
  ops: {
    email: "chinonso@erp.test",
    name: "Chinonso Okafor",
    roles: ["operations"],
  },
  exec: {
    email: "adaeze@erp.test",
    name: "Adaeze Nwosu",
    roles: ["executive"],
  },
  sales: { email: "tunde@erp.test", name: "Tunde Adeyemi", roles: ["sales"] },
};
type Who = keyof typeof people | "admin";
const PASSWORD = "a-good-long-password";
const u = {} as Record<Who, ReturnType<typeof as>>;
const ids = { a: "", b: "", wo1: "", wo2: "" };
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(
    new Date(),
  );

const brakes = [
  {
    kind: "part",
    description: "Brake pads, rear axle",
    quantity: 2,
    unitCost: 180_000,
  },
  { kind: "labour", description: "Fitting", quantity: 1, unitCost: 126_000 },
];

const decide = (
  who: ReturnType<typeof as>,
  id: string,
  decision: "approved" | "rejected",
  note?: string,
) => who.post(`/v1/approvals/${id}/decide`, { decision, note }).expect(200);

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
  ids.a = await readyTruck(u.fleet, u.exec, "RIV-430-BN");
  ids.b = await readyTruck(u.fleet, u.exec, "LAG-552-EP");
});
afterAll(() => app.close());

describe("a repair that takes a truck off the road", () => {
  it("holds the truck from the moment the work order is opened", async () => {
    await u.sales
      .post("/v1/work-orders", {
        vehicleId: ids.a,
        kind: "repair",
        title: "Brakes failed the pre-trip check",
      })
      .expect(403);
    const r = await u.fleet
      .post("/v1/work-orders", {
        vehicleId: ids.a,
        kind: "repair",
        title: "Brakes failed the pre-trip check",
        odometerKm: 118_200,
      })
      .expect(201);
    expect(r.body).toMatchObject({
      status: "draft",
      offRoad: true,
      plate: "RIV-430-BN",
      openedByName: "Ngozi Eze",
    });
    expect(r.body.number).toMatch(/^WO-\d{4}-0001$/);
    ids.wo1 = r.body.id;
    const v = await u.fleet.get(`/v1/vehicles/${ids.a}`).expect(200);
    expect(v.body.issues).toContain(
      `On hold: Work order ${r.body.number}: Brakes failed the pre-trip check`,
    );
    const clear = await u.fleet
      .post(`/v1/vehicles/${ids.a}/clear-hold`)
      .expect(409);
    expect(clear.body.message).toMatch(/held by work order WO-/);
  });

  it("routes the estimate by amount and lets it be priced again after a no", async () => {
    const s = await u.fleet
      .post(`/v1/work-orders/${ids.wo1}/submit`, { lines: brakes })
      .expect(200);
    expect(s.body).toMatchObject({ status: "submitted", estimate: 486_000 });
    const [req] = s.body.approvals;
    expect(req).toMatchObject({
      approverRole: "operations",
      amount: 486_000,
      status: "pending",
    });
    expect(req.reason).toMatch(/Parts ₦360,000, labour ₦126,000/);
    await u.fleet
      .post(`/v1/work-orders/${ids.wo1}/cancel`, { reason: "Changed plans" })
      .expect(409);
    await decide(u.ops, req.id, "rejected", "Get a second quote for the pads.");
    let w = await u.fleet.get(`/v1/work-orders/${ids.wo1}`).expect(200);
    expect(w.body.status).toBe("rejected");

    const again = await u.fleet
      .post(`/v1/work-orders/${ids.wo1}/submit`, {
        lines: brakes,
        supplierName: "Trans-Amadi Truck Clinic",
      })
      .expect(200);
    await decide(u.ops, again.body.approvals[0].id, "approved");
    w = await u.fleet.get(`/v1/work-orders/${ids.wo1}`).expect(200);
    expect(w.body).toMatchObject({
      status: "approved",
      supplierName: "Trans-Amadi Truck Clinic",
      allowed: 534_600,
    });
    // Approved isn't repaired: the truck stays held.
    const v = await u.fleet.get(`/v1/vehicles/${ids.a}`).expect(200);
    expect(v.body.holdReason).toMatch(/Work order/);
  });

  it("closes within the allowance and puts the truck back on the road", async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await u.fleet
      .post(`/v1/work-orders/${ids.wo1}/complete`, {
        lines: brakes,
        completedOn: tomorrow,
      })
      .expect(422);
    const done = await u.fleet
      .post(`/v1/work-orders/${ids.wo1}/complete`, {
        lines: [
          ...brakes,
          {
            kind: "part",
            description: "Brake fluid",
            quantity: 4,
            unitCost: 8_500,
          },
        ],
        completedOn: today(),
        odometerKm: 118_240,
      })
      .expect(200);
    expect(done.body).toMatchObject({
      status: "completed",
      actualCost: 520_000,
      partsCost: 394_000,
      labourCost: 126_000,
    });
    expect(done.body.releasedAt).toBeTruthy();
    const v = await u.fleet.get(`/v1/vehicles/${ids.a}`).expect(200);
    expect(v.body).toMatchObject({ holdReason: null, holdWorkOrderId: null });
    expect(v.body.issues).toEqual([]);
  });
});

describe("a job that costs more than approved", () => {
  it("needs a reason and a second approval before it closes", async () => {
    const o = await u.fleet
      .post("/v1/work-orders", {
        vehicleId: ids.a,
        kind: "tyres",
        title: "Two steer tyres worn past the limit",
      })
      .expect(201);
    ids.wo2 = o.body.id;
    const s = await u.fleet
      .post(`/v1/work-orders/${ids.wo2}/submit`, {
        lines: [
          {
            kind: "part",
            description: "Steer tyre",
            quantity: 2,
            unitCost: 100_000,
          },
        ],
      })
      .expect(200);
    await decide(u.ops, s.body.approvals[0].id, "approved");

    const dearer = [
      {
        kind: "part",
        description: "Steer tyre",
        quantity: 2,
        unitCost: 140_000,
      },
      {
        kind: "labour",
        description: "Fitting and balancing",
        quantity: 1,
        unitCost: 20_000,
      },
    ];
    const noNote = await u.fleet
      .post(`/v1/work-orders/${ids.wo2}/complete`, {
        lines: dearer,
        completedOn: today(),
      })
      .expect(422);
    expect(noNote.body.issues[0].path).toBe("note");

    const over = await u.fleet
      .post(`/v1/work-orders/${ids.wo2}/complete`, {
        lines: dearer,
        completedOn: today(),
        note: "Supplier's price went up this week.",
      })
      .expect(200);
    expect(over.body.status).toBe("overrun");
    expect(over.body.approvals[0]).toMatchObject({
      amount: 300_000,
      status: "pending",
      approverRole: "operations",
    });
    let v = await u.fleet.get(`/v1/vehicles/${ids.a}`).expect(200);
    expect(v.body.holdReason).toMatch(/Two steer tyres/);

    // Turned down: back to the workshop, cost to be recorded again.
    await decide(
      u.ops,
      over.body.approvals[0].id,
      "rejected",
      "Show the new invoice.",
    );
    let w = await u.fleet.get(`/v1/work-orders/${ids.wo2}`).expect(200);
    expect(w.body).toMatchObject({ status: "approved", actualCost: null });

    const retry = await u.fleet
      .post(`/v1/work-orders/${ids.wo2}/complete`, {
        lines: dearer,
        completedOn: today(),
        note: "Invoice INV-3302 attached; price rise confirmed.",
      })
      .expect(200);
    await decide(u.ops, retry.body.approvals[0].id, "approved");
    w = await u.fleet.get(`/v1/work-orders/${ids.wo2}`).expect(200);
    expect(w.body).toMatchObject({ status: "completed", actualCost: 300_000 });
    v = await u.fleet.get(`/v1/vehicles/${ids.a}`).expect(200);
    expect(v.body.holdReason).toBeNull();
  });
});

describe("jobs that don't hold the truck", () => {
  it("leaves a running truck alone, and goes back to draft when withdrawn", async () => {
    const o = await u.fleet
      .post("/v1/work-orders", {
        vehicleId: ids.b,
        kind: "repair",
        title: "Cab air conditioning not cooling",
        offRoad: false,
      })
      .expect(201);
    let v = await u.fleet.get(`/v1/vehicles/${ids.b}`).expect(200);
    expect(v.body.holdReason).toBeNull();
    const s = await u.fleet
      .post(`/v1/work-orders/${o.body.id}/submit`, {
        lines: [
          {
            kind: "outside",
            description: "Regas",
            quantity: 1,
            unitCost: 45_000,
          },
        ],
      })
      .expect(200);
    await u.fleet
      .post(`/v1/approvals/${s.body.approvals[0].id}/withdraw`)
      .expect(200);
    const w = await u.fleet.get(`/v1/work-orders/${o.body.id}`).expect(200);
    expect(w.body.status).toBe("draft");
    const c = await u.fleet
      .post(`/v1/work-orders/${o.body.id}/cancel`, {
        reason: "Driver says it's fine now",
      })
      .expect(200);
    expect(c.body).toMatchObject({
      status: "cancelled",
      cancelReason: "Driver says it's fine now",
    });
  });

  it("doesn't take over a hold someone else put on", async () => {
    await u.fleet
      .post(`/v1/vehicles/${ids.b}/hold`, {
        reason: "Accident under investigation",
      })
      .expect(200);
    const o = await u.fleet
      .post("/v1/work-orders", {
        vehicleId: ids.b,
        kind: "accident",
        title: "Front bumper and lamp damage",
      })
      .expect(201);
    expect(o.body.heldFrom).toBeNull();
    await u.fleet
      .post(`/v1/work-orders/${o.body.id}/cancel`, {
        reason: "Insurer will repair",
      })
      .expect(200);
    const v = await u.fleet.get(`/v1/vehicles/${ids.b}`).expect(200);
    expect(v.body.holdReason).toBe("Accident under investigation");
  });
});

describe("cost per truck and servicing", () => {
  it("adds up completed work by truck, with days off the road", async () => {
    await u.sales.get("/v1/workshop/costs").expect(403);
    const r = await u.exec.get("/v1/workshop/costs").expect(200);
    const a = r.body.rows.find(
      (x: { plate: string }) => x.plate === "RIV-430-BN",
    );
    expect(a).toMatchObject({
      orders: 2,
      parts: 674_000,
      labour: 146_000,
      outside: 0,
      total: 820_000,
      daysOffRoad: 2,
    });
    expect(r.body.rows[0].plate).toBe("RIV-430-BN");
    expect(r.body.totals).toMatchObject({ orders: 2, total: 820_000 });
    const none = await u.exec
      .get("/v1/workshop/costs?from=2020-01-01&to=2020-12-31")
      .expect(200);
    expect(none.body.totals.total).toBe(0);
  });

  it("shows which trucks are due a service, and clears one once serviced", async () => {
    let r = await u.ops.get("/v1/workshop/service").expect(200);
    expect(r.body.every((x: { due: boolean }) => x.due)).toBe(true);
    expect(r.body[0].reasons).toContain("No service on record");

    const o = await u.fleet
      .post("/v1/work-orders", {
        vehicleId: ids.b,
        kind: "service",
        title: "10,000 km service",
        offRoad: false,
        odometerKm: 64_000,
      })
      .expect(201);
    r = await u.ops.get("/v1/workshop/service").expect(200);
    expect(
      r.body.find((x: { plate: string }) => x.plate === "LAG-552-EP").booked,
    ).toBe(true);
    const s = await u.fleet
      .post(`/v1/work-orders/${o.body.id}/submit`, {
        lines: [
          {
            kind: "part",
            description: "Oil and filters",
            quantity: 1,
            unitCost: 95_000,
          },
          {
            kind: "labour",
            description: "Service",
            quantity: 1,
            unitCost: 30_000,
          },
        ],
      })
      .expect(200);
    await decide(u.ops, s.body.approvals[0].id, "approved");
    await u.fleet
      .post(`/v1/work-orders/${o.body.id}/complete`, {
        lines: s.body.estimateLines,
        completedOn: today(),
        odometerKm: 64_020,
      })
      .expect(200);
    r = await u.ops.get("/v1/workshop/service").expect(200);
    const b = r.body.find((x: { plate: string }) => x.plate === "LAG-552-EP");
    expect(b).toMatchObject({
      due: false,
      booked: false,
      lastServiceOn: today(),
      lastServiceKm: 64_020,
    });
    expect(b.dueOn > today()).toBe(true);
  });

  it("lists open and closed work, and keeps every step in the audit trail", async () => {
    const open = await u.exec.get("/v1/work-orders?state=open").expect(200);
    expect(open.body).toHaveLength(0);
    const closed = await u.exec
      .get(`/v1/work-orders?state=closed&vehicleId=${ids.a}`)
      .expect(200);
    expect(closed.body).toHaveLength(2);
    const a = await u.admin
      .get(`/v1/audit?entityType=work_order&entityId=${ids.wo2}`)
      .expect(200);
    expect(a.body.map((e: { action: string }) => e.action).reverse()).toEqual([
      "work_order.opened",
      "work_order.submitted",
      "work_order.approved",
      "work_order.overrun",
      "work_order.overrun_rejected",
      "work_order.overrun",
      "work_order.completed",
    ]);
  });
});
