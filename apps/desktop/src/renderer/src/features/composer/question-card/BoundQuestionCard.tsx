// An agent's question bound to its answer path.
//
// Its own component so that only a row that is a question arms the answer dispatcher. A
// row that is not a question renders something else and arms none of it.

import { type QuestionReading } from "@renderer/store/session-events/question-reading.js";
import { useQuestionAnswer, type ResolveQuestionCall } from "./hooks/useQuestionAnswer.js";
import { QuestionCard } from "./QuestionCard.js";

export interface BoundQuestionCardProps {
  /** The question this row is blocked on, read off the row by the component that mounts it. */
  readonly question: QuestionReading;
  /** The call that answers it. */
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
      delivery={questionAnswer.delivery}
      onAnswer={questionAnswer.answer}
    />
  );
}
