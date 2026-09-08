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

/** What a group may hold: a control, or a list of one. Never another group. */
export type SchemaLeafEntry =
  | { readonly form: "field"; readonly field: SchemaFieldDescriptor }
  | { readonly form: "list"; readonly list: SchemaListDescriptor };

/** One level of nesting, and the type is where "one level" is enforced. */
export interface SchemaGroupDescriptor {
  readonly memberPath: SchemaMemberPath;
  readonly label: string;
  readonly description: string | undefined;
  readonly entries: readonly SchemaLeafEntry[];
}

/** Everything the form's root may hold. */
export type SchemaFormEntry =
  | SchemaLeafEntry
  | { readonly form: "group"; readonly group: SchemaGroupDescriptor };

/**
 * Why a schema is answered in the raw editor instead of in drawn controls.
 *
 * `planSchemaForm` returns the first three and never the last: whether a schema COMPILES
 * into something an answer can be checked against is a question this module holds no
 * answer to, and the caller holding both readings composes it. The cause still lives
 * here, because a surface reads one vocabulary and a second enumeration beside this one
 * would be two closed sets describing one arm.
 */
export const SCHEMA_FALLBACK_CAUSES = [
  "root-not-an-object",
  "no-members",
  "member-out-of-set",
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
