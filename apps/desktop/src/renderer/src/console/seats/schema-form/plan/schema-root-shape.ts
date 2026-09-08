// What a human phase's input schema may ask for at its ROOT, and what happens where it
// asks for something else.
//
// THE RULE, STATED ONCE: can any object answer satisfy this root? A submitted answer
// travels as the request's `fields`, which is a set of named values and nothing else, and
// the submit surface reads that shape off what the form composed — a plain object or no
// submission at all. So the question this module answers is not which type a root spelled
// but whether the set of values the root admits contains one the wire can carry. Where it
// cannot, every schema-valid answer is refused after composition, and offering a control
// for it would be offering a control that cannot work.
//
// WHICH IS WHY IT IS A REFUSAL RATHER THAN THE RAW EDITOR. The editor is the mapper's
// answer to a schema it cannot DRAW, and it works because a person can still compose the
// object the wire wants. Here that object is the one thing the schema forbids, so an
// editor would invite an answer whose only settlement is the submit surface's own
// `answer-not-composed`. The fault is in the definition, and the surface says so where a
// person meets it.
//
// FIVE READINGS OVER SIX KEYWORDS CAN CLOSE THE SET, AND A ROOT DECLARING NONE OF THEM
// CANNOT — the count is the one `schemaAdmitsAnObject` below performs. A `type`
// naming anything but `object` closes it, and so does a `type` ARRAY holding no `object`
// — the union form declares the whole set the root admits, so a union of `string` and
// `null` is exactly as unanswerable as a bare `string`. An `enum` closes it where no
// member is a plain object, and a `const` where the one admitted value is not one.
// `oneOf` and `anyOf` close it where NO arm can be answered by an object, and `allOf`
// where ANY arm cannot, because those are the arms an answer has to satisfy respectively
// one of and all of. A root declaring none of them says nothing about whether the
// answer may be a set of named values, so the mapper's whole-schema fallback stands and
// its raw editor is answerable there — and so does a root that is absent, or is not a
// JSON object at all.
//
// THE COMBINATOR ARMS ARE READ BY THE SAME QUESTION, one implementation and not a second
// reading per keyword: an arm is a schema, and whether an object can satisfy it is what
// this module already decides. The descent carries the set of its own ANCESTORS, for the
// reason `schema-constraints.ts` beside it carries a visited set — the arms are values a
// caller supplied, and a value that reaches itself turns a probe into a hang. Ancestors
// and not everything seen, because this is a decision and that walk is a union: a schema
// reached twice down two different arms has to be read twice, or the second arm inherits
// an answer the first one's position earned. A schema that IS an ancestor answers
// "possible", which is this module's answer to everything it cannot finish reading — a
// refusal is only ever minted from a reading that completed.
//
// AND THE READING HAS ONE HOME. The mapper asks this module which roots it may draw from
// rather than deciding it a second time, so the arm a schema opens on and the refusal a
// schema earns can never disagree.

import { asRecord, declaredType } from "./schema-declarations.js";
import { refuse, type NarrowedRefusal } from "../../../core/index.js";

/** The code a phase whose root admits no object answer refuses under. */
export const SCHEMA_ROOT_NOT_NAMED_VALUES = "schema-root-not-named-values";

/** The subsystem this refusal names: the reading of the phase's own input schema. */
const SCHEMA_ROOT_ORIGIN = "workflow-human-form-schema";

/** The one declared type an answer the request can carry is allowed to be. */
const OBJECT_TYPE = "object";

/**
 * The one sentence a person reads, written for the person looking at the form.
 *
 * It names what the definition did rather than what the wire refuses, because the
 * remedy is in the definition and nowhere a participant can reach. What the root
 * declared is deliberately not interpolated: `type`, `enum` and `const` are all
 * author-written, and a refusal that echoed one would put an unbounded string where this
 * console renders a fixed sentence.
 */
const SCHEMA_ROOT_DETAIL =
  "This phase's schema asks for an answer that cannot be the set of named fields an answer is submitted as, so its definition has to be corrected before anybody can answer it.";

/**
 * The types this root declares, as a set, or nothing where it declares none readably.
 *
 * Both spellings answer the same question — the single string draft-07 names a type with,
 * and the array form that names a union of them — so the caller asks once whether
 * `object` is among the types admitted rather than branching on which spelling was used.
 * An array holding anything that is not a string is unreadable rather than partial: a
 * union half of which is uninterpretable declares nothing this can act on.
 */
function declaredTypeNames(
  schema: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
  const single = declaredType(schema);
  if (single !== undefined) {
    return [single];
  }
  const declared = schema["type"];
  if (!Array.isArray(declared) || declared.length === 0) {
    return undefined;
  }
  return declared.every((member) => typeof member === "string")
    ? (declared as readonly string[])
    : undefined;
}

/** Whether an `enum` on this schema, where it declares a readable one, admits an object. */
function enumAdmitsAnObject(schema: Readonly<Record<string, unknown>>): boolean {
  const members = schema["enum"];
  if (!Array.isArray(members)) {
    return true;
  }
  return members.some((member) => asRecord(member) !== undefined);
}

/** Whether a `const` on this schema, where it declares one, is itself an object. */
function constantIsAnObject(schema: Readonly<Record<string, unknown>>): boolean {
  return Object.hasOwn(schema, "const") ? asRecord(schema["const"]) !== undefined : true;
}

/** The two keywords whose arms an answer satisfies ONE of. */
const ALTERNATION_KEYWORDS = ["oneOf", "anyOf"] as const;

/**
 * Whether some object could satisfy this schema — the module's whole question, asked of
 * the root by its callers and of each combinator arm by itself.
 *
 * True for anything unreadable, on the header's rule: a value that is not a JSON object
 * declares nothing about the answer's shape, which is a different fact from declaring the
 * wrong one. True as well for a schema that is its own ancestor, which is the same rule
 * applied to a structure this cannot finish reading.
 *
 * The ancestor set is added to on the way down and taken from on the way back up, so it
 * holds the PATH rather than the history: two arms naming one schema each get their own
 * reading of it, and only a schema reaching itself is given up on.
 */
function objectAnswerIsPossible(
  candidate: unknown,
  ancestors: Set<Readonly<Record<string, unknown>>>,
): boolean {
  const schema = asRecord(candidate);
  if (schema === undefined || ancestors.has(schema)) {
    return true;
  }
  ancestors.add(schema);
  const possible = schemaAdmitsAnObject(schema, ancestors);
  ancestors.delete(schema);
  return possible;
}

/** The five readings, asked of one schema record already placed on the ancestor path. */
function schemaAdmitsAnObject(
  schema: Readonly<Record<string, unknown>>,
  ancestors: Set<Readonly<Record<string, unknown>>>,
): boolean {
  const typeNames = declaredTypeNames(schema);
  if (typeNames !== undefined && !typeNames.includes(OBJECT_TYPE)) {
    return false;
  }
  if (!enumAdmitsAnObject(schema) || !constantIsAnObject(schema)) {
    return false;
  }
  for (const alternation of ALTERNATION_KEYWORDS) {
    const arms = schema[alternation];
    if (Array.isArray(arms) && !arms.some((arm) => objectAnswerIsPossible(arm, ancestors))) {
      return false;
    }
  }
  const conjunction = schema["allOf"];
  return (
    !Array.isArray(conjunction) ||
    conjunction.every((arm) => objectAnswerIsPossible(arm, ancestors))
  );
}

/**
 * Whether this schema's root declares an answer the submit request cannot carry.
 *
 * False for a root that declares nothing — see the header: an undeclared root is not a
 * root that asked for the wrong thing.
 */
export function schemaRootAsksOutsideNamedValues(inputSchema: unknown): boolean {
  return !objectAnswerIsPossible(inputSchema, new Set());
}

/**
 * The refusal such a phase carries, or nothing where its root can be answered at all.
 *
 * Composed here rather than at each surface so the two that render it — the run's form
 * and the definition preview beside it — say one thing, and so the code they render is
 * the constant above rather than a string spelled twice.
 */
export function schemaRootRefusal(
  inputSchema: unknown,
): NarrowedRefusal<typeof SCHEMA_ROOT_NOT_NAMED_VALUES> | undefined {
  return schemaRootAsksOutsideNamedValues(inputSchema)
    ? refuse(SCHEMA_ROOT_ORIGIN, SCHEMA_ROOT_NOT_NAMED_VALUES, SCHEMA_ROOT_DETAIL)
    : undefined;
}
