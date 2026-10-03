// The answer is a projection of the draft (`schema-draft.ts`): the one place a draft becomes the
// value the validator checks and a submission sends, so the two cannot differ.
// A member is present while the screen shows a value for it; `schema-fields.ts` decides the
// rest. An inactive container is omitted; an active one is present, `[]` included.
// An unanswered list entry is dropped from the array and reported as an issue (`undefined` in a
// JSON array would serialize as `null`), so finding positions are translated to projected ones.

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
import { NOTHING_ANSWERED, type SchemaFormAnswerValue } from "./schema-answer-value.js";
import type { SchemaValidationIssue, SchemaValidationReport } from "../json-schema-validator.js";

/** What one control is handed to display: its value, and any text it could not read. */
export interface SchemaControlView {
  /** Whatever the control shows. Not yet proved to be anything the control can render. */
  readonly value: unknown;
  /** The text this control is showing that it could not read as a value. */
  readonly unreadableText: string;
}

/** One row of a drawn collection: what it displays, under the identity it keeps. */
export interface SchemaListEntryView extends SchemaControlView {
  /** Stable across removals so a React subtree follows its own entry. */
  readonly entryId: string;
  /** Whether this row has a value at all, which is what the answer omits it for. */
  readonly isAnswered: boolean;
}

/** The message a row with no value carries, so a dropped entry is never silent. */
export function unansweredEntryMessage(index: number): string {
  return `Entry ${String(index + 1)} has no value yet.`;
}

/**
 * The answer this draft composes: what the validator checks and what a submission sends.
 * Walked over the plan, so a member no control draws never reaches the answer.
 */
export function projectAnswer(plan: SchemaFormPlan, draft: SchemaFormDraft): SchemaFormAnswerValue {
  if (plan.shape !== "fields") {
    return NOTHING_ANSWERED;
  }
  let answer: SchemaFormAnswerValue = NOTHING_ANSWERED;
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
    let members: SchemaFormAnswerValue = NOTHING_ANSWERED;
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
 * Where one drawn row sits in the projected array, or nothing where it was dropped: the
 * count of answered rows before it, which is the position the validator addressed.
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

/**
 * Everything wrong with the draft that the answer cannot carry to the validator: a row on
 * the screen that contributes no entry. Anything the answer can express is the schema's call.
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
 * The schema's verdict with the draft's own findings appended, invalid as soon as there is
 * one: a `valid` report over an unanswered row would offer to send fewer entries than shown.
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
 * What one collection contributes: its answered entries once active (`[]` included), else
 * what an unanswered one is worth. The active state decides, never the row count.
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
  level: SchemaFormAnswerValue,
  leaf: SchemaLeafEntry,
  node: SchemaLeafDraft | undefined,
): SchemaFormAnswerValue {
  const key = leafKeyOf(leaf);
  const value = projectedLeaf(leaf, node);
  return key === undefined || value === undefined ? level : { ...level, [key]: value };
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
