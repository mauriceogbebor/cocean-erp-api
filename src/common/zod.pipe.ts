import { BadRequestException, type PipeTransform } from "@nestjs/common";
import { formatLabels, type FormatKey } from "@qorrix-erp/contracts";
import type { ZodType } from "zod";
import { matchesFormat, org } from "./org.js";

const failed = (issues: { path: string; message: string }[]) =>
  new BadRequestException({ message: "Validation failed", issues });

const at = (v: unknown, path: string) =>
  path
    .split(".")
    .reduce<unknown>(
      (o, k) =>
        o && typeof o === "object"
          ? (o as Record<string, unknown>)[k]
          : undefined,
      v,
    );

/**
 * Validates a body or query with a shared @qorrix-erp/contracts schema. Fields
 * named in `formats` (by dot path) must also follow the organization's format
 * for that kind of ID, such as its phone numbers or number plates, and a
 * "region" field must be one of its states or regions.
 */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: ZodType<T>,
    private readonly formats: Record<string, FormatKey | "region"> = {},
  ) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success)
      throw failed(
        r.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      );
    const issues = Object.entries(this.formats).flatMap(([path, key]) => {
      const v = at(r.data, path);
      if (key === "region")
        return typeof v === "string" && !org().regions.includes(v)
          ? [
              {
                path,
                message: "Choose one of the organization's states or regions",
              },
            ]
          : [];
      return typeof v === "string" && !matchesFormat(key, v)
        ? [
            {
              path,
              message: `${formatLabels[key].replace(/s$/, "")} doesn't look right; for example ${org().formats[key].example}`,
            },
          ]
        : [];
    });
    if (issues.length) throw failed(issues);
    return r.data;
  }
}
