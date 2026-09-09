// What one draft-07 member schema DECLARES, read out of an untyped value.
//
// SPLIT FROM THE PLANNER BECAUSE THESE ARE PROBES AND THE PLANNER IS A WALK. Everything
// here answers one question about one schema record — what type did it name, what enum,
// what title, what step — and answers it with `undefined` wherever the record did not say
// or said something it could not have meant. Nothing here knows what a form is, which
// member is being read, or what happens when a reading comes back empty; those are the
// planner's, and holding both in one module was what took it past the length at which a
// reader stops seeing two jobs.
//
// THE INPUT IS `unknown` BY CONSTRUCTION. A phase definition carries its config as an
// untyped record — the wire declares no shape for it — so every read here is a probe and
// a member that is not what it claims comes back as nothing rather than as a cast.
//
// AND THE WHOLE-SCHEMA READERS LIVE HERE TOO. `asRecord` and `requiredKeysOf` are asked
// of a member schema, of a group, and of the root alike, which is why the constraint walk
// beside the planner reaches them here rather than reaching into the planner: two readers
// of one schema shape, one implementation of the reading.

import {
  ARTIFACT_REFERENCE_FORMAT,
  LONG_TEXT_FORMAT,
  type SchemaFieldDescriptor,
  type SchemaFieldKind,
} from "./schema-fields.js";

/** A JSON value read as a record, or nothing where it is not one. */
export function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** The declared `type`, as the one string draft-07 spells it with. */
export function declaredType(schema: Readonly<Record<string, unknown>>): string | undefined {
  return typeof schema["type"] === "string" ? schema["type"] : undefined;
}

/** The enum's members where every one of them is a string, else nothing. */
function stringEnumOf(schema: Readonly<Record<string, unknown>>): readonly string[] | undefined {
  const members = schema["enum"];
  if (!Array.isArray(members) || members.length === 0) {
    return undefined;
  }
  return members.every((member) => typeof member === "string")
    ? (members as readonly string[])
    : undefined;
}

/** The schema's `format`, which is where the two string-shaped kinds are declared. */
function declaredFormat(schema: Readonly<Record<string, unknown>>): string | undefined {
  return typeof schema["format"] === "string" ? schema["format"] : undefined;
}

/**
 * Which of the six a member schema is, or nothing where it is none of them.
 *
 * Order matters in one place and only one: `enum` is read BEFORE `type`, because an
 * enumerated string carries both and the choice control is the richer reading of it.
 */
export function fieldKindOf(
  schema: Readonly<Record<string, unknown>>,
): SchemaFieldKind | undefined {
  if (stringEnumOf(schema) !== undefined) {
    return "choice";
  }
  const type = declaredType(schema);
  if (type === "boolean") {
    return "checkbox";
  }
  if (type === "number" || type === "integer") {
    return "number";
  }
  if (type !== "string") {
    return undefined;
  }
  const format = declaredFormat(schema);
  if (format === ARTIFACT_REFERENCE_FORMAT) {
    return "artifact-reference";
  }
  return format === LONG_TEXT_FORMAT ? "long-text" : "text";
}

/** What a person reads above a control: the schema's `title`, else the member's key. */
export function labelOf(schema: Readonly<Record<string, unknown>>, key: string): string {
  return typeof schema["title"] === "string" && schema["title"].length > 0 ? schema["title"] : key;
}

/** The schema's own sentence about this member, where it wrote one. */
export function descriptionOf(schema: Readonly<Record<string, unknown>>): string | undefined {
  return typeof schema["description"] === "string" && schema["description"].length > 0
    ? schema["description"]
    : undefined;
}

/** The keys this object schema declares required, as a set that answers by key. */
export function requiredKeysOf(schema: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  const required = schema["required"];
  return new Set(
    Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [],
  );
}

/**
 * The schema's `multipleOf`, or nothing where it declared none worth stepping by.
 *
 * JSON Schema requires it to be strictly positive; a zero, a negative, or a non-finite
 * value is a schema the validator will refuse on its own terms, and a control given
 * that as a step would refuse every answer before the validator could say why.
 */
function multipleOfOf(schema: Readonly<Record<string, unknown>>): number | undefined {
  const declared = schema["multipleOf"];
  return typeof declared === "number" && Number.isFinite(declared) && declared > 0
    ? declared
    : undefined;
}

/**
 * One STANDALONE control, composed from the member schema and where it sits.
 *
 * A member the enclosing level does not require may be left out of the answer, which is
 * what its control's unanswered state means — so requiredness and the ability to be
 * unanswered are one reading here, and the entry constructor below is where they part.
 */
export function fieldDescriptor(
  schema: Readonly<Record<string, unknown>>,
  kind: SchemaFieldKind,
  memberPath: readonly string[],
  key: string,
  isRequired: boolean,
): SchemaFieldDescriptor {
  return {
    memberPath,
    label: labelOf(schema, key),
    description: descriptionOf(schema),
    kind,
    isRequired,
    canBeUnanswered: !isRequired,
    choices: kind === "choice" ? stringEnumOf(schema) : undefined,
    isInteger: declaredType(schema) === "integer",
    multipleOf: multipleOfOf(schema),
    defaultValue: schema["default"],
  };
}

/**
 * One REPEATED control: the same reading, at a position that always holds a value.
 *
 * A list entry exists the moment somebody presses the add control, so it can never be
 * absent however the collection itself was declared — which is why this is a named variant
 * rather than the same call with a different argument. The collection's own requiredness
 * still travels on `isRequired`, because that is what the entry belongs to and it is the
 * only requiredness the schema declared anywhere near it.
 */
export function listItemDescriptor(
  schema: Readonly<Record<string, unknown>>,
  kind: SchemaFieldKind,
  memberPath: readonly string[],
  key: string,
  isRequired: boolean,
): SchemaFieldDescriptor {
  return { ...fieldDescriptor(schema, kind, memberPath, key, isRequired), canBeUnanswered: false };
}
