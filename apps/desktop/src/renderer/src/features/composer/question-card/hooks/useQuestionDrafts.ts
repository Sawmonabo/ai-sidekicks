// What the person has given each question of a record, until the answers go back.
//
// Answers are offered only once every question has one. A marked row and typed text exclude
// each other; a secret is delivered but never stored by the daemon, so its value lives only in
// this state and is never logged. A number question's typed text answers only when it reads as a
// number: the daemon takes it as typed text, so the check is the field's own. Drafts clear only
// when the daemon takes the answers.

import { useEffect, useState } from "react";

import type {
  QuestionAnswer,
  QuestionPrompt,
  QuestionResolveRequest,
} from "@ai-sidekicks/contracts/question";
import { type AnswerDelivery } from "#renderer/store/session/events/question-reading.js";

/** What the person has given one question so far. */
export interface QuestionDraft {
  /** The marked option row's label, or `undefined` when no row is marked. */
  readonly pickedLabel: string | undefined;
  readonly typedText: string;
  /** The masked field's value, on a secret question only. */
  readonly secretValue: string;
}

/** Every question's draft, the answers they make, and the ways to change one. */
export interface QuestionDraftsHandle {
  /** One draft per question, in the record's order. */
  readonly drafts: readonly QuestionDraft[];
  /** One answer per question in the record's order, or `undefined` while any has none. */
  readonly answers: QuestionResolveRequest["answers"] | undefined;
  /** Mark an option row as the question's answer. */
  readonly pickOption: (questionIndex: number, label: string) => void;
  /** Make typed text the question's answer, unmarking any row. */
  readonly typeAnswer: (questionIndex: number, text: string) => void;
  /** Set a secret question's masked value. */
  readonly enterSecret: (questionIndex: number, value: string) => void;
}

/**
 * Hold one draft per question of the record `questionId` names, emptied when the
 * delivery reaches `accepted` and when `questionId` changes.
 */
export function useQuestionDrafts(
  questionId: string,
  questions: readonly QuestionPrompt[],
  deliveryStatus: AnswerDelivery["status"],
): QuestionDraftsHandle {
  const [held, setHeld] = useState<HeldDrafts>(() => emptyHeldDrafts(questionId, questions));
  // Another record resets during render, not in an effect, so the first render never shows
  // the old record's marks or secret.
  if (held.questionId !== questionId) {
    setHeld(emptyHeldDrafts(questionId, questions));
  }
  // A transition, not a derivation: rendering empty values on `accepted` would leave the
  // answers in state and bring them back if the status moved on.
  useEffect(() => {
    if (deliveryStatus === "accepted") {
      setHeld(emptyHeldDrafts(questionId, questions));
    }
  }, [deliveryStatus, questionId, questions]);

  const drafts = held.drafts;
  const updateDraft = (questionIndex: number, change: Partial<QuestionDraft>): void => {
    setHeld((current) => ({
      questionId: current.questionId,
      drafts: current.drafts.map((draft, index) =>
        index === questionIndex ? { ...draft, ...change } : draft,
      ),
    }));
  };
  const partialAnswers = questions.map((prompt, index) =>
    answerOf(drafts[index] ?? EMPTY_DRAFT, prompt),
  );
  return {
    drafts,
    answers: everyAnswered(partialAnswers),
    pickOption: (questionIndex, label) => {
      updateDraft(questionIndex, { pickedLabel: label });
    },
    typeAnswer: (questionIndex, text) => {
      updateDraft(questionIndex, { pickedLabel: undefined, typedText: text });
    },
    enterSecret: (questionIndex, value) => {
      updateDraft(questionIndex, { secretValue: value });
    },
  };
}

/** The drafts and the record they belong to. */
interface HeldDrafts {
  readonly questionId: string;
  readonly drafts: readonly QuestionDraft[];
}

const EMPTY_DRAFT: QuestionDraft = Object.freeze({
  pickedLabel: undefined,
  typedText: "",
  secretValue: "",
});

/**
 * Whether a question asks for a number: it bounds, steps, units or defaults to one. The wire
 * carries no other mark of a number question.
 */
export function isNumberQuestion(prompt: QuestionPrompt): boolean {
  return (
    prompt.minimum !== undefined ||
    prompt.maximum !== undefined ||
    prompt.step !== undefined ||
    prompt.unit !== undefined ||
    typeof prompt.default === "number"
  );
}

/** Whether typed text is refused in place: a number question's words that are not a number. */
export function isNotANumber(prompt: QuestionPrompt, typedText: string): boolean {
  if (!isNumberQuestion(prompt)) {
    return false;
  }
  const trimmed = typedText.trim();
  return trimmed.length > 0 && !Number.isFinite(Number(trimmed));
}

function emptyDrafts(questions: readonly QuestionPrompt[]): readonly QuestionDraft[] {
  return questions.map(() => EMPTY_DRAFT);
}

function emptyHeldDrafts(questionId: string, questions: readonly QuestionPrompt[]): HeldDrafts {
  return { questionId, drafts: emptyDrafts(questions) };
}

/** The answers, once there is at least one and every question has one. */
function everyAnswered(
  answers: readonly (QuestionAnswer | undefined)[],
): QuestionResolveRequest["answers"] | undefined {
  const [first, ...rest] = answers;
  if (first === undefined || !rest.every((answer) => answer !== undefined)) {
    return undefined;
  }
  return [first, ...rest];
}

/** The answer a draft gives its question, or `undefined` while it gives none. */
function answerOf(draft: QuestionDraft, prompt: QuestionPrompt): QuestionAnswer | undefined {
  if (prompt.secret) {
    return draft.secretValue.length > 0 ? { kind: "secret", value: draft.secretValue } : undefined;
  }
  if (draft.pickedLabel !== undefined) {
    return { kind: "picked", labels: [draft.pickedLabel] };
  }
  if (draft.typedText.length > 0 && !isNotANumber(prompt, draft.typedText)) {
    return { kind: "typed", text: draft.typedText };
  }
  return undefined;
}
