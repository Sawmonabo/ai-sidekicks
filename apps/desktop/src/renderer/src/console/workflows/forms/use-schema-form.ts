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
// A LIST'S ITEMS ARE ADDRESSED BY INDEX AND HELD IN ORDER. Removing the middle entry of
// a three-item list must not renumber the answer under the person editing it, so the
// mutation rebuilds the array rather than writing a hole into it.
//
// NOTHING HERE POLLS, CACHES, OR SUBSCRIBES. The compiled validator is minted once per
// schema through `useMemo`; the answer is one object; the report is derived on render
// from the two of them. There is no effect in this module at all.

import { useCallback, useMemo, useState } from "react";

import { planSchemaForm, type SchemaFormPlan } from "./schema-fields.js";
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
  /** The answer as it stands, from whichever input mode this plan uses. */
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

/** Read one member out of a nested answer without asserting the shape of what is there. */
function memberAt(answer: SchemaFormAnswer, memberPath: readonly string[]): unknown {
  let cursor: unknown = answer;
  for (const segment of memberPath) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
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
  const child = answer[head];
  const childRecord =
    typeof child === "object" && child !== null && !Array.isArray(child)
      ? (child as SchemaFormAnswer)
      : {};
  return { ...answer, [head]: withMemberAt(childRecord, rest, value) };
}

/** Whatever sits at this path, read as a list. Never `undefined`, so a map is safe. */
function listAt(answer: SchemaFormAnswer, memberPath: readonly string[]): readonly unknown[] {
  const held = memberAt(answer, memberPath);
  return Array.isArray(held) ? (held as readonly unknown[]) : [];
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
  const plan = useMemo(() => planSchemaForm(inputSchema), [inputSchema]);
  const validator = useMemo(() => compileSchemaValidator(inputSchema), [inputSchema]);
  const [drawnAnswer, setDrawnAnswer] = useState<SchemaFormAnswer>({});
  const [rawText, setRawText] = useState<string>(EMPTY_RAW_TEXT);

  const rawReading = useMemo(() => readRawText(rawText), [rawText]);
  const isRaw = plan.shape === "raw";
  const answer = isRaw
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
      ? validator.check(answer)
      : undefined;

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
