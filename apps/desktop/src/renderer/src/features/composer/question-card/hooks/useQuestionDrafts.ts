// What the person has given each question of a record, until the answers go back.
//
// EVERY ANSWER GOES BACK TOGETHER. The daemon refuses a list that leaves a question out,
// so this holds one draft per question and offers the answers only once each question
// has one. On one question a marked option row and typed text exclude each other:
// whichever the person touched last is the answer.
//
// A SECRET ANSWERS AS A SECRET AND NOTHING ELSE. The daemon delivers a `secret` answer
// and stores none of it, while a `typed` answer is stored, so a secret question's draft
// becomes a `secret` answer or no answer at all. Its value lives only in this hook's
// state: nothing logs it, and it goes when the daemon takes the answers, when the card
// shows another record, or when the card unmounts and React drops the state.
//
// CLEARED ONLY WHEN THE DAEMON TOOK THEM. A refusal leaves every mark and every typed
// word where it was, so pressing again retries.
//
// ONE RECORD'S DRAFTS NEVER REACH ANOTHER'S. The drafts are held with the question id
// they belong to, and a card handed another record starts from empty drafts.

import { useEffect, useState } from "react";

import type { QuestionAnswer, QuestionPrompt } from "@ai-sidekicks/contracts";
import { type AnswerDelivery } from "@renderer/store/session-events/question-reading.js";

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
  readonly answers: QuestionAnswer[] | undefined;
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
  // ANOTHER RECORD RESETS DURING RENDER, not in an effect, so the first render of the new
  // record never shows the old record's marks or secret.
  if (held.questionId !== questionId) {
    setHeld(emptyHeldDrafts(questionId, questions));
  }
  // A TRANSITION RATHER THAN A DERIVATION. The drafts are cleared when the delivery
  // REACHES `accepted`, which is a moment and not a condition — rendering empty values on
  // that status would leave the person's answers in state, invisible, and back on screen
  // the moment anything moved the delivery out of that status.
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
    answers: partialAnswers.every((answer) => answer !== undefined) ? partialAnswers : undefined,
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

function emptyDrafts(questions: readonly QuestionPrompt[]): readonly QuestionDraft[] {
  return questions.map(() => EMPTY_DRAFT);
}

function emptyHeldDrafts(questionId: string, questions: readonly QuestionPrompt[]): HeldDrafts {
  return { questionId, drafts: emptyDrafts(questions) };
}

/** The answer a draft gives its question, or `undefined` while it gives none. */
function answerOf(draft: QuestionDraft, prompt: QuestionPrompt): QuestionAnswer | undefined {
  if (prompt.secret) {
    return draft.secretValue.length > 0 ? { kind: "secret", value: draft.secretValue } : undefined;
  }
  if (draft.pickedLabel !== undefined) {
    return { kind: "picked", labels: [draft.pickedLabel] };
  }
  if (draft.typedText.length > 0) {
    return { kind: "typed", text: draft.typedText };
  }
  return undefined;
}
