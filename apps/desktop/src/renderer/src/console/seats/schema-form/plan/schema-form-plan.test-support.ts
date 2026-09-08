// The two readings every mapper case makes of a plan, kept in one place because both
// suites make them. `objectSchema` writes the shape the mapper is total over and
// `drawnEntries` is the assertion that a plan drew at all — a case that read `plan.entries`
// behind its own `if` would pass by skipping rather than by drawing.

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
