import { pathToFileURL } from "node:url";
import { hash } from "@node-rs/argon2";
import type { RoleKey } from "@cocean/contracts";
import { eq } from "drizzle-orm";
import { lagosDate } from "../common/dates.js";
import { createDb, type Db } from "./client.js";
import { seed } from "./seed.js";
import {
  customerLedger,
  customerSites,
  customers,
  priceListLines,
  priceLists,
  sites,
  stockMovements,
  tanks,
  userRoles,
  users,
  vendors,
} from "./schema.js";

/**
 * Sample people and records (customers, prices, tanks with stock, a supplier) for development and Cocean's trial runs: the
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
