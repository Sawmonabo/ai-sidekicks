// What a human phase's input schema turns into, and where it stops turning into one.
//
// THE RENDER SET IS THE CORPUS'S, NOT THIS MODULE'S. `Spec-017 §Default Behavior` fixes
// the field types a `human` phase form may declare — text, long text, number, integer,
// boolean, enum, and an optional artifact field naming an already-ingested artifact —
// so the six kinds below are that set with `number` and `integer` sharing one control
// and differing by a flag. A seventh kind would be this renderer inventing a field the
// engine has no way to ask for.
//
// A CONTAINER IS NOT A FIELD. A one-level object and an array of one of those six are
// both admitted, and neither is a kind: they GROUP fields. Spelling them as kinds would
// have put the whole render set behind one dispatch and made "one level" a rule nothing
// could check, because a group holding groups is exactly the shape that has no bottom.
// So a group holds leaves and a leaf is a field or a list, and the type says so.
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

/** The six controls a human phase's form may ask through. */
export const SCHEMA_FIELD_KINDS = [
  "text",
  "long-text",
  "number",
  "checkbox",
  "choice",
  "artifact-reference",
] as const;

/** One control. Derived from the tuple, so the vocabulary has one home. */
export type SchemaFieldKind = (typeof SCHEMA_FIELD_KINDS)[number];

/**
 * The `format` annotations the two non-obvious kinds are declared by.
 *
 * Draft-07 gives a string type exactly one open extension point, and these are the
 * corpus's own field-type names spelled into it: a long-form answer and a reference to
 * an artifact are both strings on the wire, and nothing else in the schema distinguishes
 * them from a one-line answer.
 */
export const LONG_TEXT_FORMAT = "long_text";

/** The artifact field's `format`, naming an artifact ingested out of band. */
export const ARTIFACT_REFERENCE_FORMAT = "artifact";

/** One control the form draws, with everything it needs to draw itself. */
export interface SchemaFieldDescriptor {
  /** Where this member sits in the submitted object. One segment, or two in a group. */
  readonly memberPath: readonly string[];
  /** What a person reads. The schema's `title` where it has one, else the key. */
  readonly label: string;
  /** The schema's own `description`, or nothing where it carries none. */
  readonly description: string | undefined;
  readonly kind: SchemaFieldKind;
  readonly isRequired: boolean;
  /** The enum's members, present on `choice` alone and never empty there. */
  readonly choices: readonly string[] | undefined;
  /** True where the schema said `integer`, so the control steps by one. */
  readonly isInteger: boolean;
}

/** An array of one repeated control. The item's descriptor carries the array's path. */
export interface SchemaListDescriptor {
  readonly memberPath: readonly string[];
  readonly label: string;
  readonly description: string | undefined;
  readonly isRequired: boolean;
  /** What one entry is. Its own `memberPath` is the list's; the index is the render's. */
  readonly item: SchemaFieldDescriptor;
}

/**
 * What one entry of a list is called: the collection's name and where the entry sits.
 *
 * A NAME AND NOT A NUMBER. An array member has no key of its own, so the only thing that
 * distinguishes one repeated control from the next is its position — and a position on
 * its own ("entry 2") tells a person navigating by control nothing about which collection
 * they are in, which is exactly the reading a form with two lists would give them.
 *
 * Composed here beside the labels it is built from rather than at the surface that speaks
 * it, so the rendered name and any reading of it are one rule.
 */
export function listEntryLabel(list: SchemaListDescriptor, index: number): string {
  return `${list.label}, entry ${String(index + 1)}`;
}

/** What a group may hold: a control, or a list of one. Never another group. */
export type SchemaLeafEntry =
  | { readonly form: "field"; readonly field: SchemaFieldDescriptor }
  | { readonly form: "list"; readonly list: SchemaListDescriptor };

/** One level of nesting, and the type is where "one level" is enforced. */
export interface SchemaGroupDescriptor {
  readonly memberPath: readonly string[];
  readonly label: string;
  readonly description: string | undefined;
  readonly entries: readonly SchemaLeafEntry[];
}

/** Everything the form's root may hold. */
export type SchemaFormEntry =
  | SchemaLeafEntry
  | { readonly form: "group"; readonly group: SchemaGroupDescriptor };

/** Why a schema is answered in the raw editor instead of in drawn controls. */
export const SCHEMA_FALLBACK_CAUSES = [
  "root-not-an-object",
  "no-members",
  "member-out-of-set",
] as const;

/** One cause. Derived from the tuple for the reason every vocabulary here is. */
export type SchemaFallbackCause = (typeof SCHEMA_FALLBACK_CAUSES)[number];

/** What sent this schema to the raw editor, and which member did it. */
export interface SchemaFallback {
  readonly cause: SchemaFallbackCause;
  /** The member that could not be drawn. Empty on the two whole-schema causes. */
  readonly memberPath: readonly string[];
  /** One sentence, written for the person looking at the form. */
  readonly detail: string;
}

/** A schema drawn as controls, or answered as raw text. Never a refusal. */
export type SchemaFormPlan =
  | { readonly shape: "fields"; readonly entries: readonly SchemaFormEntry[] }
  | { readonly shape: "raw"; readonly fallback: SchemaFallback };

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
  };
}

/** The raw-editor answer for one member that could not be drawn. */
function outOfSet(memberPath: readonly string[]): SchemaFallback {
  return {
    cause: "member-out-of-set",
    memberPath,
    detail: `The schema asks for ${memberPath.join(".")} in a shape this form cannot draw, so the whole answer is given as JSON instead.`,
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
