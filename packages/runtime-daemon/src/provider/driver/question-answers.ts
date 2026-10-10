// The texts a questions card's answer gives, which every driver composes into its provider's own
// answer shape.

import type { QuestionAnswer } from "@ai-sidekicks/contracts/question";

/** The texts one answer gives: the labels picked, the text typed or the secret; none if skipped. */
export function readQuestionAnswerTexts(answer: QuestionAnswer | undefined): string[] {
  switch (answer?.kind) {
    case "picked":
      return answer.labels;
    case "typed":
      return [answer.text];
    case "secret":
      return [answer.value];
    case "skipped":
    case undefined:
      return [];
  }
}
