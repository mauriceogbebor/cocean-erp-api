import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { ADMIN, as, freshDatabase, login, startApp } from "./harness.js";

let app: INestApplication;
let admin: ReturnType<typeof as>;
let adminId = "";
let tundeId = "";
const PASSWORD = "a-good-long-password";

beforeAll(async () => {
  await freshDatabase();
  app = await startApp();
  admin = as(app, (await login(app, ADMIN.email, ADMIN.password)).accessToken);
  adminId = (await admin.get("/v1/auth/me").expect(200)).body.id;
  for (const p of [
    { email: "tunde@erp.test", name: "Tunde Adeyemi", roles: ["sales"] },
    {
      email: "chinonso@erp.test",
      name: "Chinonso Okafor",
      roles: ["operations"],
    },
    { email: "adaeze@erp.test", name: "Adaeze Nwosu", roles: ["executive"] },
  ]) {
    const r = await admin
      .post("/v1/users", { ...p, password: PASSWORD })
      .expect(201);
    if (p.name === "Tunde Adeyemi") tundeId = r.body.id;
  }
});
afterAll(() => app.close());

describe("passwords", () => {
  it("lets an administrator set a temporary password, ending the person's sessions", async () => {
    const old = await login(app, "tunde@erp.test", PASSWORD);
    await admin
      .post(`/v1/users/${adminId}/password`, {
        password: "another-long-password",
      })
      .expect(400);
    await as(app, old.accessToken)
      .post(`/v1/users/${tundeId}/password`, {
        password: "temporary-pass-0001",
      })
      .expect(403);
    await admin
      .post(`/v1/users/${tundeId}/password`, { password: "aaaaaaaaaaaaaa" })
      .expect(400);
    await admin
      .post(`/v1/users/${tundeId}/password`, {
        password: "temporary-pass-0001",
      })
      .expect(200);
    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: old.refreshToken })
      .expect(401);
    await login(app, "tunde@erp.test", "temporary-pass-0001");
  });

  it("lets anyone change their own password, given the current one", async () => {
    const t = await login(app, "tunde@erp.test", "temporary-pass-0001");
    const me = as(app, t.accessToken);
    const wrong = await me
      .post("/v1/auth/password", {
        current: "not-it",
        password: "tunde-chose-this-one",
      })
      .expect(401);
    expect(wrong.body.issues[0].path).toBe("current");
    await me
      .post("/v1/auth/password", {
        current: "temporary-pass-0001",
        password: "tunde-chose-this-one",
      })
      .expect(204);
    await request(app.getHttpServer())
      .post("/v1/auth/refresh")
      .send({ refreshToken: t.refreshToken })
      .expect(401);
    await login(app, "tunde@erp.test", "tunde-chose-this-one");
  });
});

describe("approval limits", () => {
  const wo = (ref: string, amount: number) => ({
    kind: "other",
    ref,
    title: "Brake pads for RIV-430-BN",
    amount,
    reason: "Failed the pre-trip check this morning.",
  });

  it("only lets an administrator change who decides, with bands that join up", async () => {
    const sales = as(
      app,
      (await login(app, "tunde@erp.test", "tunde-chose-this-one")).accessToken,
    );
    const bands = {
      bands: [
        { min: 0, max: 250_000, approver: "operations" },
        { min: 250_000, max: null, approver: "executive" },
      ],
    };
    await sales.put("/v1/approvals/policies/other", bands).expect(403);
    const gap = await admin
      .put("/v1/approvals/policies/other", {
        bands: [
          { min: 0, max: 250_000, approver: "operations" },
          { min: 300_000, max: null, approver: "executive" },
        ],
      })
      .expect(400);
    expect(gap.body.issues[0].path).toBe("bands.1.min");
    const noDecide = await admin
      .put("/v1/approvals/policies/other", {
        bands: [{ min: 0, max: null, approver: "sales" }],
      })
      .expect(400);
    expect(noDecide.body.issues[0].path).toBe("bands.0.approver");
    await admin.put("/v1/approvals/policies/nonsense", bands).expect(400);

    // A request already waiting keeps its approver.
    const before = await sales
      .post("/v1/approvals", wo("WO-2026-101", 486_000))
      .expect(201);
    expect(before.body.approverRole).toBe("operations");
    const r = await admin
      .put("/v1/approvals/policies/other", bands)
      .expect(200);
    expect(
      r.body.filter((p: { kind: string }) => p.kind === "other"),
    ).toHaveLength(2);
    const after = await sales
      .post("/v1/approvals", wo("WO-2026-102", 486_000))
      .expect(201);
    expect(after.body.approverRole).toBe("executive");
    const waiting = await admin
      .get("/v1/approvals?scope=all&status=pending")
      .expect(200);
    expect(
      waiting.body.find((a: { ref: string }) => a.ref === "WO-2026-101")
        .approverRole,
    ).toBe("operations");
  });

  it("keeps the change in the audit trail, with who made it", async () => {
    const a = await admin
      .get("/v1/audit?entityType=approval_policy")
      .expect(200);
    expect(a.body[0]).toMatchObject({
      action: "approval_policy.changed",
      entityId: "other",
      actorName: "System administrator",
    });
    expect(a.body[0].before[0]).toMatchObject({
      min: 0,
      max: 1_000_000,
      approver: "operations",
    });
  });
});
