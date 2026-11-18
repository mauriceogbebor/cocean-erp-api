import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import {
  DEFAULT_ORGANIZATION,
  organizationSettingsSchema,
} from "@qorrix-erp/contracts";
import { withDefaults } from "../src/organization/organization.service.js";
import { ADMIN, as, freshDatabase, login, startApp } from "./harness.js";

let app: INestApplication;
let admin: ReturnType<typeof as>;
let sales: ReturnType<typeof as>;
const PASSWORD = "a-good-long-password";

beforeAll(async () => {
  await freshDatabase();
  app = await startApp();
  admin = as(app, (await login(app, ADMIN.email, ADMIN.password)).accessToken);
  await admin
    .post("/v1/users", {
      email: "tunde@erp.test",
      name: "Tunde Adeyemi",
      roles: ["sales"],
      password: PASSWORD,
    })
    .expect(201);
  sales = as(app, (await login(app, "tunde@erp.test", PASSWORD)).accessToken);
});
afterAll(async () => {
  // Leave the defaults for the next file.
  await admin.put("/v1/organization", DEFAULT_ORGANIZATION);
  await app.close();
});

describe("organization settings", () => {
  it("starts a new installation on the defaults, and shows its name before sign-in", async () => {
    const pub = await request(app.getHttpServer())
      .get("/v1/organization/public")
      .expect(200);
    expect(pub.body).toEqual({
      name: "Your organization",
      logo: null,
      currency: { code: "NGN", symbol: "₦" },
      locale: "en-NG",
      timeZone: "Africa/Lagos",
    });
    expect(pub.body).not.toHaveProperty("stock");
    const all = await sales.get("/v1/organization").expect(200);
    expect(
      all.body.vehicleDocuments.map((d: { key: string }) => d.key),
    ).toContain("nmdpra_permit");
  });

  it("only someone with settings.manage changes them, and the change is audited", async () => {
    const next = {
      ...DEFAULT_ORGANIZATION,
      name: "Contoso Energy Ltd",
      currency: { code: "GHS", symbol: "GH₵" },
      locale: "en-GH",
      timeZone: "Africa/Accra",
      regions: ["Greater Accra", "Ashanti"],
      formats: {
        ...DEFAULT_ORGANIZATION.formats,
        phone: { pattern: "^0[235]\\d{8}$", example: "0241234567" },
      },
    };
    await sales.put("/v1/organization", next).expect(403);
    const r = await admin.put("/v1/organization", next).expect(200);
    expect(r.body.name).toBe("Contoso Energy Ltd");
    const audit = await admin
      .get("/v1/audit?entityType=organization")
      .expect(200);
    expect(JSON.stringify(audit.body)).toContain("organization.updated");
  });

  it("refuses a format whose example doesn't match, or a key used twice", async () => {
    const bad = await admin
      .put("/v1/organization", {
        ...DEFAULT_ORGANIZATION,
        formats: {
          ...DEFAULT_ORGANIZATION.formats,
          plate: { pattern: "^[A-Z]{2}-\\d{4}$", example: "RIV-430-BN" },
        },
      })
      .expect(400);
    expect(bad.body.issues[0].path).toBe("formats.plate.pattern");
    await admin
      .put("/v1/organization", {
        ...DEFAULT_ORGANIZATION,
        vehicleDocuments: [
          ...DEFAULT_ORGANIZATION.vehicleDocuments,
          { key: "insurance", label: "Insurance again", requiredFor: [] },
        ],
      })
      .expect(400);
  });

  it("checks phone numbers and regions against the organization's settings", async () => {
    const customer = (phone: string) =>
      sales.post("/v1/customers", {
        code: "CUS-900",
        name: "Accra Haulage",
        kind: "industrial",
        address: "12 Spintex Road, Accra",
        phone,
      });
    // Still Contoso Energy's settings from the test above.
    const ng = await customer("08031234567").expect(400);
    expect(ng.body.issues[0]).toMatchObject({ path: "phone" });
    expect(ng.body.issues[0].message).toContain("0241234567");
    await customer("0241234567").expect(201);
    const site = await admin
      .post("/v1/sites", {
        code: "ACC-DEP",
        name: "Tema depot",
        kind: "depot",
        state: "Lagos",
      })
      .expect(400);
    expect(site.body.issues[0].path).toBe("state");
    await admin
      .post("/v1/sites", {
        code: "ACC-DEP",
        name: "Tema depot",
        kind: "depot",
        state: "Greater Accra",
      })
      .expect(201);
  });
});

describe("settings saved by an older release", () => {
  it("fills in keys a newer release added inside a group", () => {
    const saved = {
      ...DEFAULT_ORGANIZATION,
      name: "Older install",
      fleet: { inductionValidDays: 180, trackerStaleMinutes: 20 },
    };
    const s = organizationSettingsSchema.parse(withDefaults(saved));
    expect(s.name).toBe("Older install");
    expect(s.fleet).toMatchObject({
      inductionValidDays: 180,
      serviceIntervalDays: DEFAULT_ORGANIZATION.fleet.serviceIntervalDays,
    });
    expect(s.regions).toEqual(DEFAULT_ORGANIZATION.regions);
  });
});
