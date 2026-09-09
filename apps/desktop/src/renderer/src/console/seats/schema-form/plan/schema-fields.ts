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

import type { SchemaMemberPath } from "../../../bridge/index.js";

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
 * Whether a JSON value is one THIS control could show.
 *
 * DISPLAYABLE AND NOT VALID. A number a range refuses, or a string shorter than a
 * `minLength`, is a value the control DRAWS and the compiled validator complains about —
 * a reading a person can see and act on. A string at a number control is the other thing:
 * nothing renders it, so a form holding one displays an empty box while the answer carries
 * text. This predicate separates exactly those two.
 *
 * WHICH IS WHY IT TAKES THE DESCRIPTOR AND NOT THE KIND. Read from the kind alone, a
 * choice was "any string" — and a choice control offers this enumeration's members and one
 * unanswered option, so a declared value outside the set shows "Not answered" while the
 * seed carries it. The set is part of what that control can display, and it lives on the
 * descriptor. Every other kind is decided by its kind, and says so by not reading anything
 * else.
 *
 * Declared beside the vocabulary rather than at its one caller, because it IS the
 * vocabulary — the six kinds and the values they stand for are one fact.
 */
export function valueSuitsField(field: SchemaFieldDescriptor, value: unknown): boolean {
  switch (field.kind) {
    case "number":
      // A non-finite number is not JSON and no numeric control renders one.
      return typeof value === "number" && Number.isFinite(value);
    case "checkbox":
      return typeof value === "boolean";
    case "choice":
      // `choices` is the enumeration the mapper read, non-empty wherever this kind was
      // resolved; an absent one offers nothing, so nothing is displayable.
      return typeof value === "string" && (field.choices ?? []).includes(value);
    case "text":
    case "long-text":
    case "artifact-reference":
      return typeof value === "string";
  }
}

/**
 * Whether this member is drawn as a two-state box rather than as a three-state choice.
 *
 * THE ONE RULE ABOUT BOOLEANS, STATED ONCE. Five of the six controls have an empty state a
 * person reads as "not answered": a blank text box, a number box with nothing in it, a
 * select showing its unanswered option. A checkbox has none — unchecked is NO, and it says
 * so before anybody touches it. So the box is right exactly where the answer must hold a
 * value for this member and wrong everywhere else: an optional boolean drawn as a box has
 * no state that leaves the member out, so it reports NO where the person said nothing —
 * and a schema that tells those two apart (an optional member under `const: true`, which
 * accepts an absent one and refuses a false one) then had no answer the drawn form could
 * compose. An optional one is therefore drawn through the choice control — unanswered,
 * yes, no — which is a third state and not a seventh kind.
 *
 * `canBeUnanswered` and not `isRequired`, because a list ENTRY is neither: the position
 * exists the moment somebody adds it, so absence is not available to it whatever the
 * collection's own requiredness says.
 *
 * The three readers are the presence rule below (which is what the seed and every change
 * handler ask), the control dispatch (`SchemaFieldControl.tsx`), and the option table the
 * choice control is handed (`schema-field-control.ts`) — one fact, read where each needs it.
 */
export function fieldDrawsAsCheckbox(field: SchemaFieldDescriptor): boolean {
  return field.kind === "checkbox" && !field.canBeUnanswered;
}

/** The empty answer the two text controls display and write when a person clears one. */
const EMPTY_TEXT = "";

/** What a collection nobody has added to holds. Never written to; only ever replaced. */
const NO_ENTRIES: readonly unknown[] = [];

/**
 * What one control of a kind DISPLAYS while nobody has answered it, as a value.
 *
 * ONE TABLE, AND EVERY PLACE AN OPENING VALUE IS DECIDED READS IT. It is the value that
 * control's own `onChange` writes for its empty display — `""` from the two text boxes,
 * `false` from a box that cannot be blank, and NOTHING at all from the three whose empty
 * state is the member being absent: a number box shows nothing for a string, and a
 * select's unanswered option is deliberately worth no member value, so `""` at either is
 * a payload holding what no control on the screen is displaying.
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
    case "artifact-reference":
      return undefined;
  }
}

/**
 * What the answer holds at a MEMBER NOBODY HAS ANSWERED. The one rule, stated once.
 *
 * A MEMBER IS PRESENT IN THE ANSWER EXACTLY WHILE SOMETHING ON THE SCREEN IS DISPLAYING A
 * VALUE FOR IT, AND WHERE THE SURFACE HAS NO WAY TO DISPLAY ABSENCE, REQUIREDNESS DECIDES.
 * Five of the six controls have an empty state a person reads as "not answered" — a blank
 * text box, a number box with nothing in it, a select on its unanswered option — so a
 * member drawn through one of them is absent until somebody answers it and RETURNS to
 * absent when they clear it, whatever the enclosing level requires of it. A box, a
 * collection and a group have no such state: an unchecked box says NO before anybody
 * touches it, an empty list is indistinguishable from a list somebody emptied, and a group
 * has no control of its own at all. For those three the answer follows requiredness — a
 * required box opens at the `false` it is already showing, a required collection at the
 * `[]` its fieldset is already drawing, a required group at the `{}` its legend stands
 * over. An optional BOX is drawn as a choice instead, which is the paragraph below; an
 * optional CONTAINER follows `containerOpensAnswered` rather than its own contents —
 * absent until somebody answers it on its legend, and present from then on whatever it
 * holds, so a collection emptied to nothing is still `[]`.
 *
 * WHICH IS WHY AN OPTIONAL BOOLEAN IS DRAWN AS A CHOICE. That is the same rule read from
 * the other side: the third state gives the one control that cannot show absence a way to,
 * so the member follows its control rather than its requiredness like every other scalar.
 *
 * EVERY SITE READS THESE THREE AND NONE OF THEM DECIDES PRESENCE ON ITS OWN — the seed
 * (`schema-answer.ts`), each control's own change handler, the collection's remove
 * control, and the write path that prunes a group those two emptied.
 */
export function unansweredFieldValue(field: SchemaFieldDescriptor): unknown {
  return fieldDrawsAsCheckbox(field) ? emptyControlValue(field.kind) : undefined;
}

/**
 * WHETHER AN OPTIONAL CONTAINER OPENS ANSWERED, WHICH IS THE OTHER HALF OF THE RULE ABOVE.
 *
 * A group and a collection are the two members with no control of their own, so neither
 * has a display a person reads as "not answered": an unopened section and a section
 * holding nothing look alike, and an empty array and an array somebody emptied look alike.
 * ACTIVATION IS WHAT MAKES AN OPTIONAL CONTAINER PRESENT — one control on the container's
 * legend, drawn by `SchemaActivationControl.tsx`, held as a state in `schema-draft.ts` and
 * read by the projection — rather than a count of what is inside it.
 *
 * So every optional member opens UNANSWERED: a scalar, a choice and a boolean through the
 * empty state their own control displays, and a group and a collection through this. A
 * REQUIRED container has no such choice to offer — the schema demands the member, so it
 * opens answered at the `{}` or `[]` its legend already stands over. And a container the
 * schema declared a VALUE for opens answered too, which is the same rule read from the
 * other side rather than an exception to it: the schema has stated a value, so something
 * on the screen has to be displaying it.
 *
 * The seed (`schema-answer.ts`), the write path (`schema-draft-writes.ts`), the control,
 * the projection and, through the projected answer, the compiled validator all read this
 * one rule; none of them decides presence on its own.
 */
export function containerOpensAnswered(isRequired: boolean, hasDeclaredValue: boolean): boolean {
  return isRequired || hasDeclaredValue;
}

/** What the answer holds at a collection NOBODY IS ANSWERING, which a required one never is. */
export function unansweredListValue(list: SchemaListDescriptor): unknown {
  return list.isRequired ? NO_ENTRIES : undefined;
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
  /**
   * Whether the answer may leave this member out, which is what a control's unanswered
   * state means and what decides which control a boolean draws through.
   *
   * NOT THE NEGATION OF `isRequired`, and that is the whole reason it is carried rather
   * than derived: a list ENTRY has no requiredness of its own and can never be absent,
   * because the position exists from the moment somebody adds it.
   *
   * What this member is WORTH while nobody has answered it is `unansweredFieldValue`
   * above, which is the one rule the seed and every control's change handler read.
   */
  readonly canBeUnanswered: boolean;
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
 * The key one member path answers under inside its own level: the last segment.
 *
 * ONE IMPLEMENTATION FOR BOTH DEPTHS. A root entry's path is one segment long and a
 * group's leaf is two, and "which key does this answer under" is the same question at
 * either — asking it twice is how a nested reading and a root reading come to disagree.
 */
export function memberKeyOf(memberPath: SchemaMemberPath): string | undefined {
  const last = memberPath[memberPath.length - 1];
  return last === undefined ? undefined : String(last);
}

/**
 * The key one leaf answers under inside its group: the last segment of its own path.
 *
 * Derived from the path above rather than reading the descriptors a second time, so the
 * two readings cannot disagree about which of the two forms holds the path.
 */
export function leafKeyOf(leaf: SchemaLeafEntry): string | undefined {
  return memberKeyOf(leafPathOf(leaf));
}

/** One level of nesting, and the type is where "one level" is enforced. */
export interface SchemaGroupDescriptor {
  readonly memberPath: SchemaMemberPath;
  readonly label: string;
  readonly description: string | undefined;
  /**
   * Whether the enclosing level declares this whole group required.
   *
   * A GROUP IS A MEMBER LIKE ANY OTHER, and its legend says so the way a field's label and
   * a collection's legend do — through the one marker all three render. Read and then
   * dropped, a required group appeared optional beside controls that appeared required,
   * and where the group's own defaults seeded it there was not even a finding to notice
   * the omission by. Spelled `isRequired` for the reason it is on the other two
   * descriptors: one reading of the schema, one name for it.
   */
  readonly isRequired: boolean;
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
 * `constraint-undrawable` IS THE ONLY CAUSE ABOUT A MEMBER THE FORM NEVER MET. The others
 * name something the mapper read and could not draw; this one names a member some level's
 * own constraints can require and that level's `properties` never declared, so the drawn
 * form would report a finding nobody had a control to clear. It is ONE cause and not one
 * per depth: the root is the depth-0 instance of the same defect, and the member it names
 * carries its full path, which is what tells the two apart without a second name.
 */
export const SCHEMA_FALLBACK_CAUSES = [
  "root-not-an-object",
  "no-members",
  "member-out-of-set",
  "default-undrawable",
  "constraint-undrawable",
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
