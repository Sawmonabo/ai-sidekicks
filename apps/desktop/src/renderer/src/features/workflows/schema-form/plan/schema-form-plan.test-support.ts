// Readings shared by the mapper suites. `drawnEntries` throws on the raw arm so a case cannot
// pass by skipping behind its own `if`.

import type { SchemaFormEntry, SchemaFormPlan } from "./schema-fields.js";

/** One object schema over the given members, with the given ones required. */
export function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  return { type: "object", properties, required };
}

/** The entries a drawn plan resolved to, or a failure naming what it resolved to instead. */
export function drawnEntries(plan: SchemaFormPlan): readonly SchemaFormEntry[] {
  if (plan.shape !== "fields") {
    throw new Error(`expected drawn controls, got the raw arm: ${plan.fallback.cause}`);
  }
  return plan.entries;
}
