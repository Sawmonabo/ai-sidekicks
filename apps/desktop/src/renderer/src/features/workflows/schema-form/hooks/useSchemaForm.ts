// The state one schema-derived form holds, and the one place its answer is composed. The drawn
// arm submits the projection of its draft (`schema-projection.ts`), so what is displayed is
// what is submitted; the raw arm submits the schema's accepted reading of the typed document
// (`json-schema-validator.ts`). Validation is the compiled schema's alone.

import { useCallback, useEffect, useMemo, useState } from "react";

import { leafDrawnAt, seedDraftFromPlan } from "../answer/schema-answer.js";
import {
  withGroupActivation,
  withLeafDrafted,
  withListActivation,
  withListEntryAppended,
  withListEntryDrafted,
  withListEntryRemoved,
} from "../answer/schema-draft-writes.js";
import {
  groupDraftAt,
  listDraftAt,
  scalarDraftAt,
  type SchemaFormDraft,
  type SchemaScalarDraft,
} from "../answer/schema-draft.js";
import { issuesForListEntry } from "../components/field-control-props.js";
import { memberKeyOf } from "../plan/schema-fields.js";
import { planSchemaForm } from "../plan/schema-form-plan.js";
import {
  choosePlanForValidator,
  CHECKER_UNAVAILABLE,
  COMPILING_VALIDATOR,
  VALIDATOR_COMPILE_KEY,
  type CompiledForSchema,
  type SchemaValidatorState,
} from "../schema-validator-state.js";
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
} from "../answer/schema-projection.js";
import { loadSchemaValidatorCompiler } from "../json-schema-validator-loader.js";
import { type SchemaMemberPath } from "../schema-member-path.js";
import { type SchemaValidationReport } from "../json-schema-validator.js";
import { useGenerationLatch } from "@renderer/hooks/useGenerationLatch.js";
import type { SchemaFormPlan } from "../plan/schema-fields.js";

/** What the raw editor's text currently is, as a value rather than a parse. */
export type RawAnswerReading =
  | { readonly status: "parsed"; readonly answer: unknown }
  | { readonly status: "unparsable"; readonly detail: string };

/** Everything a schema form component reads and everything it can ask for. */
export interface SchemaFormState {
  /** Controls, or the raw editor and why. */
  readonly plan: SchemaFormPlan;
  /**
   * The answer a submission would carry: the projection of the controls' draft on the drawn
   * arm, the schema's accepted reading of the raw document on the raw arm.
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
  /** Whether the schema could be checked against, and whether that answer has arrived. */
  readonly validator: SchemaValidatorState;
  /** The schema's verdict; nothing while the compiler arrives or the schema is uncheckable. */
  readonly report: SchemaValidationReport | undefined;
}

/** The empty raw document, which is what an unanswered JSON editor holds. */
const EMPTY_RAW_TEXT = "{}";

/** What a control with no descriptor behind it displays, which is nothing at all. */
const NOTHING_DISPLAYED: SchemaControlView = { value: undefined, unreadableText: "" };

/**
 * Hold one schema-derived form. The plan is memoized on the schema's identity and the
 * validator compiles once per identity per mount, so pass a stable value, not a fresh literal.
 */
export function useSchemaForm(inputSchema: unknown): SchemaFormState {
  const mappedPlan = useMemo(() => planSchemaForm(inputSchema), [inputSchema]);
  const compileRounds = useGenerationLatch();
  const [compiled, setCompiled] = useState<CompiledForSchema | undefined>(undefined);
  // Read against the schema in hand, not reset from an effect: an effect runs after the render
  // that moved the schema, which would show the previous verdict once over the new controls.
  const validator: SchemaValidatorState =
    compiled !== undefined && compiled.inputSchema === inputSchema
      ? compiled.validator
      : COMPILING_VALIDATOR;
  useEffect(() => {
    // A new round supersedes the last: the newest schema is the one on screen.
    const round = compileRounds.supersedeAndClaim(compileRounds, VALIDATOR_COMPILE_KEY);
    void loadSchemaValidatorCompiler().then(
      (compileSchemaValidator) => {
        round.settle(() => {
          setCompiled({ inputSchema, validator: compileSchemaValidator(inputSchema) });
        });
      },
      // The chunk did not fetch. Settled inside the round so a stale failure installs nothing,
      // and not retried: the loader's mount retry needs a body to remount, and throwing here
      // would take down a form whose raw editor still works. A moved schema re-runs the effect.
      () => {
        round.settle(() => {
          setCompiled({ inputSchema, validator: CHECKER_UNAVAILABLE });
        });
      },
    );
    // Released so a moved schema or an ended mount abandons an outstanding compile before it runs.
    return () => {
      round.release();
    };
  }, [compileRounds, inputSchema]);
  // Memoized through its inputs: both arms are values the memo and state above already hold.
  const plan = choosePlanForValidator(mappedPlan, validator);
  // Seeded once from what the plan says each control opens holding.
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

  // Derived on render: a stored report would go stale between the edit and its effect.
  const schemaReport =
    validator.status === "compiled" && (!isRaw || rawReading.status === "parsed")
      ? validator.check(composedAnswer)
      : undefined;
  const report = isRaw
    ? schemaReport
    : reportWithDraftIssues(schemaReport, draftIssuesIn(plan, draft));
  // The drawn arm sends what its controls hold; the raw arm has no controls, so it sends the
  // schema's reading of the document.
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
