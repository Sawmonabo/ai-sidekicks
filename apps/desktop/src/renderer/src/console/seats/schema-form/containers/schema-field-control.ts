// What every one of the six controls is handed, declared once.
//
// A LEAF BECAUSE SIX MODULES READ IT and the chrome that renders them reads it too.
// Declared inside any one of the six it would make the other five import from a sibling
// control, which is how one field's module becomes the home of the shape all of them
// share — and the day a member moved, five files would follow it by hand.
//
// THE CONTROL OWNS THE VALUE AND NOTHING ELSE. The label, the description, the required
// mark and the schema's verdict are the field chrome's, one module up: a control that
// drew its own label would draw it six different ways, and a control that read the
// report would be six readers of one verdict.
//
// `value` IS `unknown` ON PURPOSE. The answer is a JSON value composed from a schema the
// wire delivered, so nothing has proved what sits at a member yet — a number control
// handed a string by a restored draft has to render that honestly rather than crash. Each
// control narrows what it can use and falls back to its own empty state for the rest.
//
// AND A CONTROL REPORTS A DRAFT NODE RATHER THAN A VALUE, which is what lets it say the
// one thing a value cannot: that it is displaying text it could not read. The node is
// `schema-draft.ts`'s (`answeredScalar` / `unansweredScalar` / `UNANSWERED_SCALAR`), so
// what an unanswered control is WORTH is settled once by the projection rather than six
// times here — and the text it could not read travels with the member it belongs to
// instead of living in component state that a list re-key would move to another row.

import type { SchemaScalarDraft } from "../answer/schema-draft.js";
import type { SchemaFieldDescriptor } from "../plan/schema-fields.js";
import {
  isSameMemberPath,
  type SchemaMemberPath,
  type SchemaValidationReport,
} from "../../../bridge/index.js";

/** One control's whole world: what it is, what it holds, and how it reports a change. */
export interface SchemaFieldControlProps {
  readonly field: SchemaFieldDescriptor;
  /** Whatever the answer currently holds at this member. Not yet proved to be anything. */
  readonly value: unknown;
  /**
   * The text this control is showing that it could not read as a value.
   *
   * Empty for the five controls that read everything they can be shown — they neither
   * read it nor write it, and a member every control had to opt out of would be a member
   * five of them carried a reason to ignore.
   */
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

/** The value read as text, which is what five of the six controls bind to. */
export function textValueOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The two options a boolean member is answered through, beside its unanswered one.
 *
 * NAMED RATHER THAN SPELLED AS THE WIRE DOES. Every other option this control offers IS
 * its member — an enumeration's members are the strings the engine stores, which is why
 * they are set in the wire signature — and a boolean has no string spelling a person
 * answers a question with. So these two name the answer while carrying the value, which is
 * exactly the split the type above exists for.
 */
const BOOLEAN_CHOICE_OPTIONS: readonly SchemaChoiceOption[] = [
  { optionLabel: "Yes", memberValue: true },
  { optionLabel: "No", memberValue: false },
];

/**
 * What the choice control offers for one field, whichever of the two it is drawing.
 *
 * TWO KINDS REACH THIS CONTROL. An enumerated string is the obvious one; the other is a
 * boolean the answer may leave out, which a two-state box cannot represent —
 * `fieldDrawsAsCheckbox` is where that rule is stated and this is the table it decides
 * between. Composed here beside `SchemaFieldControlProps` rather than inside the control,
 * because it is what the control is HANDED and both halves of the lookup — which options
 * exist, and what a picked one is worth — have to be one reading.
 *
 * A field of any other kind never mounts this control; asked anyway, it offers whatever
 * enumeration it declared, which for a member that declared none is nothing at all.
 */
export function choiceOptionsFor(field: SchemaFieldDescriptor): readonly SchemaChoiceOption[] {
  if (field.kind === "checkbox") {
    return BOOLEAN_CHOICE_OPTIONS;
  }
  return (field.choices ?? []).map((member) => ({ optionLabel: member, memberValue: member }));
}

/**
 * The whole answer, as the path that addresses it.
 *
 * Named rather than written as an empty literal at the one surface that asks for it,
 * because `[]` at a call site reads as "no path yet" and this is the opposite — it is the
 * member a root constraint's finding is about. The validator spells it the same way
 * (`SchemaValidationIssue.memberPath` is empty for an issue about the whole answer), so
 * this is that spelling given a name and not a second convention.
 */
export const ROOT_MEMBER_PATH: SchemaMemberPath = [];

/**
 * What the schema said about one member, addressed the way the mapper addresses it.
 *
 * A FUNCTION RATHER THAN A MAP BUILT ONCE, because the report is already a small list
 * and the alternative is a second index of it held beside the answer it describes — one
 * more thing to rebuild on every keystroke and one more thing to get out of step. A form
 * with a hundred controls and three issues walks three entries per control.
 *
 * SEGMENT BY SEGMENT, AND NEVER ON A JOINED STRING. `["items", 0]` and `["items.0"]` are
 * one string under a dotted join and two different members in the schema, so a match on
 * the join draws an array entry's finding under a property that merely reads like one.
 * The comparison itself is the bridge's own — `isSameMemberPath`, declared in the module
 * that declares the path type both sides carry — so there is no second reading of what
 * "the same member" is.
 *
 * EXACTLY THAT MEMBER, AND NEVER THE SUBTREE UNDER IT. `isSameMemberPath` compares the
 * lengths before the segments, so `["scope"]` matches a finding about the group and not
 * one about `["scope", "note"]` inside it — which is what lets every surface ask about
 * its own member and lets the form root ask about `ROOT_MEMBER_PATH` and receive only
 * what the schema said about the whole answer. A prefix reading would draw every finding
 * on the form a second time at the root, and a group's fieldset would repeat each of its
 * children's; the surfaces below rely on this rule rather than filtering afterwards.
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
 * What the schema said about ONE ENTRY of a list, addressed by the position it sits at.
 *
 * The validator addresses an array member by the array's path followed by the position —
 * `["reviewers", 0]` — so an entry's own findings are invisible to a lookup asking for
 * `["reviewers"]` alone, and a form that made only that lookup drew a control the schema
 * had a complaint about and rendered the complaint nowhere.
 *
 * The position is appended AS A NUMBER, which is what the reader reports and what keeps
 * this lookup off a property whose name is the digit. Composed here rather than at the
 * surface, and by appending to the same reader above, so one member path has one lookup.
 */
export function issuesForListEntry(
  report: SchemaValidationReport | undefined,
  memberPath: SchemaMemberPath,
  index: number,
): readonly string[] {
  return issuesForMember(report, [...memberPath, index]);
}

/**
 * The one `aria-describedby` a control carries, composed from the ids it might have.
 *
 * The platform takes a space-separated id list in this attribute and drops an id that
 * points at no element, which is why a caller passes the ids it MIGHT have rather than
 * the ones it does: a control with neither a description nor a finding carries no
 * attribute at all rather than one naming an element that was never rendered.
 *
 * A function because two modules compose it — a scalar field's chrome and one list
 * entry's — and a second copy would drift the first time either grew a third describing
 * element, in the direction where the drift is silent.
 */
export function describedByOf(ids: readonly (string | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => id !== undefined);
  return present.length === 0 ? undefined : present.join(" ");
}
