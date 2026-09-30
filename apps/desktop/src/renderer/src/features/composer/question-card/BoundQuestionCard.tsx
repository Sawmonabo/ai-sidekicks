// An agent's question bound to its answer path.
//
// Its own component so that only a row that is a question arms the answer dispatcher. A
// row that is not a question renders something else and arms none of it.

import type { QuestionAskedPersonalData } from "@ai-sidekicks/contracts";
import { type QuestionReading } from "@renderer/store/session-events/question-reading.js";
import { useQuestionAnswer, type ResolveQuestionCall } from "./hooks/useQuestionAnswer.js";
import { QuestionCard } from "./QuestionCard.js";

/** What the mount hands the bound question card. */
export interface BoundQuestionCardProps {
  /** The question this row is blocked on. */
  readonly question: QuestionReading;
  /** Every question of the record, from the row's personal-data half. */
  readonly questions: QuestionAskedPersonalData["questions"];
  readonly resolveQuestion: ResolveQuestionCall;
}

/**
 * One agent's question, with the answer path it needs.
 *
 * @consumedBy the composer's question card
 */
export function BoundQuestionCard(props: BoundQuestionCardProps): React.JSX.Element {
  const questionAnswer = useQuestionAnswer(props.question.questionId, props.resolveQuestion);
  return (
    <QuestionCard
      body={undefined}
      question={props.question}
      questions={props.questions}
      delivery={questionAnswer.delivery}
      onAnswer={questionAnswer.answer}
    />
  );
}
