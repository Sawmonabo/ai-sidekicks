// What one draft-07 member schema declares, read out of an untyped value: a phase definition's
// config has no wire shape, so every read is a probe that returns `undefined` for a member that
// is not what it claims. `asRecord` and `requiredKeysOf` live here so the planner, the
// constraint walk and the answer seed share one reading.

import { isWireRecord } from "@renderer/lib/wire-record.js";
import {
  LONG_TEXT_FORMAT,
  type SchemaFieldDescriptor,
  type SchemaFieldKind,
} from "./schema-fields.js";

/** A JSON value read as a record, or nothing where it is not one. */
export function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isWireRecord(value) ? value : undefined;
}

/** The declared `type`, as the one string draft-07 spells it with. */
export function declaredType(schema: Readonly<Record<string, unknown>>): string | undefined {
  return typeof schema["type"] === "string" ? schema["type"] : undefined;
}

/**
 * Which of the five kinds a member schema is, or nothing. `enum` is read before `type`: an
 * enumerated string carries both and the choice control is the richer reading.
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
 * One standalone control from the member schema and where it sits. A member the enclosing level
 * does not require may be left out of the answer, so requiredness and being unanswered are one
 * reading here.
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
 * One repeated control: a list entry exists once someone presses add, so it can never be
 * unanswered whatever the collection declared. `isRequired` carries the collection's requiredness.
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
 * The schema's `multipleOf`, or nothing where it is not strictly positive and finite: a control
 * given such a step would refuse every answer before the validator could say why.
 */
function multipleOfOf(schema: Readonly<Record<string, unknown>>): number | undefined {
  const declared = schema["multipleOf"];
  return typeof declared === "number" && Number.isFinite(declared) && declared > 0
    ? declared
    : undefined;
}
