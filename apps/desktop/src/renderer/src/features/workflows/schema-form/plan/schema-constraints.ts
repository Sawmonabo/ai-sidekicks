// Member names one object schema's own constraints can require. A requirement with no control
// draws a finding nobody can clear, so the planner sends that schema to the raw editor; it asks at
// the root and at every drawn group. The result is a union over all arms, not a verdict on which
// arm a person would satisfy (that needs an answer not yet given).

import { asRecord, requiredKeysOf } from "./schema-declarations.js";

/** Keywords whose value is an array of subschemas. `allOf` and `oneOf`/`anyOf` read alike. */
const BRANCHING_ARM_LISTS = ["oneOf", "anyOf", "allOf"] as const;

/** Keywords whose value is one subschema; an `if` naming an undrawn member is the same defect. */
const BRANCHING_ARM_SCHEMAS = ["if", "then", "else"] as const;

/**
 * Every member name one object schema's own constraints can require, in the order met, so the
 * caller's sentence can name the first one. Names are the object's own keys, unqualified.
 *
 * `not` is not walked (its `required` names members that must be absent) and `properties` is not
 * descended into (a nested object is asked where its own group is planned).
 */
export function membersConstraintsCanRequire(
  schema: Readonly<Record<string, unknown>>,
): readonly string[] {
  const collected = new Set<string>();
  collectFromSchema(schema, collected, new Set());
  return [...collected];
}

/** Collect from a value that may not be a subschema at all. */
function collectFromArm(
  arm: unknown,
  collected: Set<string>,
  visited: Set<Readonly<Record<string, unknown>>>,
): void {
  const schema = asRecord(arm);
  if (schema !== undefined) {
    collectFromSchema(schema, collected, visited);
  }
}

/**
 * Collect every member name one subschema and its nested arms can require. The visited set keeps
 * a schema that reaches itself from hanging the walk.
 */
function collectFromSchema(
  schema: Readonly<Record<string, unknown>>,
  collected: Set<string>,
  visited: Set<Readonly<Record<string, unknown>>>,
): void {
  if (visited.has(schema)) {
    return;
  }
  visited.add(schema);
  for (const memberName of requiredKeysOf(schema)) {
    collected.add(memberName);
  }
  // A `dependentRequired` trigger no control draws can never be present, so only what it
  // requires (the values) is collected, not the key.
  const dependentRequired = asRecord(schema["dependentRequired"]);
  for (const dependents of Object.values(dependentRequired ?? {})) {
    if (!Array.isArray(dependents)) {
      continue;
    }
    for (const memberName of dependents) {
      if (typeof memberName === "string") {
        collected.add(memberName);
      }
    }
  }
  const dependentSchemas = asRecord(schema["dependentSchemas"]);
  for (const armSchema of Object.values(dependentSchemas ?? {})) {
    collectFromArm(armSchema, collected, visited);
  }
  for (const keyword of BRANCHING_ARM_LISTS) {
    const arms = schema[keyword];
    if (!Array.isArray(arms)) {
      continue;
    }
    for (const arm of arms) {
      collectFromArm(arm, collected, visited);
    }
  }
  for (const keyword of BRANCHING_ARM_SCHEMAS) {
    collectFromArm(schema[keyword], collected, visited);
  }
}
