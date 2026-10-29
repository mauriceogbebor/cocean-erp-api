/** Postgres numerics arrive as strings; money is returned as numbers. */
export const num = (v: string | null) => (v === null ? null : Number(v));
