// What every field control is handed, declared once so no control imports from a sibling.
// A control owns its value only; label, description and findings are the field chrome's.
// `value` is `unknown`: nothing has proved what sits at a member, so each control narrows what
// it can use. A control reports a draft node (`schema-draft.ts`), not a bare value, so the
// text it could not read travels with its member rather than living in component state.

import type { SchemaScalarDraft } from "../answer/schema-draft.js";
import type { SchemaFieldDescriptor } from "../plan/schema-fields.js";
import { isSameMemberPath, type SchemaMemberPath } from "../schema-member-path.js";
import { type SchemaValidationReport } from "../json-schema-validator.js";

/** One control's props: its field, what it holds, and how it reports a change. */
export interface SchemaFieldControlProps {
  readonly field: SchemaFieldDescriptor;
  /** Whatever the answer currently holds at this member. Not yet proved to be anything. */
  readonly value: unknown;
  /** The text this control shows that it could not read as a value; empty for most. */
  readonly unreadableText: string;
  /** Report what this control is now displaying. The hook owns where the node lands. */
  readonly onChange: (draft: SchemaScalarDraft) => void;
  /** The id the chrome's label points at, so a click on the label reaches the control. */
  readonly controlId: string;
  /** The description element's id, where this field carries one. */
  readonly describedById: string | undefined;
}

/** One thing the choice control offers: what a person reads, and what it is worth. */
export interface SchemaChoiceOption {
  /** The text on the option. */
  readonly optionLabel: string;
  /** What the answer holds when it is picked. */
  readonly memberValue: unknown;
}

/** The value read as text, which is what the two text controls bind to. */
export function textValueOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The two options a boolean member is answered through, named for a person answering yes/no. */
const BOOLEAN_CHOICE_OPTIONS: readonly SchemaChoiceOption[] = [
  { optionLabel: "Yes", memberValue: true },
  { optionLabel: "No", memberValue: false },
];

/**
 * What the choice control offers for one field: the boolean pair for a checkbox-kind field
 * `fieldDrawsAsCheckbox` does not draw as a box, else the enumeration it declared (none if none).
 */
export function choiceOptionsFor(field: SchemaFieldDescriptor): readonly SchemaChoiceOption[] {
  if (field.kind === "checkbox") {
    return BOOLEAN_CHOICE_OPTIONS;
  }
  return (field.choices ?? []).map((member) => ({ optionLabel: member, memberValue: member }));
}

/** The whole answer as a path; the validator spells an issue about it the same way. */
export const ROOT_MEMBER_PATH: SchemaMemberPath = [];

/**
 * What the schema said about exactly one member. Matched segment by segment, never on a
 * joined string (`["items", 0]` and `["items.0"]` differ), and never the subtree under it,
 * so a group's fieldset does not repeat its children's findings.
 */
export function issuesForMember(
  report: SchemaValidationReport | undefined,
  memberPath: SchemaMemberPath,
): readonly string[] {
  return (report?.issues ?? [])
    .filter((issue) => isSameMemberPath(issue.memberPath, memberPath))
    .map((issue) => issue.message);
}

/**
 * What the schema said about one entry of a list. The validator addresses it by the array's
 * path plus the numeric position, which a lookup for the array's path alone would miss.
 */
export function issuesForListEntry(
  report: SchemaValidationReport | undefined,
  memberPath: SchemaMemberPath,
  index: number,
): readonly string[] {
  return issuesForMember(report, [...memberPath, index]);
}

/**
 * The one `aria-describedby` a control carries, composed from the ids it might have; a
 * control with none carries no attribute.
 */
export function describedByOf(ids: readonly (string | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => id !== undefined);
  return present.length === 0 ? undefined : present.join(" ");
}
