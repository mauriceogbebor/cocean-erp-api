import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { DEFAULT_PAYROLL_RULES } from "@qorrix-erp/contracts";
import { annualTax, calcPay } from "../src/people/pay-calc.js";
import { ADMIN, as, freshDatabase, login, startApp } from "./harness.js";

let app: INestApplication;
const people = {
  hr: { email: "halima@erp.test", name: "Halima Sani", roles: ["hr"] },
  finance: { email: "amina@erp.test", name: "Amina Bello", roles: ["finance"] },
  md: { email: "kelechi@erp.test", name: "Kelechi Amadi", roles: ["md"] },
  sales: { email: "tunde@erp.test", name: "Tunde Adeyemi", roles: ["sales"] },
};
type Who = keyof typeof people | "admin";
const PASSWORD = "a-good-long-password";
const u = {} as Record<Who, ReturnType<typeof as>>;
const ids = { g1: "", g2: "", ada: "", bayo: "", chi: "", run: "" };

const staff = (over: Record<string, unknown> = {}) => ({
  name: "Ada Obi",
  gradeId: ids.g2,
  startDate: "2026-01-01",
  department: "Finance",
  jobTitle: "Accounts officer",
  taxState: "Rivers",
  pay: { basic: 300_000, housing: 150_000, transport: 50_000 },
  bankName: "Zenith Bank",
  accountNumber: "0123456789",
  accountName: "Ada Obi",
  pfa: "Stanbic IBTC Pension",
  rsaPin: "PEN100200300400",
  ...over,
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
  ids.g1 = (
    await u.hr
      .post("/v1/grades", {
        code: "G1",
        name: "Officer",
        minMonthly: 100_000,
        maxMonthly: 300_000,
      })
      .expect(201)
  ).body.id;
  ids.g2 = (
    await u.hr
      .post("/v1/grades", {
        code: "G2",
        name: "Senior officer",
        minMonthly: 300_000,
        maxMonthly: 700_000,
      })
      .expect(201)
  ).body.id;
});
afterAll(() => app.close());

describe("PAYE under the organization's rules", () => {
  const rules = DEFAULT_PAYROLL_RULES;
  it("works the 2026 bands on annual chargeable income", () => {
    // ₦5.52m: nothing on the first ₦800k, 15% of ₦2.2m, 18% of the rest.
    expect(annualTax(552_000_000, rules.taxBands)).toBe(78_360_000);
  });
  it("takes pension before tax, and nothing from someone on the minimum wage", () => {
    const p = calcPay(
      {
        basic: 300_000,
        housing: 150_000,
        transport: 50_000,
        other: 0,
        nhfOptIn: false,
        annualRent: 0,
        startDate: "2025-01-01",
        exitDate: null,
      },
      "2026-11",
      rules,
    )!;
    expect(p).toMatchObject({
      gross: 500_000,
      pensionEmployee: 40_000,
      paye: 65_300,
      net: 394_700,
      pensionEmployer: 50_000,
      nsitf: 5_000,
      itf: 5_000,
    });
    const low = calcPay(
      {
        basic: 70_000,
        housing: 0,
        transport: 0,
        other: 0,
        nhfOptIn: false,
        annualRent: 0,
        startDate: "2025-01-01",
        exitDate: null,
      },
      "2026-11",
      rules,
    )!;
    expect(low.paye).toBe(0);
  });
  it("gives rent relief, the housing fund on consent, and a part month to a joiner", () => {
    const p = calcPay(
      {
        basic: 300_000,
        housing: 150_000,
        transport: 50_000,
        other: 0,
        nhfOptIn: true,
        annualRent: 3_000_000,
        startDate: "2026-11-16",
        exitDate: null,
      },
      "2026-11",
      rules,
    )!;
    expect(p.factor).toBe(0.5);
    expect(p.gross).toBe(250_000);
    expect(p.nhf).toBe(3_750); // 2.5% of basic, half a month
    // Relief is capped at ₦500k a year: (6m − 480k − 90k − 500k) through the bands.
    expect(p.paye).toBe(
      Math.round(
        Math.round(annualTax(493_000_000, rules.taxBands) / 12) * 0.5,
      ) / 100,
    );
    expect(p.joiner).toBe(true);
  });
});

describe("staff records", () => {
  it("keeps pay inside the grade's band and checks the organization's formats", async () => {
    const out = await u.hr
      .post("/v1/employees", staff({ gradeId: ids.g1 }))
      .expect(422);
    expect(out.body.message).toContain("outside G1's band");
    const phone = await u.hr
      .post("/v1/employees", staff({ phone: "+44 20 7946 0000" }))
      .expect(400);
    expect(phone.body.issues[0].path).toBe("phone");
    await u.sales.post("/v1/employees", staff()).expect(403);
    await u.sales.get("/v1/employees").expect(403);
    ids.ada = (await u.hr.post("/v1/employees", staff()).expect(201)).body.id;
  });

  it("activates a joiner only with bank and pension details nobody else uses", async () => {
    await u.hr.post(`/v1/employees/${ids.ada}/activate`).expect(200);
    ids.bayo = (
      await u.hr
        .post(
          "/v1/employees",
          staff({
            name: "Bayo Ade",
            accountNumber: "0123456789",
            accountName: "Bayo Ade",
            rsaPin: "PEN555666777888",
          }),
        )
        .expect(201)
    ).body.id;
    const shared = await u.hr
      .post(`/v1/employees/${ids.bayo}/activate`)
      .expect(422);
    expect(shared.body.message).toContain("already Ada Obi's");
    await u.hr
      .put(`/v1/employees/${ids.bayo}`, { accountNumber: "0987654321" })
      .expect(200);
    await u.hr.post(`/v1/employees/${ids.bayo}/activate`).expect(200);
    ids.chi = (
      await u.hr
        .post(
          "/v1/employees",
          staff({
            name: "Chi Eze",
            gradeId: ids.g1,
            pay: { basic: 150_000, housing: 50_000 },
            accountNumber: "1112223334",
            rsaPin: undefined,
            pfa: undefined,
            startDate: "2026-11-16",
          }),
        )
        .expect(201)
    ).body.id;
    const noPension = await u.hr
      .post(`/v1/employees/${ids.chi}/activate`)
      .expect(422);
    expect(noPension.body.message).toContain("No pension fund");
    await u.hr
      .put(`/v1/employees/${ids.chi}`, {
        pfa: "ARM Pension",
        rsaPin: "PEN999888777666",
      })
      .expect(200);
    await u.hr.post(`/v1/employees/${ids.chi}/activate`).expect(200);
  });

  it("changes pay only with a reason and inside the band", async () => {
    await u.hr
      .post(`/v1/employees/${ids.bayo}/pay`, {
        basic: 800_000,
        reason: "Promotion",
      })
      .expect(422);
    await u.hr
      .post(`/v1/employees/${ids.bayo}/pay`, { basic: 400_000 })
      .expect(400);
    const r = await u.hr
      .post(`/v1/employees/${ids.bayo}/pay`, {
        basic: 400_000,
        housing: 150_000,
        transport: 50_000,
        reason: "Annual review",
      })
      .expect(200);
    expect(r.body.basic).toBe("400000.00");
  });
});

describe("payroll", () => {
  it("works out the month from active staff, with part months for joiners", async () => {
    const r = await u.hr
      .post("/v1/payroll-runs", { period: "2026-11" })
      .expect(201);
    ids.run = r.body.id;
    const run = (await u.finance.get(`/v1/payroll-runs/${ids.run}`).expect(200))
      .body;
    expect(run.headcount).toBe(3);
    const chi = run.lines.find((l: { name: string }) => l.name === "Chi Eze");
    expect(chi.factor).toBe(0.5);
    expect(chi.flags).toEqual(["joiner"]);
    const ada = run.lines.find((l: { name: string }) => l.name === "Ada Obi");
    expect(ada).toMatchObject({ gross: 500_000, paye: 65_300, net: 394_700 });
    expect(run.remittances.paye[0]).toMatchObject({ to: "Rivers" });
    expect(run.employerCost).toBe(
      run.gross + run.pensionEmployer + run.nsitf + run.itf,
    );
  });

  it("goes to the MD, and is paid by Finance from the bank file", async () => {
    await u.finance.post(`/v1/payroll-runs/${ids.run}/submit`, {}).expect(403);
    await u.hr.post(`/v1/payroll-runs/${ids.run}/submit`, {}).expect(200);
    // Nothing changes once it's gone for approval.
    await u.hr.post("/v1/payroll-runs", { period: "2026-11" }).expect(409);
    await u.finance.get(`/v1/payroll-runs/${ids.run}/bank-file`).expect(409);
    const approvals = (
      await u.md.get("/v1/approvals?status=pending").expect(200)
    ).body;
    const req = (approvals.items ?? approvals).find(
      (a: { kind: string }) => a.kind === "payroll",
    );
    expect(req.approverRole).toBe("md");
    await u.finance
      .post(`/v1/approvals/${req.id}/decide`, { decision: "approved" })
      .expect(403);
    await u.md
      .post(`/v1/approvals/${req.id}/decide`, { decision: "approved" })
      .expect(200);
    const file = await u.finance
      .get(`/v1/payroll-runs/${ids.run}/bank-file`)
      .expect(200);
    expect(file.headers["content-type"]).toContain("text/csv");
    expect(file.text).toContain('"0123456789"');
    expect(file.text).toContain('"394700.00"');
    await u.hr.get(`/v1/payroll-runs/${ids.run}/bank-file`).expect(403);
    await u.finance
      .post(`/v1/payroll-runs/${ids.run}/pay`, {
        paidOn: "2026-11-27",
        bankRef: "BULK-7781",
      })
      .expect(200);
    const slip = (
      await u.hr
        .get(`/v1/payroll-runs/${ids.run}/payslips/${ids.ada}`)
        .expect(200)
    ).body;
    expect(slip.line.net).toBe(394_700);
    expect(slip.run.status).toBe("paid");
  });

  it("stops a run with a blocking problem, and asks for a note on a sharp change", async () => {
    // A leaver in December is paid to their exit date.
    await u.hr
      .post(`/v1/employees/${ids.chi}/exit`, {
        exitDate: "2026-12-15",
        reason: "Resigned",
      })
      .expect(200);
    // Ada's pay doubles: a warning, not a stop.
    await u.hr
      .post(`/v1/employees/${ids.ada}/pay`, {
        basic: 600_000,
        housing: 50_000,
        reason: "Acting head of finance",
      })
      .expect(200);
    const dec = (
      await u.hr.post("/v1/payroll-runs", { period: "2026-12" }).expect(201)
    ).body.id;
    const run = (await u.hr.get(`/v1/payroll-runs/${dec}`).expect(200)).body;
    const chi = run.lines.find((l: { name: string }) => l.name === "Chi Eze");
    expect(chi.flags).toContain("leaver");
    expect(chi.factor).toBeCloseTo(15 / 31, 4);
    expect(
      run.lines.find((l: { name: string }) => l.name === "Ada Obi").flags,
    ).toContain("pay_jump");
    const noNote = await u.hr
      .post(`/v1/payroll-runs/${dec}/submit`, {})
      .expect(422);
    expect(noNote.body.message).toContain("Ada Obi");
    await u.hr
      .post(`/v1/payroll-runs/${dec}/submit`, {
        note: "Ada is acting head of finance from December; letter on file.",
      })
      .expect(200);
  });
});
