// The questions card's answers, one per question in the order they were asked, as Codex's
// `item/tool/requestUserInput` reads them: each question's picked or typed texts under its own id.

import type { QuestionAnswer } from "@ai-sidekicks/contracts/question";

import { isPlainObject } from "../../../record-readers.js";
import { readQuestionAnswerTexts } from "../../question-answers.js";

/**
 * A user-input request's `answers`, keyed by each question's own id; a skipped question has no
 * key, which Codex reads as unanswered.
 */
export function composeCodexUserInputAnswers(
  params: unknown,
  answers: readonly QuestionAnswer[],
): Record<string, { answers: string[] }> {
  const questions = isPlainObject(params) ? params["questions"] : undefined;
  const composed: Record<string, { answers: string[] }> = {};
  if (!Array.isArray(questions)) {
    return composed;
  }
  questions.forEach((question, index) => {
    const questionId = isPlainObject(question) ? question["id"] : undefined;
    const texts = readQuestionAnswerTexts(answers[index]);
    if (typeof questionId === "string" && texts.length > 0) {
      composed[questionId] = { answers: texts };
    }
  });
  return composed;
}
