// The answer, which is a PROJECTION of the draft and never a second copy of it.
//
// ONE FUNCTION COMPOSES WHAT IS CHECKED AND WHAT IS SENT, so the value the compiled
// validator reads and the bytes a submission carries are the same bytes by construction
// rather than by two writers that agree today. `schema-draft.ts` states the tree; this is
// the only module that turns one into an answer.
//
// A MEMBER IS PRESENT EXACTLY WHILE SOMETHING ON THE SCREEN IS DISPLAYING A VALUE FOR IT,
// AND WHERE THE SURFACE CANNOT DISPLAY ABSENCE, REQUIREDNESS DECIDES. That rule lives in
// `schema-fields.ts` and is read here rather than restated: an answered node contributes
// what it holds, and an unanswered one contributes `unansweredFieldValue` — which is a
// value for the one control that cannot show absence and nothing at all for the other five.
//
// AN INACTIVE CONTAINER IS OMITTED WHOLE, AND AN ACTIVE ONE IS PRESENT WHATEVER IT HOLDS.
// Nobody has said they are answering that section or that collection, so there is no
// object and no array for the answer to carry — which is the state a presence-sensitive
// schema needs and the one a seeded `{ settings: { enabled: false } }` could never reach.
// Answered, a collection with no rows contributes `[]` rather than falling back through
// `unansweredListValue`: an optional array under `maxItems: 0` at a root demanding one
// member has exactly one valid answer, and reading presence off the row count could never
// compose it.
//
// AN UNANSWERED LIST ENTRY IS OMITTED FROM THE PROJECTED ARRAY AND REPORTED AS AN ISSUE.
// Omitted alone, a press would send fewer entries than the person can see; carried, the
// only representation available inside a JSON array is `undefined`, which serializes to
// `null` and makes the checked value and the sent value differ. So the entry leaves the
// array and the form says so: `draftIssuesIn` names it, the report the surface renders
// carries that sentence, and the answer is invalid until the entry is answered or removed.
//
// AND THE POSITIONS THE VALIDATOR ADDRESSES ARE THE PROJECTED ONES. An entry the
// projection dropped shifts every entry after it, so a finding the schema reports at
// `["reviewers", 0]` can belong to the second row on the screen. `projectedEntryPosition`
// is that translation, made once here, so no surface matches a row against a position it
// computed itself.

import {
  unansweredFieldValue,
  unansweredListValue,
  type SchemaFieldDescriptor,
  type SchemaFormPlan,
  type SchemaLeafEntry,
  leafKeyOf,
  leafPathOf,
  memberKeyOf,
} from "../plan/schema-fields.js";
import type {
  SchemaFormDraft,
  SchemaLeafDraft,
  SchemaListDraft,
  SchemaListEntryDraft,
  SchemaScalarDraft,
} from "./schema-draft.js";
import { leafDraftAt, listEntriesOf, unreadableTextOf } from "./schema-draft.js";
import { NOTHING_ANSWERED, type SchemaFormAnswer } from "./schema-answer-shape.js";
import type { SchemaValidationIssue, SchemaValidationReport } from "../../../bridge/index.js";

/** What one control is handed to display: its value, and any text it could not read. */
export interface SchemaControlView {
  /** Whatever the control shows. Not yet proved to be anything the control can render. */
  readonly value: unknown;
  /** The text this control is showing that it could not read as a value. */
  readonly unreadableText: string;
}

/** One row of a drawn collection: what it displays, under the identity it keeps. */
export interface SchemaListEntryView extends SchemaControlView {
  /** Minted when the entry was added, so a React subtree follows its own entry. */
  readonly entryId: string;
  /** Whether this row has a value at all, which is what the answer omits it for. */
  readonly isAnswered: boolean;
}

/** The sentence a row with nothing in it carries, so a dropped entry is never silent. */
export function unansweredEntryMessage(index: number): string {
  return `Entry ${String(index + 1)} has no value yet.`;
}

/** What one scalar node contributes, or `undefined` where it contributes no member. */
function projectedScalar(field: SchemaFieldDescriptor, node: SchemaLeafDraft | undefined): unknown {
  if (node?.form === "scalar" && node.state === "answered") {
    return node.value;
  }
  return unansweredFieldValue(field);
}

/** Every answered entry of one collection, in the order the rows are drawn. */
function answeredEntryValues(entries: readonly SchemaListEntryDraft[]): readonly unknown[] {
  return entries.flatMap((held) => (held.entry.state === "answered" ? [held.entry.value] : []));
}

/**
 * What one collection contributes: its answered entries, or what an unanswered one is worth.
 *
 * The LATCH decides, never the row count. An answered collection contributes an array
 * however few rows survive the projection — `[]` included — and one nobody is answering
 * contributes `unansweredListValue`, which for the required case that can never be
 * unanswered is still the `[]` its fieldset stands over.
 */
function projectedList(leaf: SchemaLeafEntry, node: SchemaLeafDraft | undefined): unknown {
  if (leaf.form !== "list") {
    return undefined;
  }
  return node?.form === "list" && node.state === "active"
    ? answeredEntryValues(node.entries)
    : unansweredListValue(leaf.list);
}

/** What one leaf contributes to the answer, or `undefined` where it contributes nothing. */
function projectedLeaf(leaf: SchemaLeafEntry, node: SchemaLeafDraft | undefined): unknown {
  return leaf.form === "list" ? projectedList(leaf, node) : projectedScalar(leaf.field, node);
}

/** One leaf folded into the level it answers under, or that level untouched where absent. */
function withProjectedLeaf(
  level: SchemaFormAnswer,
  leaf: SchemaLeafEntry,
  node: SchemaLeafDraft | undefined,
): SchemaFormAnswer {
  const key = leafKeyOf(leaf);
  const value = projectedLeaf(leaf, node);
  return key === undefined || value === undefined ? level : { ...level, [key]: value };
}

/**
 * The answer this draft composes: what the validator checks, and what a submission sends.
 *
 * Walked over the PLAN rather than over the draft, so a member no control draws can never
 * reach the answer however the draft came to hold a node for it, and the order of the
 * members is the order the form drew them.
 */
export function projectAnswer(plan: SchemaFormPlan, draft: SchemaFormDraft): SchemaFormAnswer {
  if (plan.shape !== "fields") {
    return NOTHING_ANSWERED;
  }
  let answer: SchemaFormAnswer = NOTHING_ANSWERED;
  for (const entry of plan.entries) {
    if (entry.form !== "group") {
      answer = withProjectedLeaf(answer, entry, leafDraftAt(draft, leafPathOf(entry)));
      continue;
    }
    const groupKey = memberKeyOf(entry.group.memberPath);
    const held = groupKey === undefined ? undefined : draft[groupKey];
    if (groupKey === undefined || held?.form !== "group" || held.state !== "active") {
      continue;
    }
    let members: SchemaFormAnswer = NOTHING_ANSWERED;
    for (const leaf of entry.group.entries) {
      const key = leafKeyOf(leaf);
      members = withProjectedLeaf(members, leaf, key === undefined ? undefined : held.members[key]);
    }
    answer = { ...answer, [groupKey]: members };
  }
  return answer;
}

/** What one control displays for whatever the draft holds at its member. */
export function controlViewOf(
  field: SchemaFieldDescriptor,
  node: SchemaScalarDraft | undefined,
): SchemaControlView {
  return {
    value: node?.state === "answered" ? node.value : unansweredFieldValue(field),
    unreadableText: unreadableTextOf(node),
  };
}

/** Every row of one collection, as the values and identities its controls are handed. */
export function listEntryViewsOf(
  item: SchemaFieldDescriptor,
  list: SchemaListDraft | undefined,
): readonly SchemaListEntryView[] {
  return listEntriesOf(list).map((held) => ({
    entryId: held.entryId,
    isAnswered: held.entry.state === "answered",
    ...controlViewOf(item, held.entry),
  }));
}

/**
 * Where one drawn row sits in the projected array, or nothing where it was dropped.
 *
 * Counted rather than looked up, because the projection is a filter and the count of
 * answered rows before this one IS the position the validator addressed it at.
 */
export function projectedEntryPosition(
  list: SchemaListDraft | undefined,
  index: number,
): number | undefined {
  const entries = listEntriesOf(list);
  const held = entries[index];
  if (held === undefined || held.entry.state !== "answered") {
    return undefined;
  }
  return entries.slice(0, index).filter((before) => before.entry.state === "answered").length;
}

/** One issue per row the projection dropped, addressed at the row a person is looking at. */
function listDraftIssues(leaf: SchemaLeafEntry, node: SchemaLeafDraft | undefined) {
  if (leaf.form !== "list" || node?.form !== "list") {
    return [];
  }
  return listEntriesOf(node).flatMap((held, index) =>
    held.entry.state === "answered"
      ? []
      : [{ memberPath: [...leaf.list.memberPath, index], message: unansweredEntryMessage(index) }],
  );
}

/**
 * Everything wrong with the DRAFT that the answer cannot carry to the validator.
 *
 * One class today, and it is the class the projection creates: a row on the screen that
 * contributes no entry. Anything the answer can express is the schema's to judge, and a
 * second opinion here would be this form re-deciding a question the validator settles.
 */
export function draftIssuesIn(
  plan: SchemaFormPlan,
  draft: SchemaFormDraft,
): readonly SchemaValidationIssue[] {
  if (plan.shape !== "fields") {
    return [];
  }
  return plan.entries.flatMap((entry) =>
    entry.form === "group"
      ? entry.group.entries.flatMap((leaf) =>
          listDraftIssues(leaf, leafDraftAt(draft, leafPathOf(leaf))),
        )
      : listDraftIssues(entry, leafDraftAt(draft, leafPathOf(entry))),
  );
}

/**
 * The schema's verdict with the draft's own findings folded into it.
 *
 * Invalid the moment there is one, because a form that reported `valid` over a row nobody
 * has answered would be offering to send fewer entries than the person can see. The
 * schema's sentences are kept whole and the draft's are appended, so nothing is ranked,
 * paraphrased, or hidden.
 */
export function reportWithDraftIssues(
  report: SchemaValidationReport | undefined,
  draftIssues: readonly SchemaValidationIssue[],
): SchemaValidationReport | undefined {
  if (report === undefined || draftIssues.length === 0) {
    return report;
  }
  return { status: "invalid", issues: [...report.issues, ...draftIssues] };
}
