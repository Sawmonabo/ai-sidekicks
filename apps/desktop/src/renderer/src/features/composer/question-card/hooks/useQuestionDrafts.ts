// What the person has given each question of a record, until the answers go back.
//
// EVERY ANSWER GOES BACK TOGETHER. The daemon refuses a list that leaves a question out,
// so this holds one draft per question and offers the answers only once each question
// has one. On one question a marked option row and typed text exclude each other:
// whichever the person touched last is the answer.
//
// CLEARED ONLY WHEN THE DAEMON TOOK THEM. A refusal leaves every mark and every typed
// word where it was, so pressing again retries.

import { useEffect, useState } from "react";

import type { QuestionAnswer, QuestionPrompt } from "@ai-sidekicks/contracts";
import { type AnswerDelivery } from "@renderer/store/session-events/question-reading.js";

/** What the person has given one question so far. */
export interface QuestionDraft {
  /** The marked option row's label, or `undefined` when no row is marked. */
  readonly pickedLabel: string | undefined;
  readonly typedText: string;
}

/** Every question's draft, the answers they make, and the two ways to change one. */
export interface QuestionDraftsHandle {
  /** One draft per question, in the record's order. */
  readonly drafts: readonly QuestionDraft[];
  /** One answer per question in the record's order, or `undefined` while any has none. */
  readonly answers: QuestionAnswer[] | undefined;
  /** Mark an option row as the question's answer. */
  readonly pickOption: (questionIndex: number, label: string) => void;
  /** Make typed text the question's answer, unmarking any row. */
  readonly typeAnswer: (questionIndex: number, text: string) => void;
}

/** Hold one draft per question, cleared when the delivery reaches `accepted`. */
export function useQuestionDrafts(
  questions: readonly QuestionPrompt[],
  deliveryStatus: AnswerDelivery["status"],
): QuestionDraftsHandle {
  const [drafts, setDrafts] = useState<readonly QuestionDraft[]>(() => emptyDrafts(questions));
  // A TRANSITION RATHER THAN A DERIVATION. The drafts are cleared when the delivery
  // REACHES `accepted`, which is a moment and not a condition — rendering empty values on
  // that status would leave the person's answers in state, invisible, and back on screen
  // the moment anything moved the delivery out of that status.
  useEffect(() => {
    if (deliveryStatus === "accepted") {
      setDrafts(emptyDrafts(questions));
    }
  }, [deliveryStatus, questions]);

  const updateDraft = (questionIndex: number, change: Partial<QuestionDraft>): void => {
    setDrafts((current) =>
      current.map((draft, index) => (index === questionIndex ? { ...draft, ...change } : draft)),
    );
  };
  const partialAnswers = drafts.map(answerOf);
  return {
    drafts,
    answers: partialAnswers.every((answer) => answer !== undefined) ? partialAnswers : undefined,
    pickOption: (questionIndex, label) => {
      updateDraft(questionIndex, { pickedLabel: label });
    },
    typeAnswer: (questionIndex, text) => {
      updateDraft(questionIndex, { pickedLabel: undefined, typedText: text });
    },
  };
}

const EMPTY_DRAFT: QuestionDraft = Object.freeze({ pickedLabel: undefined, typedText: "" });

function emptyDrafts(questions: readonly QuestionPrompt[]): readonly QuestionDraft[] {
  return questions.map(() => EMPTY_DRAFT);
}

/** The answer a draft gives its question, or `undefined` while it gives none. */
function answerOf(draft: QuestionDraft): QuestionAnswer | undefined {
  if (draft.pickedLabel !== undefined) {
    return { kind: "picked", labels: [draft.pickedLabel] };
  }
  if (draft.typedText.length > 0) {
    return { kind: "typed", text: draft.typedText };
  }
  return undefined;
}
