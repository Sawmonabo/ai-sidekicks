// Decides whether a human phase's input schema can be answered by a set of named values at all. A
// submitted answer travels as the request's `fields`, a plain object, so a root whose admitted
// values contain no object is refused as a definition fault (the raw editor could only compose
// the object the schema forbids). A root declaring nothing about its shape is answerable.

import { asRecord, declaredType } from "./schema-declarations.js";
import { refuse, type NarrowedRefusal } from "@renderer/lib/refusal.js";

/** The code a phase whose root admits no object answer refuses under. */
export const SCHEMA_ROOT_NOT_NAMED_VALUES = "schema-root-not-named-values";

/** The subsystem this refusal names: the reading of the phase's own input schema. */
const SCHEMA_ROOT_ORIGIN = "workflow-human-form-schema";

/** The one declared type an answer the request can carry is allowed to be. */
const OBJECT_TYPE = "object";

/**
 * The one sentence a person reads. It names what the definition did, and does not echo `type`,
 * `enum` or `const`, which are author-written and unbounded.
 */
const SCHEMA_ROOT_DETAIL =
  "This phase's schema asks for an answer that cannot be the set of named fields an answer is submitted as, so its definition has to be corrected before anybody can answer it.";

/**
 * The types this root declares, or nothing where it declares none readably. Both the string and
 * the array spelling are folded into one list; an array holding a non-string is unreadable.
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

/** The keywords whose arms an answer must satisfy one of. */
const ALTERNATION_KEYWORDS = ["oneOf", "anyOf"] as const;

/**
 * Whether this schema's root declares an answer the submit request cannot carry. False for a root
 * that declares nothing: an undeclared root did not ask for the wrong thing.
 */
export function schemaRootAsksOutsideNamedValues(inputSchema: unknown): boolean {
  return !objectAnswerIsPossible(inputSchema, new Set());
}

/**
 * The refusal such a phase carries, or nothing where its root can be answered. Shared by the run's
 * form and the definition preview so both show one sentence and one code.
 */
export function schemaRootRefusal(
  inputSchema: unknown,
): NarrowedRefusal<typeof SCHEMA_ROOT_NOT_NAMED_VALUES> | undefined {
  return schemaRootAsksOutsideNamedValues(inputSchema)
    ? refuse(SCHEMA_ROOT_ORIGIN, SCHEMA_ROOT_NOT_NAMED_VALUES, SCHEMA_ROOT_DETAIL)
    : undefined;
}

/**
 * Whether some object could satisfy this schema; asked of the root and of each combinator arm.
 * True for anything unreadable (a non-object declares nothing about the answer's shape) and for
 * a schema that is its own ancestor: a refusal comes only from a finished reading. The ancestor
 * set holds the path, not the history, so two arms naming one schema each get their own reading.
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

/** The five readings (type, enum, const, `oneOf`/`anyOf`, `allOf`) of one schema on the path. */
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
