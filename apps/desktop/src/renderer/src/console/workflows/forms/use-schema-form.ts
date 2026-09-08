// The state one schema-derived form holds, and the single place its answer is composed.
//
// TWO INPUT MODES, ONE ANSWER. A schema the mapper drew controls for is answered by
// those controls; a schema it could not — or one nothing could compile a check from — is
// answered as JSON in the editor beside it. Both compose the same value — the object a
// submission would carry — so the surface that renders the verdict, and the owner plan
// that eventually sends it, read ONE member rather than branching on which control a
// person happened to use.
//
// AND THE ARM IS DECIDED HERE, FROM BOTH READINGS. The mapper walks members and the
// schema reader reads the whole schema, so they disagree on exactly one class: a root
// carrying a construct the reader does not implement — `if`/`then`/`else`, a `$ref`,
// `dependentRequired` — above members this form draws perfectly well. Drawing those
// controls would put a form on screen whose only verdict is silence, and a drawn control
// is a promise that a wrong value will be refused. So the two readings are ANDed below,
// in the one place that holds both: the mapper compiles nothing, and a surface deciding
// it would leave this hook composing an answer out of controls nobody can see.
//
// THE VALIDATION IS THE SCHEMA'S AND NEVER THIS HOOK'S. Requiredness, ranges, enum
// membership: all of it is the compiled schema's answer, re-run over the whole answer
// on every edit. A hook that re-derived requiredness from the descriptors would be a
// second authority on a question the schema already settles, and the two would disagree
// the first time a schema used a keyword the mapper does not read.
//
// AND THE ANSWER IS WHAT THE SCHEMA ACCEPTED, NOT WHAT WENT INTO IT. Checking a value
// against a compiled schema READS it — a member declaring a `default` is supplied by the
// reader, so `{}` comes back valid and comes back as `{ approver: "ada" }`. Submitting
// the composed value while rendering a verdict about the read one would put a sentence
// on screen that is true of bytes nobody sends. So the verdict's own accepted value IS
// the answer wherever there is one, and the composed value stands only where the schema
// refused it or could not be asked — because there, no reading exists to prefer.
//
// WHICH IS ALSO WHY THE DRAWN CONTROLS OPEN SEEDED. Composing the submission from the
// reading closes the divergence at the wire and would have left it on the screen: the
// member the schema fills in would send its default while its control sat blank. The
// seed is that same reading of an untouched answer, so the first thing a person sees is
// what a press would send, and typing over it replaces a value rather than filling a gap.
// It is read ONCE, at the mount — a seed recomputed when the schema's identity changed
// would discard what somebody had typed every time the run read refreshed and handed
// down an equal schema as a new object.
//
// THE RAW EDITOR'S DOCUMENT IS STILL THE PERSON'S. Nothing seeds or rewrites the text:
// what is submitted from that arm is the schema's reading of what they typed, which adds
// the members the schema declares values for and — measured at the pinned reader, in
// `bridge/wire-shapes/json-schema-check.ts` — removes nothing they wrote.
//
// A LIST'S ITEMS ARE ADDRESSED BY INDEX AND HELD IN ORDER. Removing the middle entry of
// a three-item list must not renumber the answer under the person editing it, so the
// mutation rebuilds the array rather than writing a hole into it.
//
// NOTHING HERE POLLS, CACHES, OR SUBSCRIBES. The compiled validator is minted once per
// schema through `useMemo`; the answer is one object; the report is derived on render
// from the two of them. There is no effect in this module at all.

import { useCallback, useMemo, useState } from "react";

import { planSchemaForm, type SchemaFallback, type SchemaFormPlan } from "./schema-fields.js";
import {
  compileSchemaValidator,
  type SchemaValidationReport,
  type SchemaValidator,
} from "../../bridge/index.js";

/** The answer being composed: the object a submission would carry. */
export type SchemaFormAnswer = Readonly<Record<string, unknown>>;

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
   * The schema's ACCEPTED reading of what the controls composed wherever the schema made
   * one, so this member and {@link report} are about the same value; the composed value
   * itself where the schema refused it or could not be asked.
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

/** The answer an untouched form composes before its schema has said anything about it. */
const NOTHING_ANSWERED: SchemaFormAnswer = {};

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
 * Whatever this is, read as a set of named values — or nothing where it is not one.
 *
 * One reading, used by the three places that need it. An array is deliberately not one:
 * it holds positions rather than names, so walking into it by key would answer for a
 * member that cannot exist.
 */
function asAnswerRecord(value: unknown): SchemaFormAnswer | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as SchemaFormAnswer)
    : undefined;
}

/** Read one member out of a nested answer without asserting the shape of what is there. */
function memberAt(answer: SchemaFormAnswer, memberPath: readonly string[]): unknown {
  let cursor: unknown = answer;
  for (const segment of memberPath) {
    const record = asAnswerRecord(cursor);
    if (record === undefined) {
      return undefined;
    }
    cursor = record[segment];
  }
  return cursor;
}

/**
 * Write one member of a nested answer, rebuilding every object on the way down.
 *
 * Rebuilt rather than mutated because the answer is the value React re-renders on: a
 * mutation in place is the same object identity and the surface would not repaint.
 */
function withMemberAt(
  answer: SchemaFormAnswer,
  memberPath: readonly string[],
  value: unknown,
): SchemaFormAnswer {
  const [head, ...rest] = memberPath;
  if (head === undefined) {
    return answer;
  }
  if (rest.length === 0) {
    return { ...answer, [head]: value };
  }
  const childRecord = asAnswerRecord(answer[head]) ?? NOTHING_ANSWERED;
  return { ...answer, [head]: withMemberAt(childRecord, rest, value) };
}

/** Whatever sits at this path, read as a list. Never `undefined`, so a map is safe. */
function listAt(answer: SchemaFormAnswer, memberPath: readonly string[]): readonly unknown[] {
  const held = memberAt(answer, memberPath);
  return Array.isArray(held) ? (held as readonly unknown[]) : [];
}

/**
 * What this schema fills in for an answer nobody has touched, as the drawn controls' seed.
 *
 * Asked of the compiled validator rather than re-read off the descriptors, so the values
 * a control opens with and the values a submission carries come from ONE authority — a
 * second pass over the schema's `default` keywords would disagree with the reader the
 * first time one of them appeared somewhere the mapper does not look.
 *
 * An empty answer the schema REFUSES seeds nothing, and cannot: a refusal carries no
 * reading, so a schema requiring a member it declares no value for opens with every
 * control blank. That is honest rather than complete — the submission still carries
 * whatever the schema fills in, and it says so through the verdict the moment the
 * answer becomes one the schema will read.
 */
function schemaSeededAnswer(validator: SchemaValidator): SchemaFormAnswer {
  if (validator.status !== "compiled") {
    return NOTHING_ANSWERED;
  }
  const report = validator.check(NOTHING_ANSWERED);
  return report.status === "valid"
    ? (asAnswerRecord(report.acceptedValue) ?? NOTHING_ANSWERED)
    : NOTHING_ANSWERED;
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
  // Seeded from the schema's own reading of an untouched answer, and read once: the
  // header's reason, and why this is an initialiser rather than anything that re-runs.
  const [drawnAnswer, setDrawnAnswer] = useState<SchemaFormAnswer>(() =>
    schemaSeededAnswer(validator),
  );
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

  const appendListItem = useCallback((memberPath: readonly string[]) => {
    setDrawnAnswer((current) =>
      withMemberAt(current, memberPath, [...listAt(current, memberPath), ""]),
    );
  }, []);

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
  // The header's rule, in one expression: the answer is the schema's reading of what was
  // composed wherever it made one, so the verdict on screen is a verdict on these bytes.
  const answer = report?.status === "valid" ? report.acceptedValue : composedAnswer;

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
