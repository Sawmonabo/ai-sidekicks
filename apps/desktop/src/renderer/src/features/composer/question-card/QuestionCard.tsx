// The question card: an agent's question, in the composer where an approval sits.
//
// A mount may supply `body` to replace the card. The row's reading comes from
// `question-reading.ts`; the questions themselves are the record's personal-data half
// and arrive as their own prop.
//
// WHAT THE CARD DRAWS. Every question of the record in its own order: the agent's short
// header, the question, the summary line where one was sent, the option rows with each
// description that was sent, and a typed field under every question, because both
// providers always take typed text and a question may offer no options at all. The
// questions are drawn one under another; paging through them is not built here.
//
// EVERY ANSWER GOES BACK TOGETHER. A press on an option row marks it and never sends
// anything by itself. `Answer` stays closed until each question has either a marked row
// or typed text, then sends one answer per question, in the record's order, in one
// call. `useQuestionDrafts` holds the marks and the typed text.
//
// AN ANSWER IS A SETTLED ACT AND NOT A KEYSTROKE THAT VANISHED. The card draws what
// became of the answer's reply once: the call is out, the daemon took it, or it was
// refused and the person's words never left this machine. Nothing here settles the
// question: it has no timer, and the card closes when the question's attention entry
// resolves.

import type { QuestionAnswer, QuestionAskedPersonalData } from "@ai-sidekicks/contracts";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { useQuestionDrafts } from "./hooks/useQuestionDrafts.js";
import { TypedAnswerField } from "./TypedAnswerField.js";
import type {
  AnswerDelivery,
  QuestionReading,
} from "@renderer/store/session-events/question-reading.js";

import "./question-card.css";

/** What the card hands a supplied body. */
export interface QuestionCardBodyProps {
  readonly question: QuestionReading;
  readonly questions: QuestionAskedPersonalData["questions"];
  /** Where the answer this card last dispatched has got to. */
  readonly delivery: AnswerDelivery;
  readonly onAnswer: (answers: QuestionAnswer[]) => void;
}

/** What a mount hands the question card. */
export interface QuestionCardProps {
  /**
   * A body that replaces the built-in card, or `undefined` while the card draws itself.
   *
   * Required and carrying `undefined` rather than optional, so a mount that forgot it is a
   * compile error at the construction site rather than an absent key that renders
   * identically to a deliberate "none".
   */
  readonly body: ((props: QuestionCardBodyProps) => React.ReactNode) | undefined;
  readonly question: QuestionReading;
  /** Every question of the record, in its own order. */
  readonly questions: QuestionAskedPersonalData["questions"];
  /**
   * Where the answer this card last dispatched has got to.
   *
   * Held by the mount rather than here, because the dispatch is a wire call and this
   * card constructs none.
   */
  readonly delivery: AnswerDelivery;
  /** Deliver one answer per question, in the record's order. */
  readonly onAnswer: (answers: QuestionAnswer[]) => void;
}

/** The question card: the built-in one, or the supplied `body` when the mount passes one. */
export function QuestionCard(props: QuestionCardProps): React.JSX.Element {
  const deliveryStatus = props.delivery.status;
  const questionDrafts = useQuestionDrafts(props.questions, deliveryStatus);
  if (props.body !== undefined) {
    return (
      <div className="meridian-input-ask">
        {props.body({
          question: props.question,
          questions: props.questions,
          delivery: props.delivery,
          onAnswer: props.onAnswer,
        })}
      </div>
    );
  }
  // The two statuses in which no further answer may be dispatched: one is on the wire,
  // or one has already reached the daemon. A refusal deliberately leaves the controls
  // live, because a refusal never hides the control that produced it.
  const isSettling = deliveryStatus === "delivering" || deliveryStatus === "accepted";
  const { answers, drafts } = questionDrafts;
  return (
    <form
      className="meridian-input-ask"
      onSubmit={(event) => {
        event.preventDefault();
        // BOTH CONDITIONS THE BUTTON IS CLOSED ON, so the guard and the affordance
        // cannot disagree.
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
                    <span className="meridian-input-ask__option-label">{option.label}</span>
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
 * What became of the answer this card dispatched, and nothing about the question itself.
 *
 * `unsent` renders nothing at all, which is every question nobody has answered yet. The
 * other three are the console's own report: the call is out, the daemon took it, or the
 * call did not land. `accepted` never says the question is settled; the refusal renders
 * inline under the controls that were used.
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
