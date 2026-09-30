// The question card: an agent's question, in the composer where an approval sits.
//
// A mount may supply `body` to replace the card. `question-reading.ts` carries the
// reading this card renders.
//
// WHAT THE CARD DRAWS FROM ITS READING. The row's payload is the plain half of the
// question record — its id, its run and its page count. The questions and their options
// are the record's personal-data half, sealed apart from the payload, so this card
// draws neither; it offers the typed answer every question takes.
//
// AN ANSWER IS A SETTLED ACT AND NOT A KEYSTROKE THAT VANISHED. The card draws what
// became of the answer's reply once: the call is out, the daemon took it, or it was
// refused and the person's words never left this machine. Nothing here settles the
// question: it has no timer, and the card closes when the question's attention entry
// resolves.
//
// ONE COMPONENT HERE, AND THE FREE-TEXT ARM IS THE OTHER. Every part of this card but
// one is a branch of a single render, so each is a plain function returning a node
// rather than a component of its own. The exception is the arm that holds a draft
// between keystrokes, and it has a module of its own for exactly that reason.

import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { TypedAnswerField } from "./TypedAnswerField.js";
import type {
  AnswerDelivery,
  QuestionReading,
} from "@renderer/store/session-events/question-reading.js";

import "./question-card.css";

/** What the card hands a supplied body. */
export interface QuestionCardBodyProps {
  readonly question: QuestionReading;
  /** Where the answer this card last dispatched has got to. */
  readonly delivery: AnswerDelivery;
  readonly onAnswer: (response: string) => void;
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
  /**
   * Where the answer this card last dispatched has got to.
   *
   * Held by the mount rather than here, because the dispatch is a wire call and this
   * card constructs none.
   */
  readonly delivery: AnswerDelivery;
  /** Deliver a typed answer. */
  readonly onAnswer: (response: string) => void;
}

/** The question card: the built-in one, or the supplied `body` when the mount passes one. */
export function QuestionCard(props: QuestionCardProps): React.JSX.Element {
  if (props.body !== undefined) {
    return (
      <div className="meridian-input-ask">
        {props.body({
          question: props.question,
          delivery: props.delivery,
          onAnswer: props.onAnswer,
        })}
      </div>
    );
  }
  // The two statuses in which no further answer may be dispatched: one is on the wire,
  // or one has already reached the daemon. A refusal deliberately leaves the field live,
  // because a refusal never hides the control that produced it.
  const isSettling = props.delivery.status === "delivering" || props.delivery.status === "accepted";
  return (
    <div className="meridian-input-ask">
      <TypedAnswerField delivery={props.delivery} isClosed={isSettling} onAnswer={props.onAnswer} />
      {renderDelivery(props.delivery)}
    </div>
  );
}

/**
 * What became of the answer this card dispatched, and nothing about the question itself.
 *
 * `unsent` renders nothing at all, which is every question nobody has answered yet. The
 * other three are the console's own report: the call is out, the daemon took it, or the
 * call did not land. `accepted` never says the question is settled; the refusal renders
 * inline under the field that was used.
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
