// The question card: an agent's question, in the composer where an approval sits.
//
// Draws every question of the record in order, each with its option rows and a typed field
// (both providers always take typed text); a secret question draws one masked field instead.
// `Answer` stays closed until every question has an answer, then sends one per question in
// one call and hides the card, which draws again with its answers only if the answer is refused.
// The card never settles the question itself.

import type {
  QuestionAskedPayload,
  QuestionResolveRequest,
} from "@ai-sidekicks/contracts/question";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { isNotANumber, useQuestionDrafts } from "./hooks/useQuestionDrafts.js";
import { SecretAnswerField } from "./SecretAnswerField.js";
import { TypedAnswerField } from "./TypedAnswerField.js";
import type {
  AnswerDelivery,
  QuestionReading,
} from "#renderer/store/session/events/question-reading.js";

import "./QuestionCard.css";

/** What a mount hands the question card. */
export interface QuestionCardProps {
  readonly question: QuestionReading;
  /** Every question of the record, in its own order. */
  readonly questions: QuestionAskedPayload["questions"];
  /** Where the last dispatched answer has got to; held by the mount, which owns the wire call. */
  readonly delivery: AnswerDelivery;
  /** Deliver one answer per question, in the record's order. */
  readonly onAnswer: (answers: QuestionResolveRequest["answers"]) => void;
}

/**
 * The question card: every question with its fields, and `Answer`. Hidden while an answer is on
 * its way or taken, with its drafts still held for a refused one.
 */
export function QuestionCard(props: QuestionCardProps): React.JSX.Element | null {
  const { delivery } = props;
  const questionDrafts = useQuestionDrafts(
    props.question.questionId,
    props.questions,
    delivery.status,
  );
  const { answers, drafts } = questionDrafts;
  if (delivery.status === "delivering" || delivery.status === "accepted") {
    return null;
  }
  return (
    <form
      className="meridian-input-ask"
      onSubmit={(event) => {
        event.preventDefault();
        // The condition the Answer button is closed on, so guard and affordance agree.
        if (answers !== undefined) {
          props.onAnswer(answers);
        }
      }}
    >
      {props.questions.map((prompt, index) => (
        <section key={index} className="meridian-input-ask__question">
          {prompt.header === undefined ? null : (
            <span className="meridian-input-ask__header">{prompt.header}</span>
          )}
          <p className="meridian-input-ask__prompt">{prompt.text}</p>
          {prompt.heading === undefined ? null : (
            <p className="meridian-input-ask__heading">{prompt.heading}</p>
          )}
          {prompt.secret ? (
            <SecretAnswerField
              questionText={prompt.text}
              value={drafts[index]?.secretValue ?? ""}
              onValueChange={(value) => {
                questionDrafts.enterSecret(index, value);
              }}
            />
          ) : (
            <>
              {prompt.options.length === 0 ? null : (
                <ul
                  className="meridian-input-ask__options"
                  aria-label="the answers this question offers"
                >
                  {prompt.options.map((option) => (
                    <li key={option.label}>
                      <button
                        type="button"
                        className="meridian-input-ask__option meridian-action-button"
                        aria-pressed={drafts[index]?.pickedLabel === option.label}
                        onClick={() => {
                          questionDrafts.pickOption(index, option.label);
                        }}
                      >
                        <span>{option.label}</span>
                        {option.description === undefined ? null : (
                          <span className="meridian-input-ask__option-description">
                            {option.description}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <TypedAnswerField
                draft={drafts[index]?.typedText ?? ""}
                issue={
                  isNotANumber(prompt, drafts[index]?.typedText ?? "")
                    ? NOT_A_NUMBER_SENTENCE
                    : undefined
                }
                onDraftChange={(text) => {
                  questionDrafts.typeAnswer(index, text);
                }}
              />
            </>
          )}
        </section>
      ))}
      <button
        type="submit"
        className="meridian-input-ask__send meridian-action-button"
        disabled={answers === undefined}
      >
        Answer
      </button>
      {delivery.status === "refused" ? <InlineRefusal {...delivery.refusal} /> : null}
    </form>
  );
}

/** What a number question's field says under typed text that is not a number. */
const NOT_A_NUMBER_SENTENCE = "That is not a number.";
