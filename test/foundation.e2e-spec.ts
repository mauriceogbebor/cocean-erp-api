import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Client } from "pg";
import request from "supertest";
import {
  ADMIN,
  as,
  freshDatabase,
  login,
  startApp,
  TEST_DB,
} from "./harness.js";

let app: INestApplication;
let admin: ReturnType<typeof as>;
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
};
const PASSWORD = "a-good-long-password";
const tokens: Record<keyof typeof people, string> = {
  sales: "",
  finance: "",
  md: "",
};

beforeAll(async () => {
  await freshDatabase();
  app = await startApp();
  admin = as(app, (await login(app, ADMIN.email, ADMIN.password)).accessToken);
  for (const [k, p] of Object.entries(people)) {
    await admin.post("/v1/users", { ...p, password: PASSWORD }).expect(201);
    tokens[k as keyof typeof people] = (
      await login(app, p.email, PASSWORD)
    ).accessToken;
  }
});
afterAll(() => app?.close());

describe("health and sign-in", () => {
  it("reports the database as reachable without signing in", async () => {
    const r = await request(app.getHttpServer()).get("/health").expect(200);
    expect(r.body).toEqual({ status: "ok", database: "ok" });
  });

  it("refuses every other endpoint without a token", async () => {
    await request(app.getHttpServer()).get("/v1/sites").expect(401);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const a = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: people.sales.email, password: "wrong-password" })
      .expect(401);
    const b = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: "nobody@cocean.test", password: "wrong-password" })
      .expect(401);
    expect(a.body.message).toBe(b.body.message);
  });

  it("locks an account after five failed attempts", async () => {
    await admin
      .post("/v1/users", {
        email: "locked@cocean.test",
        name: "Lock Test",
        password: PASSWORD,
        roles: ["depot"],
      })
      .expect(201);
    for (let i = 0; i < 5; i++)
      await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: "locked@cocean.test", password: "nope-nope" })
        .expect(401);
    const r = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: "locked@cocean.test", password: PASSWORD })
      .expect(401);
    expect(r.body.message).toMatch(/Too many failed attempts/);
  });

  it("returns who is signed in with their permissions", async () => {
    const r = await as(app, tokens.md).get("/v1/auth/me").expect(200);
    expect(r.body).toMatchObject({ name: "Kelechi Amadi", roles: ["md"] });
    expect(r.body.permissions).toContain("approvals.decide");
    expect(r.body.permissions).not.toContain("users.manage");
  });

  it("rotates refresh tokens and treats reuse as theft", async () => {
    const first = await login(app, people.finance.email, PASSWORD);
    const second = await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    // The old token was used once already: reusing it revokes every session.
    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: first.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: second.body.refreshToken })
      .expect(401);
  });
});

describe("permissions and audit", () => {
  it("only lets an administrator create sites", async () => {
    const site = {
      code: "ONN-DEP",
      name: "Onne depot",
      kind: "depot",
      state: "Rivers",
    };
    await as(app, tokens.sales).post("/v1/sites", site).expect(403);
    const r = await admin.post("/v1/sites", site).expect(201);
    expect(r.body).toMatchObject({ code: "ONN-DEP", active: true });
    await admin.post("/v1/sites", site).expect(409);
    // Everyone with sites.read can see it.
    const list = await as(app, tokens.sales).get("/v1/sites").expect(200);
    expect(list.body.map((s: { code: string }) => s.code)).toContain("ONN-DEP");
  });

  it("validates input with the shared schemas", async () => {
    const r = await admin
      .post("/v1/sites", { code: "bad", name: "x", kind: "moon", state: "" })
      .expect(400);
    expect(r.body.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(["code", "name", "kind", "state"]),
    );
  });

  it("records every change, and the audit trail can't be edited", async () => {
    const r = await admin.get("/v1/audit?entityType=site").expect(200);
    expect(r.body[0]).toMatchObject({
      action: "site.created",
      entityType: "site",
    });
    expect(r.body[0].after.code).toBe("ONN-DEP");
    await as(app, tokens.sales).get("/v1/audit").expect(403);
    const c = new Client({ connectionString: TEST_DB });
    await c.connect();
    await expect(
      c.query("UPDATE audit_events SET action = 'x'"),
    ).rejects.toThrow(/append-only/);
    await expect(c.query("DELETE FROM audit_events")).rejects.toThrow(
      /append-only/,
    );
    await c.end();
  });

  it("stops an administrator removing their own admin role", async () => {
    const me = await admin.get("/v1/auth/me").expect(200);
    await admin
      .patch(`/v1/users/${me.body.id}/roles`, { roles: ["sales"] })
      .expect(400);
  });

  it("signs a disabled user out everywhere at once", async () => {
    const created = await admin
      .post("/v1/users", {
        email: "leaver@cocean.test",
        name: "Peter Nwachukwu",
        password: PASSWORD,
        roles: ["depot"],
      })
      .expect(201);
    const t = await login(app, "leaver@cocean.test", PASSWORD);
    await admin
      .patch(`/v1/users/${created.body.id}/status`, { status: "disabled" })
      .expect(200);
    await as(app, t.accessToken).get("/v1/sites").expect(401);
    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: t.refreshToken })
      .expect(401);
  });
});

describe("approvals", () => {
  const credit = {
    kind: "payroll",
    ref: "PAY-2026-10",
    title: "October payroll, 214 staff",
    amount: 37_200_000,
    reason: "Variance to September explained: two starters, one leaver.",
  };
  let id = "";

  it("refuses kinds that must come from their own record", async () => {
    const r = await as(app, tokens.sales)
      .post("/v1/approvals", {
        ...credit,
        kind: "credit_override",
        ref: "SO-2026-999",
      })
      .expect(422);
    expect(r.body.message).toMatch(/raised from the record/);
  });

  it("routes payroll to the MD", async () => {
    const r = await as(app, tokens.sales)
      .post("/v1/approvals", credit)
      .expect(201);
    expect(r.body).toMatchObject({
      approverRole: "md",
      status: "pending",
      amount: 37_200_000,
    });
    id = r.body.id;
    await as(app, tokens.sales).post("/v1/approvals", credit).expect(409);
  });

  it("routes by amount: a small PO to Finance, a large one to the MD", async () => {
    const po = {
      kind: "purchase_order",
      title: "Tyres for LAG-552-EP",
      reason: "Truck blocked from dispatch.",
    };
    const small = await as(app, tokens.sales)
      .post("/v1/approvals", { ...po, ref: "PO-2026-033", amount: 4_860_000 })
      .expect(201);
    expect(small.body.approverRole).toBe("finance");
    const big = await as(app, tokens.sales)
      .post("/v1/approvals", { ...po, ref: "PO-2026-034", amount: 46_800_000 })
      .expect(201);
    expect(big.body.approverRole).toBe("md");
  });

  it("never lets the maker decide, nor anyone outside the authority", async () => {
    // Sales can't decide at all; Finance holds approvals.decide but not this band.
    await as(app, tokens.sales)
      .post(`/v1/approvals/${id}/decide`, { decision: "approved" })
      .expect(403);
    const f = await as(app, tokens.finance)
      .post(`/v1/approvals/${id}/decide`, { decision: "approved" })
      .expect(403);
    expect(f.body.message).toMatch(/outside your approval authority/);
  });

  it("shows the MD what is waiting for them", async () => {
    const r = await as(app, tokens.md)
      .get("/v1/approvals?scope=mine&status=pending")
      .expect(200);
    expect(r.body.map((a: { ref: string }) => a.ref)).toEqual(
      expect.arrayContaining(["PAY-2026-10", "PO-2026-034"]),
    );
    expect(r.body.map((a: { ref: string }) => a.ref)).not.toContain(
      "PO-2026-033",
    );
  });

  it("needs a reason to reject, then records one decision only", async () => {
    await as(app, tokens.md)
      .post(`/v1/approvals/${id}/decide`, { decision: "rejected" })
      .expect(400);
    const r = await as(app, tokens.md)
      .post(`/v1/approvals/${id}/decide`, {
        decision: "approved",
        note: "One-off. Review the limit.",
      })
      .expect(200);
    expect(r.body).toMatchObject({
      status: "approved",
      decisionNote: "One-off. Review the limit.",
    });
    await as(app, tokens.md)
      .post(`/v1/approvals/${id}/decide`, {
        decision: "rejected",
        note: "changed my mind",
      })
      .expect(409);
    const audit = await admin
      .get(`/v1/audit?entityType=approval&entityId=${id}`)
      .expect(200);
    expect(audit.body.map((e: { action: string }) => e.action)).toEqual([
      "approval.approved",
      "approval.requested",
    ]);
  });

  it("decides concurrently only once", async () => {
    const r = await as(app, tokens.sales)
      .post("/v1/approvals", { ...credit, ref: "PAY-2026-11" })
      .expect(201);
    const both = await Promise.all([
      as(app, tokens.md).post(`/v1/approvals/${r.body.id}/decide`, {
        decision: "approved",
      }),
      as(app, tokens.md).post(`/v1/approvals/${r.body.id}/decide`, {
        decision: "approved",
      }),
    ]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
  });

  it("lets only the maker withdraw a pending request", async () => {
    const r = await as(app, tokens.sales)
      .post("/v1/approvals", { ...credit, ref: "PAY-2026-12" })
      .expect(201);
    await as(app, tokens.md)
      .post(`/v1/approvals/${r.body.id}/withdraw`)
      .expect(403);
    const w = await as(app, tokens.sales)
      .post(`/v1/approvals/${r.body.id}/withdraw`)
      .expect(200);
    expect(w.body.status).toBe("withdrawn");
  });
});
