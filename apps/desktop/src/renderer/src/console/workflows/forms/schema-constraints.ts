// Which members ONE object schema's own constraints can require, read out of the
// constraints themselves rather than guessed from the shape of the form.
//
// WHY THIS EXISTS. A constraint is checked against the object it sits on and reported at
// that object's path, so a schema whose `oneOf` arms require members its own `properties`
// never declares draws every control it has, reports a finding about that object, and
// offers nobody a control that could ever clear it. That is the one shape a mapper whose
// whole promise is "never a refusal" must still refuse to DRAW: the raw editor can answer
// it and the drawn form cannot.
//
// AND IT IS ASKED AT EVERY LEVEL THAT DRAWS CONTROLS. The root asks it of its own members
// and each drawn group asks it of its own, because a group whose `oneOf` names a member
// that group declares no property for is the identical defect one level down — same
// unclearable finding, same person looking at it. One walk answers both: the caller
// supplies the schema whose constraints are being read and the names its controls drew,
// and the root is simply the instance where the enclosing path is empty.
//
// A UNION AND NOT A SATISFIABILITY VERDICT. Every name any of these arms can require is
// collected and each is asked of the drawn controls, rather than deciding which arm a
// person would eventually satisfy. Deciding that means evaluating the schema against an
// answer that does not exist yet — a guess dressed as an analysis — and a wrong guess
// draws exactly the form this walk exists to prevent. The trade is stated rather than
// hidden: a schema with one fully drawable arm beside one that names an undeclared member
// is answered as JSON, which is a legible form of a schema an author can then correct.
//
// `not` IS DELIBERATELY NOT WALKED. A `required` under a negation names a member that must
// be ABSENT, so no control is owed for it and collecting the name would send a schema to
// the raw editor for asking that something be left out.
//
// AND `properties` IS NOT DESCENDED INTO — WHICH IS WHAT MAKES THE PER-LEVEL CALL CORRECT.
// What a nested object requires of its own members is that object's business, asked again
// where that group is planned and against the controls that group drew. Descending here
// would collect a child's names into the parent's answer, where no control ever draws them
// and every nested `required` would read as a defect.

import { asRecord, requiredKeysOf } from "./schema-declarations.js";

/**
 * The keywords whose value is an ARRAY of subschemas, each of which can require members.
 *
 * `allOf` binds every arm and `oneOf` / `anyOf` bind one, which is a difference this walk
 * deliberately does not read — see the union rule in the header.
 */
const BRANCHING_ARM_LISTS = ["oneOf", "anyOf", "allOf"] as const;

/**
 * The keywords whose value is ONE subschema.
 *
 * `if` is here beside `then` and `else` because a condition naming a member no control
 * draws is a condition whose branch is decided before a person can touch anything, which
 * is the same defect read from the other side.
 */
const BRANCHING_ARM_SCHEMAS = ["if", "then", "else"] as const;

/** Collect from a value that may or may not be a subschema at all. */
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
 * Collect every member name one subschema and its own nested arms can require.
 *
 * The visited set is what makes this total over an untyped input: the walk descends
 * through arms a wire value supplied, and a value that reaches itself would otherwise
 * turn a probe into a hang.
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
  // The KEYS are the members whose presence triggers a dependency and the VALUES are what
  // the trigger then requires. A trigger no control draws can never be present, so the
  // dependency is inert and its key is not collected; what it would require is.
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

/**
 * Every member name one object schema's own constraints can require, in the order met.
 *
 * Ordered because the caller names ONE member in the sentence it shows a person, and the
 * first undrawn name met walking the schema as written is the one an author reading their
 * own document would look for first.
 *
 * The names are the object's OWN keys, unqualified — this walk knows nothing about where
 * in the form that object sits, and the caller that does supplies the path.
 */
export function membersConstraintsCanRequire(
  schema: Readonly<Record<string, unknown>>,
): readonly string[] {
  const collected = new Set<string>();
  collectFromSchema(schema, collected, new Set());
  return [...collected];
}
