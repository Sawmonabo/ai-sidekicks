// The state one schema-derived form holds, and the single place its answer is composed.
//
// TWO INPUT MODES, ONE ANSWER. A schema the mapper drew controls for is answered by
// those controls; a schema it could not is answered as JSON in the editor beside it.
// Both compose the same value — the object a submission would carry — so the surface
// that renders the verdict, and the owner plan that eventually sends it, read ONE member
// rather than branching on which control a person happened to use.
//
// THE VALIDATION IS THE SCHEMA'S AND NEVER THIS HOOK'S. Requiredness, ranges, enum
// membership: all of it is the compiled schema's answer, re-run over the whole answer
// on every edit. A hook that re-derived requiredness from the descriptors would be a
// second authority on a question the schema already settles, and the two would disagree
// the first time a schema used a keyword the mapper does not read.
//
// ON THE DRAWN ARM, WHAT IS DISPLAYED IS WHAT IS SUBMITTED. Checking a value against a
// compiled schema READS it — a member declaring a `default` is supplied by the reader, so
// `{}` comes back valid and comes back as `{ approver: "ada" }`. Submitting that reading
// would put a member into the answer that no control on the screen accounts for, which is
// why the drawn arm submits the value its controls composed and nothing else. The values
// the schema declares are not lost by that: they are SEEDED, per control, out of the
// descriptors the mapper drew (`schema-answer.ts`), so a declared value reaches the
// submission by being visible in the control it belongs to rather than by being added to
// the bytes on the way out.
//
// THE RAW EDITOR'S DOCUMENT IS STILL THE PERSON'S, AND THAT ARM IS THE OTHER READING.
// Nothing seeds or rewrites the text, so there is no control there to make displayed and
// submitted agree: what is submitted from that arm is the schema's reading of what they
// typed, which adds the members the schema declares values for and — measured at the
// pinned reader, in `bridge/wire-shapes/json-schema-check.ts` — removes nothing they
// wrote. The two arms differ because their displays do, not because the rule does.
//
// A LIST'S ITEMS ARE ADDRESSED BY INDEX AND HELD IN ORDER. Removing the middle entry of
// a three-item list must not renumber the answer under the person editing it, so the
// mutation rebuilds the array rather than writing a hole into it.
//
// NOTHING HERE POLLS, CACHES, OR SUBSCRIBES. The compiled validator is minted once per
// schema through `useMemo`; the answer is one object; the report is derived on render
// from the two of them. There is no effect in this module at all.

import { useCallback, useMemo, useState } from "react";

import {
  listAt,
  memberAt,
  newListEntryFor,
  seedAnswerFromPlan,
  withMemberAt,
  type SchemaFormAnswer,
} from "./schema-answer.js";
import { planSchemaForm, type SchemaFormPlan } from "./schema-fields.js";
import {
  compileSchemaValidator,
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
   * Exactly what the drawn controls hold where the plan drew them, so nothing is sent
   * that nothing on the screen accounts for; the schema's accepted reading of the raw
   * document on the arm that has no controls, where the display is the text itself.
   */
  readonly answer: unknown;
  /** The value one drawn control is bound to. `undefined` where nothing was typed. */
  readonly memberValue: (memberPath: readonly string[]) => unknown;
  /** Write one drawn control's value. */
  readonly setMemberValue: (memberPath: readonly string[], value: unknown) => void;
  /** One list's entries, always an array so a control need not ask whether it is one. */
  readonly listItems: (memberPath: readonly string[]) => readonly unknown[];
  /** Write one entry of a list. */
  readonly setListItem: (memberPath: readonly string[], index: number, value: unknown) => void;
  /** Add an empty entry to the end of a list. */
  readonly appendListItem: (memberPath: readonly string[]) => void;
  /** Drop one entry, keeping the order of the rest. */
  readonly removeListItem: (memberPath: readonly string[], index: number) => void;
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
 * Hold one schema-derived form.
 *
 * The schema is read ONCE per identity: both the plan and the compiled validator are
 * memoised on it, so a re-render from a keystroke re-walks nothing and re-compiles
 * nothing. A caller handing a fresh object literal every render would defeat that, which
 * is why every caller in this tree reads the schema off a value the wire delivered.
 */
export function useSchemaForm(inputSchema: unknown): SchemaFormState {
  const plan = useMemo(() => planSchemaForm(inputSchema), [inputSchema]);
  const validator = useMemo(() => compileSchemaValidator(inputSchema), [inputSchema]);
  // Seeded per control from what the plan says each one opens holding, and read once: the
  // header's reason, and why this is an initialiser rather than anything that re-runs.
  const [drawnAnswer, setDrawnAnswer] = useState<SchemaFormAnswer>(() => seedAnswerFromPlan(plan));
  const [rawText, setRawText] = useState<string>(EMPTY_RAW_TEXT);

  const rawReading = useMemo(() => readRawText(rawText), [rawText]);
  const isRaw = plan.shape === "raw";
  const composedAnswer = isRaw
    ? rawReading.status === "parsed"
      ? rawReading.answer
      : undefined
    : drawnAnswer;

  const setMemberValue = useCallback((memberPath: readonly string[], value: unknown) => {
    setDrawnAnswer((current) => withMemberAt(current, memberPath, value));
  }, []);

  const setListItem = useCallback(
    (memberPath: readonly string[], index: number, value: unknown) => {
      setDrawnAnswer((current) => {
        const items = [...listAt(current, memberPath)];
        items[index] = value;
        return withMemberAt(current, memberPath, items);
      });
    },
    [],
  );

  const appendListItem = useCallback(
    (memberPath: readonly string[]) => {
      // Asked of the plan rather than fixed at `""`, so a new entry's control opens
      // showing what the answer holds for it — an unchecked box is `false` in both.
      const addedEntry = newListEntryFor(plan, memberPath);
      setDrawnAnswer((current) =>
        withMemberAt(current, memberPath, [...listAt(current, memberPath), addedEntry]),
      );
    },
    [plan],
  );

  const removeListItem = useCallback((memberPath: readonly string[], index: number) => {
    setDrawnAnswer((current) =>
      withMemberAt(
        current,
        memberPath,
        listAt(current, memberPath).filter((_item, at) => at !== index),
      ),
    );
  }, []);

  // Derived on render rather than held, because it is a pure function of two values the
  // hook already has: a stored report is a second copy of the answer's verdict that goes
  // stale between the edit and the effect that would refresh it.
  const report =
    validator.status === "compiled" && (!isRaw || rawReading.status === "parsed")
      ? validator.check(composedAnswer)
      : undefined;
  // The header's rule, in one expression. The drawn arm sends what its controls hold, so
  // nothing reaches the wire that no control accounts for; the raw arm has no controls to
  // agree with, so it sends the schema's reading of the document a person wrote.
  const answer = isRaw && report?.status === "valid" ? report.acceptedValue : composedAnswer;

  return {
    plan,
    answer,
    memberValue: (memberPath) => memberAt(drawnAnswer, memberPath),
    setMemberValue,
    listItems: (memberPath) => listAt(drawnAnswer, memberPath),
    setListItem,
    appendListItem,
    removeListItem,
    rawText,
    setRawText,
    rawReading,
    validator,
    report,
  };
}
