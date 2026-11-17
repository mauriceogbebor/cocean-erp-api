import { pathToFileURL } from "node:url";
import { hash } from "@node-rs/argon2";
import type { RoleKey } from "@cocean/contracts";
import { eq } from "drizzle-orm";
import { addDays, lagosDate } from "../common/dates.js";
import { createDb, type Db } from "./client.js";
import { seed } from "./seed.js";
import {
  customerLedger,
  customerSites,
  customers,
  cylinders,
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
} from "./schema.js";

/**
 * Sample people and records (customers, prices, tanks with stock, suppliers, trucks and drivers, a station and an LPG plant) for development and Cocean's trial runs: the
 * same names as the clickable demo, so both tell one story. Records are
 * inserted directly (already approved), not through the approval flow.
 * Refuses to run in production, and does nothing if it has run before.
 */
export const SAMPLE_PEOPLE: {
  key: string;
  email: string;
  name: string;
  roles: RoleKey[];
}[] = [
  {
    key: "md",
    email: "kelechi.amadi@cocean.dev",
    name: "Kelechi Amadi",
    roles: ["md"],
  },
  {
    key: "executive",
    email: "adaeze.nwosu@cocean.dev",
    name: "Adaeze Nwosu",
    roles: ["executive"],
  },
  {
    key: "sales",
    email: "tunde.adeyemi@cocean.dev",
    name: "Tunde Adeyemi",
    roles: ["sales"],
  },
  {
    key: "finance",
    email: "amina.bello@cocean.dev",
    name: "Amina Bello",
    roles: ["finance"],
  },
  {
    key: "finance2",
    email: "chidinma.ude@cocean.dev",
    name: "Chidinma Ude",
    roles: ["finance"],
  },
  {
    key: "procurement",
    email: "ifeoma.nnaji@cocean.dev",
    name: "Ifeoma Nnaji",
    roles: ["procurement"],
  },
  {
    key: "operations",
    email: "chinonso.okafor@cocean.dev",
    name: "Chinonso Okafor",
    roles: ["operations"],
  },
  {
    key: "depot",
    email: "sani.garba@cocean.dev",
    name: "Sani Garba",
    roles: ["depot"],
  },
  {
    key: "security",
    email: "musa.abdullahi@cocean.dev",
    name: "Musa Abdullahi",
    roles: ["security"],
  },
  {
    key: "fleet",
    email: "emeka.obi@cocean.dev",
    name: "Emeka Obi",
    roles: ["fleet"],
  },
  {
    key: "station",
    email: "blessing.okoro@cocean.dev",
    name: "Blessing Okoro",
    roles: ["station"],
  },
  {
    key: "lpg",
    email: "obinna.kalu@cocean.dev",
    name: "Obinna Kalu",
    roles: ["lpg"],
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

    const today = lagosDate();
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
        owner: "Cocean",
        testDueOn: addDays(today, 400),
      },
      {
        serial: "CYL-12-0002",
        sizeKg: "12.5",
        owner: "Cocean",
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
        owner: "Cocean",
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
