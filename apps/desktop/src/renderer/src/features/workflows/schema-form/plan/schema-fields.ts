// The vocabulary of a form drawn from a human phase's input schema: field kinds, descriptors, the
// reasons a schema falls back to raw text, and what an unanswered member holds. The kinds are the
// engine's fixed set (number and integer share one control). Objects and arrays group fields and
// are not kinds: a group holds leaves, and a leaf is a field or a list.

import type { SchemaMemberPath } from "../schema-member-path.js";

/** The five controls a human phase's form may ask through. */
export const SCHEMA_FIELD_KINDS = ["text", "long-text", "number", "checkbox", "choice"] as const;

/** One control. Derived from the tuple, so the vocabulary has one home. */
export type SchemaFieldKind = (typeof SCHEMA_FIELD_KINDS)[number];

/**
 * Whether a JSON value is one this control could show. Displayable, not valid: an out-of-range
 * number is drawn and the validator complains, but a string at a number control renders as an
 * empty box. Takes the descriptor because a choice shows only its enumeration's members.
 */
export function valueSuitsField(field: SchemaFieldDescriptor, value: unknown): boolean {
  switch (field.kind) {
    case "number":
      // A non-finite number is not JSON and no numeric control renders one.
      return typeof value === "number" && Number.isFinite(value);
    case "checkbox":
      return typeof value === "boolean";
    case "choice":
      // `choices` is non-empty wherever this kind was resolved; an absent one shows nothing.
      return typeof value === "string" && (field.choices ?? []).includes(value);
    case "text":
    case "long-text":
      return typeof value === "string";
  }
}

/**
 * Whether this member is drawn as a two-state box rather than a three-state choice. A checkbox
 * cannot show "not answered", so an optional boolean goes through the choice control (unanswered,
 * yes, no); a box would report NO where the person said nothing, and a schema that tells those
 * apart (an optional member under `const: true`) would have no composable answer.
 * Reads `canBeUnanswered`, not `isRequired`, because a list entry is never absent.
 */
export function fieldDrawsAsCheckbox(field: SchemaFieldDescriptor): boolean {
  return field.kind === "checkbox" && !field.canBeUnanswered;
}

/** The empty answer the two text controls display and write when a person clears one. */
const EMPTY_TEXT = "";

/** What a collection nobody has added to holds. Never written to; only ever replaced. */
const NO_ENTRIES: readonly unknown[] = [];

/**
 * What a control of a kind displays while unanswered, as the value its `onChange` writes for it:
 * `""` for text, `false` for a checkbox, `undefined` for number and choice, whose empty state is
 * the member being absent.
 */
export function emptyControlValue(kind: SchemaFieldKind): unknown {
  switch (kind) {
    case "text":
    case "long-text":
      return EMPTY_TEXT;
    case "checkbox":
      return false;
    case "number":
    case "choice":
      return undefined;
  }
}

/**
 * What the answer holds at a member nobody has answered. A member is present exactly while
 * something on screen displays a value for it. Text, number and choice controls have an empty
 * state, so the member is absent until answered and absent again once cleared. A checkbox, a
 * collection and a group have none, so requiredness decides (`false`, `[]`, `{}`); an optional
 * box is drawn as a choice and an optional container follows `containerOpensAnswered`.
 */
export function unansweredFieldValue(field: SchemaFieldDescriptor): unknown {
  return fieldDrawsAsCheckbox(field) ? emptyControlValue(field.kind) : undefined;
}

/**
 * Whether a container opens answered. A group and a collection have no control of their own, so
 * an unopened section and an empty one look alike; an optional one is made present by the
 * activation control on its legend (`SchemaActivationControl.tsx`, state in `schema-draft.ts`).
 * A required container, or one whose schema declares a value, opens at the `{}` or `[]` shown.
 */
export function containerOpensAnswered(isRequired: boolean, hasDeclaredValue: boolean): boolean {
  return isRequired || hasDeclaredValue;
}

/** What a collection nobody is answering holds: `[]` if required, else absent. */
export function unansweredListValue(list: SchemaListDescriptor): unknown {
  return list.isRequired ? NO_ENTRIES : undefined;
}

/** The `format` annotation that declares the long-text kind (a long answer is a plain string). */
export const LONG_TEXT_FORMAT = "long_text";

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
  /**
   * Whether the answer may leave this member out. Not the negation of `isRequired`: a list
   * entry has no requiredness of its own and is never absent.
   */
  readonly canBeUnanswered: boolean;
  /** The enum's members, present on `choice` alone and never empty there. */
  readonly choices: readonly string[] | undefined;
  /** True where the schema said `integer`, so the control steps by one. */
  readonly isInteger: boolean;
  /** The schema's positive `multipleOf`, the numeric step, so control and validator agree. */
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

/** What a group may hold: a control, or a list of one. Never another group. */
export type SchemaLeafEntry =
  | { readonly form: "field"; readonly field: SchemaFieldDescriptor }
  | { readonly form: "list"; readonly list: SchemaListDescriptor };

/** One level of nesting, and the type is where "one level" is enforced. */
export interface SchemaGroupDescriptor {
  readonly memberPath: SchemaMemberPath;
  readonly label: string;
  readonly description: string | undefined;
  /** Whether the enclosing level requires this whole group; its legend shows the same marker. */
  readonly isRequired: boolean;
  readonly entries: readonly SchemaLeafEntry[];
  /**
   * The schema's `default` for the object itself, projected onto the child controls. A value a
   * child cannot show sends the schema to the raw editor (`default-undrawable`).
   */
  readonly defaultValue: unknown;
}

/** Everything the form's root may hold. */
export type SchemaFormEntry =
  | SchemaLeafEntry
  | { readonly form: "group"; readonly group: SchemaGroupDescriptor };

/** Where one leaf sits, whichever of the two forms it took. */
export function leafPathOf(leaf: SchemaLeafEntry): SchemaMemberPath {
  return leaf.form === "field" ? leaf.field.memberPath : leaf.list.memberPath;
}

/** The key a member path answers under inside its own level: the last segment, at any depth. */
export function memberKeyOf(memberPath: SchemaMemberPath): string | undefined {
  const last = memberPath[memberPath.length - 1];
  return last === undefined ? undefined : String(last);
}

/** The key one leaf answers under inside its group. */
export function leafKeyOf(leaf: SchemaLeafEntry): string | undefined {
  return memberKeyOf(leafPathOf(leaf));
}

/**
 * Why a schema is answered in the raw editor instead of drawn controls. `planSchemaForm` returns
 * the first five; the caller composes `schema-uncheckable` (the schema was read and refused) and
 * `checker-unavailable` (the compiler never arrived), which stay apart so a bad definition and a
 * failed chunk load are not blamed on the same party. `default-undrawable` covers any declared
 * value a control cannot display. `constraint-undrawable` names a member some level's
 * constraints can require but its `properties` never declare, with its full path, at any depth.
 */
export const SCHEMA_FALLBACK_CAUSES = [
  "root-not-an-object",
  "no-members",
  "member-out-of-set",
  "default-undrawable",
  "constraint-undrawable",
  "schema-uncheckable",
  "checker-unavailable",
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
