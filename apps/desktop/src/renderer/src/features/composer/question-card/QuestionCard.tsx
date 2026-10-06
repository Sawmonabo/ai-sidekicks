// The question card: an agent's question, in the composer where an approval sits.
//
// Draws every question of the record in order, each with its option rows and a typed field
// (both providers always take typed text); a secret question draws one masked field instead.
// `Answer` stays closed until every question has an answer, then sends one per question in
// one call. The card never settles the question itself.

import type { QuestionAnswer, QuestionAskedPayload } from "@ai-sidekicks/contracts/question";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { useQuestionDrafts } from "./hooks/useQuestionDrafts.js";
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
  readonly onAnswer: (answers: QuestionAnswer[]) => void;
}

/** The question card: every question with its fields, and `Answer`. */
export function QuestionCard(props: QuestionCardProps): React.JSX.Element {
  const deliveryStatus = props.delivery.status;
  const questionDrafts = useQuestionDrafts(
    props.question.questionId,
    props.questions,
    deliveryStatus,
  );
  // No further answer while one is on the wire or taken; a refusal leaves the controls live.
  const isSettling = deliveryStatus === "delivering" || deliveryStatus === "accepted";
  const { answers, drafts } = questionDrafts;
  return (
    <form
      className="meridian-input-ask"
      onSubmit={(event) => {
        event.preventDefault();
        // The conditions the Answer button is closed on, so guard and affordance agree.
        if (answers !== undefined && !isSettling) {
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
              isClosed={isSettling}
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
                        disabled={isSettling}
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
                isClosed={isSettling}
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
        disabled={isSettling || answers === undefined}
      >
        Answer
      </button>
      {renderDelivery(props.delivery)}
    </form>
  );
}

/**
 * Draws what became of the dispatched answer: nothing while `unsent`, otherwise in flight,
 * taken, or an inline refusal. `accepted` never claims the question is settled.
 */
function renderDelivery(delivery: AnswerDelivery): React.ReactNode {
  switch (delivery.status) {
    case "unsent":
      return null;
    case "delivering":
      return (
        <Nothing
          kind="computing"
          placement="inline"
          title="Delivering this answer."
          detail="The answer is on the wire and has not been acknowledged yet."
        />
      );
    case "accepted":
      return (
        <Nothing
          kind="empty"
          placement="inline"
          title="The answer was delivered."
          detail="The background service took this answer."
        />
      );
    case "refused":
      return <InlineRefusal code={delivery.refusal.code} detail={delivery.refusal.detail} />;
  }
}
