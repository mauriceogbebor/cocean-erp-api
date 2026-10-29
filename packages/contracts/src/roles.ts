import type { Permission } from "./permissions";

/**
 * Starting role catalogue, matching the people in the prototype. Cocean
 * confirms the real roles, scopes and segregation rules in the first weeks;
 * roles live in the database, so changing them needs no code change.
 */
export type RoleDef = {
  name: string;
  description: string;
  permissions: Permission[];
};

const read: Permission[] = ["sites.read", "products.read", "approvals.read"];
const requester: Permission[] = [...read, "approvals.request"];

export const ROLES = {
  admin: {
    name: "System administrator",
    description:
      "Manages users, roles and reference data. Cannot approve business requests.",
    permissions: [
      "users.read",
      "users.manage",
      "roles.read",
      "audit.read",
      "sites.read",
      "sites.manage",
      "products.read",
      "products.manage",
      "approvals.read",
      "approvals.policies.manage",
    ],
  },
  md: {
    name: "Managing Director",
    description:
      "Sees the whole business and decides what is above every other limit.",
    permissions: [
      ...requester,
      "approvals.decide",
      "audit.read",
      "users.read",
      "roles.read",
    ],
  },
  executive: {
    name: "Head of Operations",
    description:
      "Runs operations; approves work orders and trucks into service.",
    permissions: [...requester, "approvals.decide", "audit.read"],
  },
  finance: {
    name: "Finance controller",
    description:
      "Confirms money, invoices and pays; approves within the finance limit.",
    permissions: [...requester, "approvals.decide", "audit.read"],
  },
  sales: {
    name: "Sales manager",
    description: "Turns customer requests into orders at the approved price.",
    permissions: requester,
  },
  procurement: {
    name: "Procurement lead",
    description: "Sources and buys at the best compliant price.",
    permissions: requester,
  },
  hr: {
    name: "HR and payroll manager",
    description: "Keeps staff records and prepares payroll.",
    permissions: requester,
  },
  operations: {
    name: "Operations supervisor",
    description: "Assigns trucks, bays and slots; reviews variances.",
    permissions: [...requester, "approvals.decide"],
  },
  depot: {
    name: "Loading supervisor",
    description: "Loads, seals, weighs and releases at the depot.",
    permissions: read,
  },
  fleet: {
    name: "Fleet and maintenance manager",
    description: "Keeps trucks legal, serviced and registered.",
    permissions: requester,
  },
  station: {
    name: "Station manager",
    description: "Runs a retail station's tanks, pumps and takings.",
    permissions: read,
  },
  security: {
    name: "Security and HSE lead",
    description:
      "Investigates custody cases; signs inductions and calibrations.",
    permissions: [...read, "audit.read"],
  },
  lpg: {
    name: "LPG plant manager",
    description: "Runs an LPG plant: safety, filling, receipt and day close.",
    permissions: requester,
  },
  weighbridge: {
    name: "Weighbridge operator",
    description: "Records weights at the weighbridge.",
    permissions: read,
  },
  driver: {
    name: "Tanker driver",
    description:
      "Proves arrival and photographs seals. Never confirms their own delivery.",
    permissions: [],
  },
} satisfies Record<string, RoleDef>;

export type RoleKey = keyof typeof ROLES;
export const roleKeys = Object.keys(ROLES) as RoleKey[];
