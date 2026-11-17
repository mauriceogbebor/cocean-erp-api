import { pathToFileURL } from "node:url";
import { hash } from "@node-rs/argon2";
import {
  DEFAULT_ORGANIZATION,
  lineTotals,
  type RoleKey,
} from "@qorrix-erp/contracts";
import { nextNumber } from "../common/numbering.js";
import { eq } from "drizzle-orm";
import { addDays, businessDate } from "../common/dates.js";
import { createDb, type Db } from "./client.js";
import { seed } from "./seed.js";
import {
  approvalRequests,
  customerLedger,
  customerSites,
  customers,
  cylinders,
  employees,
  grades,
  organization,
  drivers,
  priceListLines,
  priceLists,
  pumps,
  sites,
  stockMovements,
  tanks,
  userRoles,
  userSites,
  users,
  vehicleDocuments,
  vehicles,
  vendors,
  workOrders,
} from "./schema.js";

/**
 * Sample people and records (customers, prices, tanks with stock, suppliers,
 * trucks and drivers, a station and an LPG plant) for development, demos and
 * trial runs. The organization is Northwind Petroleum, a made-up Nigerian
 * distributor; the people have the same names as the clickable demo, so both
 * tell one story. Records are
 * inserted directly (already approved), not through the approval flow.
 * Refuses to run in production, and does nothing if it has run before.
 */
export const SAMPLE_ORGANIZATION = {
  name: "Northwind Petroleum",
  legalName: "Northwind Petroleum Limited (sample data)",
};

export const SAMPLE_PEOPLE: {
  key: string;
  email: string;
  name: string;
  roles: RoleKey[];
}[] = [
  {
    key: "md",
    email: "kelechi.amadi@northwind.example",
    name: "Kelechi Amadi",
    roles: ["md"],
  },
  {
    key: "executive",
    email: "adaeze.nwosu@northwind.example",
    name: "Adaeze Nwosu",
    roles: ["executive"],
  },
  {
    key: "sales",
    email: "tunde.adeyemi@northwind.example",
    name: "Tunde Adeyemi",
    roles: ["sales"],
  },
  {
    key: "finance",
    email: "amina.bello@northwind.example",
    name: "Amina Bello",
    roles: ["finance"],
  },
  {
    key: "finance2",
    email: "chidinma.ude@northwind.example",
    name: "Chidinma Ude",
    roles: ["finance"],
  },
  {
    key: "procurement",
    email: "ifeoma.nnaji@northwind.example",
    name: "Ifeoma Nnaji",
    roles: ["procurement"],
  },
  {
    key: "operations",
    email: "chinonso.okafor@northwind.example",
    name: "Chinonso Okafor",
    roles: ["operations"],
  },
  {
    key: "depot",
    email: "sani.garba@northwind.example",
    name: "Sani Garba",
    roles: ["depot"],
  },
  {
    key: "security",
    email: "musa.abdullahi@northwind.example",
    name: "Musa Abdullahi",
    roles: ["security"],
  },
  {
    key: "fleet",
    email: "emeka.obi@northwind.example",
    name: "Emeka Obi",
    roles: ["fleet"],
  },
  {
    key: "station",
    email: "blessing.okoro@northwind.example",
    name: "Blessing Okoro",
    roles: ["station"],
  },
  {
    key: "lpg",
    email: "obinna.kalu@northwind.example",
    name: "Obinna Kalu",
    roles: ["lpg"],
  },
  {
    key: "hr",
    email: "halima.sani@northwind.example",
    name: "Halima Sani",
    roles: ["hr"],
  },
  {
    key: "admin",
    email: "ifeanyi.okeke@northwind.example",
    name: "Ifeanyi Okeke",
    roles: ["admin"],
  },
];

export async function seedSample(
  db: Db,
  password: string,
  admin?: { email: string; password: string },
) {
  await seed(db, admin);
  await db.transaction(async (tx) => {
    const [done] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.code, "CUS-107"));
    if (done) return;

    // Name the sample organization; everything else keeps the defaults.
    await tx
      .insert(organization)
      .values({
        id: 1,
        settings: { ...DEFAULT_ORGANIZATION, ...SAMPLE_ORGANIZATION },
      })
      .onConflictDoUpdate({
        target: organization.id,
        set: { settings: { ...DEFAULT_ORGANIZATION, ...SAMPLE_ORGANIZATION } },
      });

    const passwordHash = await hash(password);
    const ids: Record<string, string> = {};
    for (const p of SAMPLE_PEOPLE) {
      const [u] = await tx
        .insert(users)
        .values({ email: p.email, name: p.name, passwordHash })
        .onConflictDoNothing()
        .returning({ id: users.id });
      const id =
        u?.id ??
        (
          await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, p.email))
        )[0].id;
      ids[p.key] = id;
      for (const r of p.roles)
        await tx
          .insert(userRoles)
          .values({ userId: id, roleKey: r })
          .onConflictDoNothing();
    }

    await tx
      .insert(sites)
      .values([
        { code: "ONN-DEP", name: "Onne depot", kind: "depot", state: "Rivers" },
        {
          code: "PHC-HQ",
          name: "Port Harcourt head office",
          kind: "office",
          state: "Rivers",
        },
      ])
      .onConflictDoNothing();

    const today = businessDate();
    const [riverside] = await tx
      .insert(customers)
      .values({
        code: "CUS-107",
        name: "Riverside Construction Ltd",
        kind: "industrial",
        address: "12 Aba Road, Port Harcourt",
        terms: "credit",
        creditLimit: "40000000",
        creditDays: 30,
        openingBalance: "5000000",
      })
      .returning();
    await tx.insert(customerLedger).values({
      customerId: riverside.id,
      kind: "opening",
      ref: "OPENING",
      entryDate: today,
      dueOn: today,
      amount: "5000000",
    });
    const [harbour] = await tx
      .insert(customers)
      .values({
        code: "CUS-210",
        name: "Harbour Fuels Ltd",
        kind: "reseller",
        address: "3 Wharf Road, Apapa, Lagos",
      })
      .returning();
    const receiver = {
      receiverName: "Grace Nwankwo",
      receiverPhone: "08031234567",
    };
    await tx.insert(customerSites).values([
      {
        customerId: riverside.id,
        name: "Bridge site, Eleme",
        address: "Km 14 East-West Road, Eleme",
        state: "Rivers",
        ...receiver,
      },
      {
        customerId: riverside.id,
        name: "Batching plant, Onne",
        address: "Plot 8 FOT Road, Onne",
        state: "Rivers",
        ...receiver,
      },
      {
        customerId: harbour.id,
        name: "Apapa depot",
        address: "3 Wharf Road, Apapa",
        state: "Lagos",
        receiverName: "Yemi Alade",
        receiverPhone: "08061234567",
      },
    ]);

    const [pl] = await tx
      .insert(priceLists)
      .values({
        code: `PL-${today.slice(0, 4)}-${today.slice(5, 7)}`,
        validFrom: `${today.slice(0, 8)}01`,
        status: "approved",
        createdBy: ids.sales,
        approvedAt: new Date(),
      })
      .returning();
    await tx.insert(priceListLines).values(
      [
        ["AGO", "1240"],
        ["PMS", "950"],
        ["DPK", "1180"],
        ["LPG", "1050"],
      ].map(([productCode, price]) => ({
        priceListId: pl.id,
        productCode,
        price,
      })),
    );

    // A retail station and an LPG plant, each with its manager assigned.
    const [owerri, aba] = await tx
      .insert(sites)
      .values([
        {
          code: "OWR-01",
          name: "Owerri station",
          kind: "station",
          state: "Imo",
        },
        {
          code: "ABA-LPG",
          name: "Aba LPG plant",
          kind: "lpg_plant",
          state: "Abia",
        },
      ])
      .returning();
    const [owrPms, owrAgo, abaLpg] = await tx
      .insert(tanks)
      .values([
        {
          siteId: owerri.id,
          code: "OWR-T1",
          productCode: "PMS",
          capacity: "33000",
          safeCapacity: "31350",
        },
        {
          siteId: owerri.id,
          code: "OWR-T2",
          productCode: "AGO",
          capacity: "33000",
          safeCapacity: "31350",
        },
        {
          siteId: aba.id,
          code: "ABA-T1",
          productCode: "LPG",
          capacity: "20000",
          safeCapacity: "17000",
        },
      ])
      .returning();
    await tx.insert(stockMovements).values([
      { tankId: owrPms.id, kind: "opening", quantity: "21400", ref: "OPENING" },
      { tankId: owrAgo.id, kind: "opening", quantity: "14800", ref: "OPENING" },
      { tankId: abaLpg.id, kind: "opening", quantity: "11250", ref: "OPENING" },
    ]);
    await tx.insert(pumps).values([
      {
        siteId: owerri.id,
        tankId: owrPms.id,
        code: "P1",
        openingMeter: "184220.00",
      },
      {
        siteId: owerri.id,
        tankId: owrPms.id,
        code: "P2",
        openingMeter: "97305.00",
      },
      {
        siteId: owerri.id,
        tankId: owrAgo.id,
        code: "P3",
        openingMeter: "61880.00",
      },
    ]);
    await tx.insert(userSites).values([
      { userId: ids.station, siteId: owerri.id },
      { userId: ids.lpg, siteId: aba.id },
    ]);
    await tx.insert(cylinders).values([
      {
        serial: "CYL-12-0001",
        sizeKg: "12.5",
        owner: "Northwind",
        testDueOn: addDays(today, 400),
      },
      {
        serial: "CYL-12-0002",
        sizeKg: "12.5",
        owner: "Northwind",
        testDueOn: addDays(today, 200),
      },
      // Past its pressure test: the plant must refuse to fill it.
      {
        serial: "CYL-12-0417",
        sizeKg: "12.5",
        owner: "Mama Chinedu Stores",
        testDueOn: addDays(today, -12),
      },
      {
        serial: "CYL-06-0090",
        sizeKg: "6",
        owner: "Northwind",
        testDueOn: addDays(today, 500),
      },
    ]);

    const [onne] = await tx
      .select()
      .from(sites)
      .where(eq(sites.code, "ONN-DEP"));
    const tankRows = await tx
      .insert(tanks)
      .values([
        {
          siteId: onne.id,
          code: "ONN-T01",
          productCode: "AGO",
          capacity: "1000000",
          safeCapacity: "950000",
        },
        {
          siteId: onne.id,
          code: "ONN-T02",
          productCode: "PMS",
          capacity: "800000",
          safeCapacity: "760000",
        },
      ])
      .returning();
    await tx.insert(stockMovements).values([
      {
        tankId: tankRows[0].id,
        kind: "opening",
        quantity: "612400",
        ref: "OPENING",
      },
      {
        tankId: tankRows[1].id,
        kind: "opening",
        quantity: "418900",
        ref: "OPENING",
      },
    ]);

    await tx.insert(vendors).values({
      code: "VEN-031",
      name: "Delta Tyres & Parts Ltd",
      address: "22 Ikwerre Road, Port Harcourt",
      bankName: "Zenith Bank",
      accountNumber: "1012345678",
      accountName: "DELTA TYRES AND PARTS LTD",
      bankStatus: "verified",
      bankVerifiedAt: new Date(),
    });
    // Fleet: two trucks in service, one still being onboarded, two drivers.
    const truckRows = await tx
      .insert(vehicles)
      .values([
        {
          plate: "RIV-430-BN",
          kind: "tanker",
          capacity: "33000",
          compartments: [11000, 11000, 11000],
          ownership: "owned",
          trackerId: "ARC-88123",
          status: "active",
          createdBy: ids.fleet,
        },
        {
          plate: "ABA-207-AA",
          kind: "tanker",
          capacity: "45000",
          compartments: [15000, 15000, 15000],
          ownership: "transporter",
          transporterName: "Eastline Haulage Ltd",
          trackerId: "ARC-88140",
          status: "active",
          createdBy: ids.fleet,
        },
        {
          plate: "RIV-512-TX",
          kind: "tanker",
          capacity: "33000",
          compartments: [11000, 11000, 11000],
          ownership: "owned",
          status: "onboarding",
          createdBy: ids.fleet,
        },
      ])
      .returning();
    const papers = [
      "registration",
      "roadworthiness",
      "insurance",
      "nmdpra_permit",
      "calibration",
    ] as const;
    await tx.insert(vehicleDocuments).values(
      truckRows.flatMap((t, i) =>
        papers
          // RIV-512-TX is still waiting for its calibration certificate.
          .filter((k) => !(i === 2 && k === "calibration"))
          .map((kind) => ({
            vehicleId: t.id,
            kind,
            number: `${kind.toUpperCase().replace("_", "-")}-${t.plate}`,
            issuer:
              kind === "nmdpra_permit"
                ? "NMDPRA"
                : kind === "calibration"
                  ? "Weights and Measures"
                  : "Rivers State",
            // ABA-207-AA's insurance runs out soon, to show the warning.
            expiresOn:
              i === 1 && kind === "insurance"
                ? addDays(today, 20)
                : addDays(today, 300),
            recordedBy: ids.fleet,
          })),
      ),
    );
    await tx.insert(drivers).values([
      {
        name: "Sunday Okon",
        phone: "08051234567",
        licenceNumber: "RIV-DL-0001",
        licenceExpiresOn: addDays(today, 700),
        inductedOn: today,
      },
      {
        name: "Kunle Bakare",
        phone: "08061234567",
        licenceNumber: "ABA-DL-0002",
        licenceExpiresOn: addDays(today, 500),
        inductedOn: today,
        employer: "Eastline Haulage Ltd",
      },
    ]);

    await tx.insert(vendors).values({
      code: "VEN-040",
      name: "Gulf Products Trading Ltd",
      address: "Plot 3, Trans-Amadi Industrial Layout, Port Harcourt",
      bankName: "Access Bank",
      accountNumber: "0691111111",
      accountName: "GULF PRODUCTS TRADING LTD",
      bankStatus: "verified",
      bankVerifiedAt: new Date(),
    });
  });
  await seedSampleStaff(db, password);
  await seedSampleWorkshop(db);
}

/**
 * A few months of workshop history: a service and a repair on RIV-430-BN,
 * and RIV-512-TX in the workshop before it goes into service. Nothing is
 * left waiting for approval, and no truck is held.
 */
async function seedSampleWorkshop(db: Db) {
  await db.transaction(async (tx) => {
    const [done] = await tx
      .select({ id: workOrders.id })
      .from(workOrders)
      .limit(1);
    if (done) return;
    const plates = await tx
      .select({ id: vehicles.id, plate: vehicles.plate })
      .from(vehicles);
    const truck = (p: string) => plates.find((v) => v.plate === p)?.id;
    const riv430 = truck("RIV-430-BN");
    const riv512 = truck("RIV-512-TX");
    const who = async (key: string) => {
      const p = SAMPLE_PEOPLE.find((x) => x.key === key)!;
      const [u] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, p.email));
      return u?.id;
    };
    const fleet = await who("fleet");
    const ops = await who("operations");
    if (!riv430 || !riv512 || !fleet || !ops) return;
    const today = businessDate();
    const ago = (days: number) => addDays(today, -days);
    const at = (day: string, hour = 9) =>
      new Date(`${day}T${String(hour).padStart(2, "0")}:00:00+01:00`);

    type Line = {
      kind: "part" | "labour" | "outside";
      description: string;
      quantity: number;
      unitCost: number;
    };
    const jobs: {
      vehicleId: string;
      kind: string;
      title: string;
      lines: Line[];
      supplierName?: string;
      odometerKm: number;
      openedOn: string;
      completedOn?: string;
      offRoad: boolean;
    }[] = [
      {
        vehicleId: riv430,
        kind: "service",
        title: "10,000 km service",
        lines: [
          {
            kind: "part",
            description: "Engine oil and filters",
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
        odometerKm: 112_040,
        openedOn: ago(41),
        completedOn: ago(40),
        offRoad: false,
      },
      {
        vehicleId: riv430,
        kind: "repair",
        title: "Alternator not charging",
        lines: [
          {
            kind: "part",
            description: "Alternator, exchange unit",
            quantity: 1,
            unitCost: 165_000,
          },
          {
            kind: "outside",
            description: "Auto-electrician",
            quantity: 1,
            unitCost: 45_000,
          },
        ],
        supplierName: "Trans-Amadi Truck Clinic",
        odometerKm: 115_310,
        openedOn: ago(26),
        completedOn: ago(25),
        offRoad: true,
      },
      {
        vehicleId: riv512,
        kind: "repair",
        title: "Compartment 2 bottom valve leaking",
        lines: [
          {
            kind: "part",
            description: "Bottom valve, 4 inch",
            quantity: 1,
            unitCost: 310_000,
          },
          {
            kind: "labour",
            description: "Fitting and pressure test",
            quantity: 1,
            unitCost: 60_000,
          },
        ],
        odometerKm: 98_400,
        openedOn: ago(3),
        // Not in service yet, so there's nothing to hold.
        offRoad: false,
      },
    ];
    for (const j of jobs) {
      const t = lineTotals(j.lines);
      const number = await nextNumber(tx, "WO", at(j.openedOn));
      const [a] = await tx
        .insert(approvalRequests)
        .values({
          kind: "work_order",
          ref: number,
          title: `${j.title}`,
          amount: String(t.total),
          reason: "Sample data.",
          requestedBy: fleet,
          approverRole: "operations",
          status: "approved",
          decidedBy: ops,
          decidedAt: at(j.openedOn, 14),
          createdAt: at(j.openedOn, 10),
        })
        .returning({ id: approvalRequests.id });
      const [w] = await tx
        .insert(workOrders)
        .values({
          number,
          vehicleId: j.vehicleId,
          kind: j.kind,
          title: j.title,
          status: j.completedOn ? "completed" : "approved",
          offRoad: j.offRoad,
          heldFrom: j.offRoad ? at(j.openedOn) : null,
          releasedAt: j.offRoad && j.completedOn ? at(j.completedOn, 16) : null,
          odometerKm: j.odometerKm,
          supplierName: j.supplierName ?? null,
          estimateLines: j.lines,
          estimate: String(t.total),
          ...(j.completedOn
            ? {
                actualLines: j.lines,
                partsCost: String(t.part),
                labourCost: String(t.labour),
                outsideCost: String(t.outside),
                actualCost: String(t.total),
                completedOn: j.completedOn,
              }
            : {}),
          approvalId: a.id,
          openedBy: fleet,
          createdAt: at(j.openedOn),
        })
        .returning();
      if (j.offRoad && !j.completedOn)
        await tx
          .update(vehicles)
          .set({
            holdReason: `Work order ${number}: ${j.title}`,
            holdWorkOrderId: w.id,
          })
          .where(eq(vehicles.id, j.vehicleId));
    }
  });
}

/**
 * Northwind's staff and pay grades, for HR and payroll. Loaded on its own so
 * an installation that already has the rest of the sample data gets it too.
 */
async function seedSampleStaff(db: Db, password: string) {
  await db.transaction(async (tx) => {
    const [done] = await tx.select({ id: grades.id }).from(grades).limit(1);
    if (done) return;
    const hr = SAMPLE_PEOPLE.find((p) => p.key === "hr")!;
    const [made] = await tx
      .insert(users)
      .values({
        email: hr.email,
        name: hr.name,
        passwordHash: await hash(password),
      })
      .onConflictDoNothing()
      .returning({ id: users.id });
    const hrId =
      made?.id ??
      (
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, hr.email))
      )[0].id;
    await tx
      .insert(userRoles)
      .values({ userId: hrId, roleKey: "hr" })
      .onConflictDoNothing();

    const g = await tx
      .insert(grades)
      .values([
        {
          code: "G1",
          name: "Operative",
          minMonthly: "70000",
          maxMonthly: "250000",
        },
        {
          code: "G2",
          name: "Officer",
          minMonthly: "200000",
          maxMonthly: "500000",
        },
        {
          code: "G3",
          name: "Manager",
          minMonthly: "450000",
          maxMonthly: "1200000",
        },
        {
          code: "G4",
          name: "Head of department",
          minMonthly: "1000000",
          maxMonthly: "2500000",
        },
        {
          code: "G5",
          name: "Executive",
          minMonthly: "2000000",
          maxMonthly: "6000000",
        },
      ])
      .returning();
    const grade = (code: string) => g.find((x) => x.code === code)!.id;
    const site = async (code: string) =>
      (
        await tx
          .select({ id: sites.id })
          .from(sites)
          .where(eq(sites.code, code))
      )[0]?.id ?? null;
    const [hq, depot, owerri, aba] = await Promise.all(
      ["PHC-HQ", "ONN-DEP", "OWR-01", "ABA-LPG"].map(site),
    );
    // Monthly pay: basic, housing, transport, other.
    const staff: [
      string,
      string,
      string,
      string,
      string | null,
      string,
      number[],
      string,
      string,
    ][] = [
      [
        "Kelechi Amadi",
        "Executive",
        "Managing Director",
        "G5",
        hq,
        "Rivers",
        [2_000_000, 1_000_000, 300_000, 200_000],
        "Zenith Bank",
        "2001000101",
      ],
      [
        "Amina Bello",
        "Finance",
        "Finance controller",
        "G4",
        hq,
        "Rivers",
        [800_000, 400_000, 150_000, 50_000],
        "Guaranty Trust Bank",
        "0102000202",
      ],
      [
        "Halima Sani",
        "Human resources",
        "HR and payroll manager",
        "G3",
        hq,
        "Rivers",
        [450_000, 225_000, 75_000, 0],
        "Access Bank",
        "0703000303",
      ],
      [
        "Tunde Adeyemi",
        "Sales",
        "Sales manager",
        "G3",
        hq,
        "Rivers",
        [400_000, 200_000, 75_000, 25_000],
        "First Bank",
        "3004000404",
      ],
      [
        "Musa Abdullahi",
        "Operations",
        "Loading supervisor",
        "G2",
        depot,
        "Rivers",
        [200_000, 100_000, 40_000, 0],
        "United Bank for Africa",
        "2105000505",
      ],
      [
        "Sunday Okon",
        "Logistics",
        "Tanker driver",
        "G1",
        depot,
        "Rivers",
        [110_000, 50_000, 20_000, 0],
        "Fidelity Bank",
        "6206000606",
      ],
      [
        "Kunle Bakare",
        "Logistics",
        "Tanker driver",
        "G1",
        depot,
        "Rivers",
        [110_000, 50_000, 20_000, 0],
        "Wema Bank",
        "0207000707",
      ],
      [
        "Blessing Okoro",
        "Retail",
        "Station manager",
        "G2",
        owerri,
        "Imo",
        [180_000, 90_000, 30_000, 0],
        "Zenith Bank",
        "2208000808",
      ],
      [
        "Obinna Kalu",
        "LPG",
        "Plant manager",
        "G2",
        aba,
        "Abia",
        [190_000, 95_000, 35_000, 0],
        "Access Bank",
        "0709000909",
      ],
      [
        "Ngozi Eze",
        "Operations",
        "Weighbridge operator",
        "G1",
        depot,
        "Rivers",
        [90_000, 40_000, 15_000, 0],
        "First Bank",
        "3010001010",
      ],
    ];
    const funds = [
      "Stanbic IBTC Pension",
      "ARM Pension",
      "Leadway Pensure",
      "Access Pensions",
    ];
    for (const [
      i,
      [
        name,
        department,
        jobTitle,
        code,
        siteId,
        taxState,
        [basic, housing, transport, other],
        bankName,
        accountNumber,
      ],
    ] of staff.entries())
      await tx.insert(employees).values({
        number: await nextNumber(tx, "EMP"),
        name,
        department,
        jobTitle,
        siteId,
        gradeId: grade(code),
        employmentType: "permanent",
        status: "active",
        startDate: `202${i % 5}-0${(i % 9) + 1}-01`,
        basic: String(basic),
        housing: String(housing),
        transport: String(transport),
        other: String(other),
        bankName,
        accountNumber,
        accountName: name.toUpperCase(),
        pfa: funds[i % funds.length],
        rsaPin: `PEN${String(100200300400 + i * 1111)}`,
        taxState,
        nhfOptIn: i % 3 === 0,
        annualRent: String(i % 2 ? 1_800_000 : 0),
        activatedBy: hrId,
        createdBy: hrId,
      });
    // A joiner HR hasn't finished: no pension details yet.
    await tx.insert(employees).values({
      number: await nextNumber(tx, "EMP"),
      name: "Daniel Effiong",
      department: "Logistics",
      jobTitle: "Tanker driver",
      siteId: depot,
      gradeId: grade("G1"),
      employmentType: "contract",
      startDate: businessDate().slice(0, 8) + "01",
      basic: "100000",
      housing: "45000",
      transport: "20000",
      other: "0",
      bankName: "Polaris Bank",
      accountNumber: "1711001111",
      accountName: "DANIEL EFFIONG",
      taxState: "Rivers",
      createdBy: hrId,
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = process.env.DATABASE_URL;
  const password = process.env.SAMPLE_PASSWORD;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (process.env.NODE_ENV === "production")
    throw new Error("Sample data is never loaded in production");
  if (!password || password.length < 12)
    throw new Error("Set SAMPLE_PASSWORD (at least 12 characters)");
  const { db, pool } = createDb(url);
  const email = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  seedSample(
    db,
    password,
    email && adminPassword ? { email, password: adminPassword } : undefined,
  )
    .then(() =>
      console.log(
        `Sample data loaded. Sign in as ${SAMPLE_PEOPLE.map((p) => p.email).join(", ")}`,
      ),
    )
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => pool.end());
}
