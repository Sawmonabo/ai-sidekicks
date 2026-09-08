// The state one schema-derived form holds, and the single place its answer is composed.
//
// TWO INPUT MODES, ONE ANSWER. A schema the mapper drew controls for is answered by
// those controls; a schema it could not is answered as JSON in the editor beside it.
// Both compose the same value — the object a submission would carry — so the surface
// that renders the verdict, and the owner plan that eventually sends it, read ONE member
// rather than branching on which control a person happened to use.
//
// THE DRAWN ARM HOLDS A DRAFT TREE AND THE ANSWER IS A PROJECTION OF IT. What the
// controls are editing (`schema-draft.ts`) can say three things a JSON value cannot: a
// row nobody has answered, a section nobody has opened, and text a control could not read
// as a value. The answer is composed from that tree by one function
// (`schema-projection.ts`), so the value the compiled validator checks and the bytes a
// submission carries are the same bytes by construction — and a state the answer cannot
// hold never has to be smuggled into it as `undefined`, which JSON writes as `null`.
//
// THE VALIDATION IS THE SCHEMA'S AND NEVER THIS HOOK'S. Requiredness, ranges, enum
// membership: all of it is the compiled schema's answer, re-run over the whole projected
// answer on every edit. The one thing this hook adds is what the projection DROPPED — a
// drawn row with no value in it — because that is a finding about the draft the answer
// has no way to express, and a report that stayed clean over it would offer to send fewer
// entries than the person can see.
//
// ON THE DRAWN ARM, WHAT IS DISPLAYED IS WHAT IS SUBMITTED. Checking a value against a
// compiled schema READS it — a member declaring a `default` is supplied by the reader, so
// `{}` comes back valid and comes back as `{ approver: "ada" }`. Submitting that reading
// would put a member into the answer that no control on the screen accounts for, which is
// why the drawn arm submits the projection of its own draft and nothing else. The values
// the schema declares are not lost by that: they are SEEDED, per control, out of the
// descriptors the mapper drew (`schema-answer.ts`).
//
// THE RAW EDITOR'S DOCUMENT IS STILL THE PERSON'S, AND THAT ARM IS THE OTHER READING.
// Nothing seeds or rewrites the text, so there is no control there to make displayed and
// submitted agree: what is submitted from that arm is the schema's reading of what they
// typed, which adds the members the schema declares values for and — measured at the
// pinned reader, in `bridge/wire-shapes/json-schema-check.ts` — removes nothing they
// wrote. The two arms differ because their displays do, not because the rule does. They
// also never coexist: the arm is a property of the PLAN, and a plan that drew controls
// draws no editor, so a draft is never built from an answer and the projection runs one
// way only.
//
// A SCHEMA NOTHING COULD CHECK IS ANSWERED AS JSON, WHATEVER THE MAPPER DREW. A drawn
// control is a promise that the form will refuse a wrong value in it, and a schema the
// validator could not compile from cannot keep that promise — so the arm is decided HERE,
// where both readings are held, rather than at the component: deciding it there would show
// the editor while the composed answer still read controls nobody could see.
//
// NOTHING HERE POLLS, CACHES, OR SUBSCRIBES. The compiled validator is minted once per
// schema through `useMemo`; the draft is one tree; the answer and the report are derived
// on render from it. There is no effect in this module at all.

import { useCallback, useMemo, useState } from "react";

import { leafDrawnAt, seedDraftFromPlan } from "./schema-answer.js";
import {
  withGroupActivation,
  withLeafDrafted,
  withListActivation,
  withListEntryAppended,
  withListEntryDrafted,
  withListEntryRemoved,
} from "./schema-draft-writes.js";
import {
  groupDraftAt,
  listDraftAt,
  scalarDraftAt,
  type SchemaFormDraft,
  type SchemaScalarDraft,
} from "./schema-draft.js";
import { issuesForListEntry } from "./schema-field-control.js";
import { memberKeyOf, type SchemaFallback, type SchemaFormPlan } from "./schema-fields.js";
import { planSchemaForm } from "./schema-form-plan.js";
import {
  controlViewOf,
  draftIssuesIn,
  listEntryViewsOf,
  projectAnswer,
  projectedEntryPosition,
  reportWithDraftIssues,
  unansweredEntryMessage,
  type SchemaControlView,
  type SchemaListEntryView,
} from "./schema-projection.js";
import {
  compileSchemaValidator,
  type SchemaMemberPath,
  type SchemaValidationReport,
  type SchemaValidator,
} from "../../bridge/index.js";

/** What the raw editor's text currently is, as a value rather than a parse. */
export type RawAnswerReading =
  | { readonly status: "parsed"; readonly answer: unknown }
  | { readonly status: "unparsable"; readonly detail: string };

/** Everything a schema form surface reads and everything it can ask for. */
export interface SchemaFormState {
  /** Controls, or the raw editor and why. */
  readonly plan: SchemaFormPlan;
  /**
   * The answer a submission would carry, from whichever input mode this plan uses.
   *
   * The projection of what the drawn controls hold where the plan drew them, so nothing
   * is sent that nothing on the screen accounts for; the schema's accepted reading of the
   * raw document on the arm that has no controls, where the display is the text itself.
   */
  readonly answer: unknown;
  /** What one drawn control displays: its value, and any text it could not read. */
  readonly memberView: (memberPath: SchemaMemberPath) => SchemaControlView;
  /** Write what one drawn control is now displaying. */
  readonly setMemberDraft: (memberPath: SchemaMemberPath, draft: SchemaScalarDraft) => void;
  /** One collection's rows, always an array so a control need not ask whether it is one. */
  readonly listEntries: (memberPath: SchemaMemberPath) => readonly SchemaListEntryView[];
  /** Write what one row is now displaying, addressed by where that row is drawn. */
  readonly setListEntryDraft: (
    memberPath: SchemaMemberPath,
    index: number,
    draft: SchemaScalarDraft,
  ) => void;
  /** Add a row to the end of a collection. */
  readonly appendListEntry: (memberPath: SchemaMemberPath) => void;
  /** Drop one row, keeping the order and the identity of the rest. */
  readonly removeListEntry: (memberPath: SchemaMemberPath, index: number) => void;
  /** What is wrong with one drawn row: the draft's own finding, or the schema's. */
  readonly listEntryIssues: (memberPath: SchemaMemberPath, index: number) => readonly string[];
  /** Whether an optional collection has been answered. A required one always is. */
  readonly listIsActive: (memberPath: SchemaMemberPath) => boolean;
  /** Answer a collection or leave it unanswered, which is the control its legend offers. */
  readonly setListActive: (memberPath: SchemaMemberPath, isActive: boolean) => void;
  /** Whether an optional section has been opened. A required one is always open. */
  readonly groupIsActive: (memberPath: SchemaMemberPath) => boolean;
  /** Open a section or leave it unanswered, which is the control its legend offers. */
  readonly setGroupActive: (memberPath: SchemaMemberPath, isActive: boolean) => void;
  /** The raw editor's text, which is the input on the raw arm and unread on the other. */
  readonly rawText: string;
  readonly setRawText: (text: string) => void;
  /** Whether the raw text is JSON at all, and what it parsed to. */
  readonly rawReading: RawAnswerReading;
  /** Whether the schema itself could be checked against, and the reason where not. */
  readonly validator: SchemaValidator;
  /** The schema's verdict on the answer, or nothing where the schema is uncheckable. */
  readonly report: SchemaValidationReport | undefined;
}

/** The empty raw document, which is what an unanswered JSON editor holds. */
const EMPTY_RAW_TEXT = "{}";

/** What a control with no descriptor behind it displays, which is nothing at all. */
const NOTHING_DISPLAYED: SchemaControlView = { value: undefined, unreadableText: "" };

/** Parse the raw editor's text, reporting a syntax failure as a value. */
function readRawText(rawText: string): RawAnswerReading {
  try {
    return { status: "parsed", answer: JSON.parse(rawText) as unknown };
  } catch (error) {
    return {
      status: "unparsable",
      detail: error instanceof SyntaxError ? error.message : "This is not JSON yet.",
    };
  }
}

/**
 * Why a schema whose members are all drawable is answered as JSON anyway.
 *
 * One sentence, and deliberately not the reader's: the raw editor already renders the
 * compiler's own detail beneath the document, so a reason repeating it would say one
 * thing twice. This one says what that sentence does not — which arm this is and why the
 * controls are absent rather than drawn and unchecked.
 *
 * Held once so the arm below returns a stable value: an object literal composed per
 * render would hand the surface a new plan on every keystroke.
 */
const UNCHECKABLE_SCHEMA_FALLBACK: SchemaFallback = {
  cause: "schema-uncheckable",
  memberPath: [],
  detail:
    "This phase's schema could not be compiled here, so the answer is given as JSON rather than in controls that could check nothing you type.",
};

/** The arm this form opens on: the mapper's reading, unless nothing could check it. */
function armFor(plan: SchemaFormPlan, validator: SchemaValidator): SchemaFormPlan {
  if (plan.shape === "raw" || validator.status === "compiled") {
    return plan;
  }
  return { shape: "raw", fallback: UNCHECKABLE_SCHEMA_FALLBACK };
}

/**
 * Hold one schema-derived form.
 *
 * The schema is read ONCE per identity: both the plan and the compiled validator are
 * memoised on it, so a re-render from a keystroke re-walks nothing and re-compiles
 * nothing. A caller handing a fresh object literal every render would defeat that, which
 * is why every caller in this tree reads the schema off a value the wire delivered.
 */
export function useSchemaForm(inputSchema: unknown): SchemaFormState {
  const mappedPlan = useMemo(() => planSchemaForm(inputSchema), [inputSchema]);
  const validator = useMemo(() => compileSchemaValidator(inputSchema), [inputSchema]);
  // Memoised through its inputs rather than on its own: both arms this returns are values
  // the two memos above already hold — the mapper's plan itself, or the one held fallback
  // — so the result is stable across a re-render without a third cache to keep in step.
  const plan = armFor(mappedPlan, validator);
  // Seeded per control from what the plan says each one opens holding, and read once: the
  // header's reason, and why this is an initialiser rather than anything that re-runs.
  const [draft, setDraft] = useState<SchemaFormDraft>(() => seedDraftFromPlan(plan));
  const [rawText, setRawText] = useState<string>(EMPTY_RAW_TEXT);

  const rawReading = useMemo(() => readRawText(rawText), [rawText]);
  const isRaw = plan.shape === "raw";
  const projectedAnswer = projectAnswer(plan, draft);
  const composedAnswer = isRaw
    ? rawReading.status === "parsed"
      ? rawReading.answer
      : undefined
    : projectedAnswer;

  const setMemberDraft = useCallback(
    (memberPath: SchemaMemberPath, memberDraft: SchemaScalarDraft) => {
      setDraft((current) => withLeafDrafted(plan, current, memberPath, memberDraft));
    },
    [plan],
  );

  const setListEntryDraft = useCallback(
    (memberPath: SchemaMemberPath, index: number, entryDraft: SchemaScalarDraft) => {
      setDraft((current) => withListEntryDrafted(plan, current, memberPath, index, entryDraft));
    },
    [plan],
  );

  const appendListEntry = useCallback(
    (memberPath: SchemaMemberPath) => {
      setDraft((current) => withListEntryAppended(plan, current, memberPath));
    },
    [plan],
  );

  const removeListEntry = useCallback(
    (memberPath: SchemaMemberPath, index: number) => {
      setDraft((current) => withListEntryRemoved(plan, current, memberPath, index));
    },
    [plan],
  );

  const setListActive = useCallback(
    (memberPath: SchemaMemberPath, isActive: boolean) => {
      setDraft((current) => withListActivation(plan, current, memberPath, isActive));
    },
    [plan],
  );

  const setGroupActive = useCallback(
    (memberPath: SchemaMemberPath, isActive: boolean) => {
      setDraft((current) => withGroupActivation(plan, current, memberPath, isActive));
    },
    [plan],
  );

  // Derived on render rather than held, because it is a pure function of values the hook
  // already has: a stored report is a second copy of the answer's verdict that goes stale
  // between the edit and the effect that would refresh it. The draft's own findings are
  // folded in here, where both the draft and the schema's reading are in hand.
  const schemaReport =
    validator.status === "compiled" && (!isRaw || rawReading.status === "parsed")
      ? validator.check(composedAnswer)
      : undefined;
  const report = isRaw
    ? schemaReport
    : reportWithDraftIssues(schemaReport, draftIssuesIn(plan, draft));
  // The header's rule, in one expression. The drawn arm sends what its controls hold, so
  // nothing reaches the wire that no control accounts for; the raw arm has no controls to
  // agree with, so it sends the schema's reading of the document a person wrote.
  const answer = isRaw && report?.status === "valid" ? report.acceptedValue : composedAnswer;

  return {
    plan,
    answer,
    memberView: (memberPath) => {
      const leaf = leafDrawnAt(plan, memberPath);
      return leaf?.form === "field"
        ? controlViewOf(leaf.field, scalarDraftAt(draft, memberPath))
        : NOTHING_DISPLAYED;
    },
    setMemberDraft,
    listEntries: (memberPath) => {
      const leaf = leafDrawnAt(plan, memberPath);
      return leaf?.form === "list"
        ? listEntryViewsOf(leaf.list.item, listDraftAt(draft, memberPath))
        : [];
    },
    setListEntryDraft,
    appendListEntry,
    removeListEntry,
    listEntryIssues: (memberPath, index) => {
      const position = projectedEntryPosition(listDraftAt(draft, memberPath), index);
      return position === undefined
        ? [unansweredEntryMessage(index)]
        : issuesForListEntry(report, memberPath, position);
    },
    listIsActive: (memberPath) => listDraftAt(draft, memberPath)?.state === "active",
    setListActive,
    groupIsActive: (memberPath) => {
      const groupKey = memberKeyOf(memberPath);
      return groupKey !== undefined && groupDraftAt(draft, groupKey)?.state === "active";
    },
    setGroupActive,
    rawText,
    setRawText,
    rawReading,
    validator,
    report,
  };
}
