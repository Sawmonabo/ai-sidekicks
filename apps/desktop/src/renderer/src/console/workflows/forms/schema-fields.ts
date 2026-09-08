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
// AND A MEMBER PATH IS THE VALIDATOR'S OWN. `SchemaMemberPath` is declared beside the
// schema reader that produces one, so a descriptor and a finding are addressed in one
// representation and the lookup between them is a comparison rather than a translation.

import type { SchemaMemberPath } from "../../bridge/index.js";

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
 * Whether a JSON value is one a control of this kind could show.
 *
 * KIND AND NOT CONSTRAINT. A number that a range refuses, or a string outside an
 * enumeration, is a value this control DRAWS and the compiled validator complains about —
 * a reading a person can see and act on. A string at a number control is the other thing:
 * nothing renders it, so a form holding one displays an empty box while the answer carries
 * text. This predicate separates exactly those two, which is why it reads the kind alone.
 *
 * Declared beside the vocabulary rather than at its one caller, because it IS the
 * vocabulary — the six kinds and the values they stand for are one fact.
 */
export function valueSuitsFieldKind(kind: SchemaFieldKind, value: unknown): boolean {
  switch (kind) {
    case "number":
      // A non-finite number is not JSON and no numeric control renders one.
      return typeof value === "number" && Number.isFinite(value);
    case "checkbox":
      return typeof value === "boolean";
    case "text":
    case "long-text":
    case "choice":
    case "artifact-reference":
      return typeof value === "string";
  }
}

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
  readonly memberPath: SchemaMemberPath;
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
  /**
   * The schema's own `multipleOf`, where it declared a positive one — the step the
   * numeric control takes, so what the platform refuses at the control is what the
   * compiled validator refuses a moment later. Absent, the control steps by the type.
   */
  readonly multipleOf: number | undefined;
  /** The schema's own `default`, which is what this member's control opens holding. */
  readonly defaultValue: unknown;
}

/** An array of one repeated control. The item's descriptor carries the array's path. */
export interface SchemaListDescriptor {
  readonly memberPath: SchemaMemberPath;
  readonly label: string;
  readonly description: string | undefined;
  readonly isRequired: boolean;
  /** What one entry is. Its own `memberPath` is the list's; the index is the render's. */
  readonly item: SchemaFieldDescriptor;
  /** The schema's own `default`, read as this collection's opening entries where it is one. */
  readonly defaultValue: unknown;
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

/**
 * What the control that adds one entry is CALLED, which is not what it reads.
 *
 * A FIELDSET LEGEND IS NOT PART OF A BUTTON'S ACCESSIBLE NAME. The legend names the
 * collection to somebody reading the form top to bottom, and says nothing at all to
 * somebody moving between buttons — so a form with two lists offered two controls called
 * "Add an entry", and pressing either of them added an entry to a collection the person
 * had not chosen. The visible text stays the short one, because the surrounding fieldset
 * IS the answer for a reader who can see it; the spoken name carries the collection.
 */
export function listAppendLabel(list: SchemaListDescriptor): string {
  return `Add an entry to ${list.label}`;
}

/**
 * What the control that drops one entry is called, composed from the entry's own name.
 *
 * The same defect one control over: "Remove entry 1" is the same sentence in every
 * collection on the form. It reuses `listEntryLabel` rather than composing a second
 * phrasing, so the control that removes an entry names exactly what the entry itself is
 * called and the two cannot drift.
 */
export function listRemoveLabel(list: SchemaListDescriptor, index: number): string {
  return `Remove ${listEntryLabel(list, index)}`;
}

/** What a group may hold: a control, or a list of one. Never another group. */
export type SchemaLeafEntry =
  | { readonly form: "field"; readonly field: SchemaFieldDescriptor }
  | { readonly form: "list"; readonly list: SchemaListDescriptor };

/**
 * Where one leaf sits, whichever of the two forms it took.
 *
 * Declared here beside the two descriptors it reads rather than at any of the surfaces
 * that ask it: the mapper asks which root member a leaf answers under, the form asks
 * which path to address a finding at, and the answer asks where to write a value. One
 * question, and it is about the vocabulary rather than about any of the three.
 */
export function leafPathOf(leaf: SchemaLeafEntry): SchemaMemberPath {
  return leaf.form === "field" ? leaf.field.memberPath : leaf.list.memberPath;
}

/**
 * The key one leaf answers under inside its group: the last segment of its own path.
 *
 * Derived from the path above rather than reading the descriptors a second time, so the
 * two readings cannot disagree about which of the two forms holds the path.
 */
export function leafKeyOf(leaf: SchemaLeafEntry): string | undefined {
  const memberPath = leafPathOf(leaf);
  const last = memberPath[memberPath.length - 1];
  return last === undefined ? undefined : String(last);
}

/** One level of nesting, and the type is where "one level" is enforced. */
export interface SchemaGroupDescriptor {
  readonly memberPath: SchemaMemberPath;
  readonly label: string;
  readonly description: string | undefined;
  readonly entries: readonly SchemaLeafEntry[];
  /**
   * The schema's own `default` for the object itself, read through the controls below it.
   *
   * A GROUP HAS NO CONTROL OF ITS OWN, so this is carried rather than displayed: the seed
   * projects each member of it onto the child control that shows that member, and a value
   * here that a child could not show is what sends the whole schema to the raw editor
   * (`default-undrawable`). Dropping it silently was the divergence — the schema's
   * own reading of `{}` supplies the object, so a form that ignored it displayed blank
   * controls while the accepted value carried the author's values.
   */
  readonly defaultValue: unknown;
}

/** Everything the form's root may hold. */
export type SchemaFormEntry =
  | SchemaLeafEntry
  | { readonly form: "group"; readonly group: SchemaGroupDescriptor };

/**
 * Why a schema is answered in the raw editor instead of in drawn controls.
 *
 * `planSchemaForm` returns the first five and never the last: whether a schema COMPILES
 * into something an answer can be checked against is a question this module holds no
 * answer to, and the caller holding both readings composes it. The cause still lives
 * here, because a surface reads one vocabulary and a second enumeration beside this one
 * would be two closed sets describing one arm.
 *
 * `default-undrawable` IS ABOUT ANY DECLARED VALUE, not only a group's. It was named for
 * the group case because that was the case that found it, and the rule is the same one
 * wherever a schema declares a value: a control that cannot display what the schema
 * declared for it would show one thing while the answer carried another.
 *
 * `root-constraint-undrawable` IS THE ONLY CAUSE ABOUT A MEMBER THE FORM NEVER MET. The
 * others name something the mapper read and could not draw; this one names a member the
 * root's own constraints can require and `properties` never declared, so the drawn form
 * would report a finding nobody had a control to clear.
 */
export const SCHEMA_FALLBACK_CAUSES = [
  "root-not-an-object",
  "no-members",
  "member-out-of-set",
  "default-undrawable",
  "root-constraint-undrawable",
  "schema-uncheckable",
] as const;

/** One cause. Derived from the tuple for the reason every vocabulary here is. */
export type SchemaFallbackCause = (typeof SCHEMA_FALLBACK_CAUSES)[number];

/** What sent this schema to the raw editor, and which member did it. */
export interface SchemaFallback {
  readonly cause: SchemaFallbackCause;
  /** The member that could not be drawn. Empty wherever the cause is the whole schema. */
  readonly memberPath: SchemaMemberPath;
  /** One sentence, written for the person looking at the form. */
  readonly detail: string;
}

/** A schema drawn as controls, or answered as raw text. Never a refusal. */
export type SchemaFormPlan =
  | { readonly shape: "fields"; readonly entries: readonly SchemaFormEntry[] }
  | { readonly shape: "raw"; readonly fallback: SchemaFallback };
