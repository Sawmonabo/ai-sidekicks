// The mapper: what a human phase's input schema turns into, and where it stops turning into
// one. The vocabulary it produces — the six kinds, the descriptors, the fallback causes — lives
// in `schema-fields.ts`; this module is the walk from an untyped schema to that vocabulary.
//
// EVERYTHING ELSE FALLS BACK, AND NOTHING REFUSES. `$ref`, `oneOf`, a tuple's
// positional `items`, a nullable union, an object nested two deep: each of them is a
// schema this mapper cannot draw richly, and the answer is the raw editor beside the
// schema rather than a phase nobody can answer. The fallback carries WHICH member sent
// it there, because "this form could not be drawn" with no member named is a sentence
// an author cannot act on.
//
// THE INPUT IS `unknown` BY CONSTRUCTION. A phase definition carries its config as an
// untyped record — the wire declares no shape for it — so every read here is a probe
// and a member that is not what it claims lands in the fallback like any other.

import { encodeMemberPointer, type SchemaMemberPath } from "../../bridge/index.js";
import {
  ARTIFACT_REFERENCE_FORMAT,
  LONG_TEXT_FORMAT,
  type SchemaFallback,
  type SchemaFieldDescriptor,
  type SchemaFieldKind,
  type SchemaFormEntry,
  type SchemaFormPlan,
  type SchemaLeafEntry,
} from "./schema-fields.js";

/** A JSON value read as a record, or nothing where it is not one. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** The declared `type`, as the one string draft-07 spells it with. */
function declaredType(schema: Readonly<Record<string, unknown>>): string | undefined {
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
function fieldKindOf(schema: Readonly<Record<string, unknown>>): SchemaFieldKind | undefined {
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
function labelOf(schema: Readonly<Record<string, unknown>>, key: string): string {
  return typeof schema["title"] === "string" && schema["title"].length > 0 ? schema["title"] : key;
}

/** The schema's own sentence about this member, where it wrote one. */
function descriptionOf(schema: Readonly<Record<string, unknown>>): string | undefined {
  return typeof schema["description"] === "string" && schema["description"].length > 0
    ? schema["description"]
    : undefined;
}

/** The keys this object schema declares required, as a set that answers by key. */
function requiredKeysOf(schema: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  const required = schema["required"];
  return new Set(
    Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : [],
  );
}

/** One control, composed from the member schema and where it sits. */
function fieldDescriptor(
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
    choices: kind === "choice" ? stringEnumOf(schema) : undefined,
    isInteger: declaredType(schema) === "integer",
    multipleOf: multipleOfOf(schema),
    defaultValue: schema["default"],
  };
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

/** The raw-editor answer for one member that could not be drawn. */
function outOfSet(memberPath: SchemaMemberPath): SchemaFallback {
  return {
    cause: "member-out-of-set",
    memberPath,
    detail: `The schema asks for ${encodeMemberPointer(memberPath)} in a shape this form cannot draw, so the whole answer is given as JSON instead.`,
  };
}

/** One leaf — a control or an array of one — or the fallback the member forces. */
function planLeaf(
  memberSchema: unknown,
  memberPath: readonly string[],
  key: string,
  isRequired: boolean,
): SchemaLeafEntry | SchemaFallback {
  const schema = asRecord(memberSchema);
  if (schema === undefined) {
    return outOfSet(memberPath);
  }
  const kind = fieldKindOf(schema);
  if (kind !== undefined) {
    return { form: "field", field: fieldDescriptor(schema, kind, memberPath, key, isRequired) };
  }
  if (declaredType(schema) !== "array") {
    return outOfSet(memberPath);
  }
  const items = asRecord(schema["items"]);
  const itemKind = items === undefined ? undefined : fieldKindOf(items);
  if (items === undefined || itemKind === undefined) {
    // A tuple's positional `items`, an array of objects, an array of arrays: each is a
    // repetition of something this form has no control for, so the array goes with it.
    return outOfSet(memberPath);
  }
  return {
    form: "list",
    list: {
      memberPath,
      label: labelOf(schema, key),
      description: descriptionOf(schema),
      isRequired,
      defaultValue: schema["default"],
      item: fieldDescriptor(items, itemKind, memberPath, key, isRequired),
    },
  };
}

/**
 * Whether a planned entry came back as the fallback rather than as something to draw.
 *
 * Widened to every entry form rather than to the leaf pair, because both planners return
 * through it — the group planner answers with a group or a fallback, and the leaf planner
 * with a field, a list, or one. The discriminant is `cause`, which no entry form carries.
 */
function isFallback(value: SchemaFormEntry | SchemaFallback): value is SchemaFallback {
  return "cause" in value;
}

/** One level down: a group's own leaves, or the first fallback one of them forces. */
function planGroup(
  schema: Readonly<Record<string, unknown>>,
  memberPath: readonly string[],
  key: string,
): SchemaFormEntry | SchemaFallback {
  const properties = asRecord(schema["properties"]);
  if (properties === undefined || Object.keys(properties).length === 0) {
    return outOfSet(memberPath);
  }
  const required = requiredKeysOf(schema);
  const entries: SchemaLeafEntry[] = [];
  for (const [childKey, childSchema] of Object.entries(properties)) {
    const leaf = planLeaf(childSchema, [...memberPath, childKey], childKey, required.has(childKey));
    if (isFallback(leaf)) {
      return leaf;
    }
    entries.push(leaf);
  }
  return {
    form: "group",
    group: {
      memberPath,
      label: labelOf(schema, key),
      description: descriptionOf(schema),
      entries,
    },
  };
}

/**
 * Turn one input schema into the form the console draws for it.
 *
 * Total over every input: an unreadable schema, an empty one, and one carrying a member
 * outside the render set all resolve to the raw arm, which is what makes "never a
 * refusal" a property of the type rather than a promise in a comment.
 */
export function planSchemaForm(inputSchema: unknown): SchemaFormPlan {
  const schema = asRecord(inputSchema);
  if (
    schema === undefined ||
    (declaredType(schema) !== undefined && declaredType(schema) !== "object")
  ) {
    return {
      shape: "raw",
      fallback: {
        cause: "root-not-an-object",
        memberPath: [],
        detail:
          "This phase asks for something other than a set of named answers, so it is answered as JSON.",
      },
    };
  }
  const properties = asRecord(schema["properties"]);
  if (properties === undefined || Object.keys(properties).length === 0) {
    return {
      shape: "raw",
      fallback: {
        cause: "no-members",
        memberPath: [],
        detail: "This phase's schema names no members, so there is nothing to draw a control for.",
      },
    };
  }
  const required = requiredKeysOf(schema);
  const entries: SchemaFormEntry[] = [];
  for (const [key, memberSchema] of Object.entries(properties)) {
    const child = asRecord(memberSchema);
    const planned =
      child !== undefined && declaredType(child) === "object"
        ? planGroup(child, [key], key)
        : planLeaf(memberSchema, [key], key, required.has(key));
    if (isFallback(planned)) {
      return { shape: "raw", fallback: planned };
    }
    entries.push(planned);
  }
  return { shape: "fields", entries };
}
