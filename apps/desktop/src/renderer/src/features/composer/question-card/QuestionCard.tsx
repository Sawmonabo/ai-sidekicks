// The input-ask card: the provider's question, in the transcript, where it was asked.
//
// A mount may supply `body` to replace the card. `input-ask.ts` carries the reading this
// card renders.
//
// TWO ANSWER ARMS, AND ONE OF THEM IS UNCONDITIONAL. A provider that declared a
// choice set gets an option group; EVERY ask, choice set or not, gets a free-text
// field. That is not a convenience — one of the two pinned provider mechanisms
// cannot supply a choice set at all, and an oversized set is dropped at the driver's
// own boundary rather than truncated, so an ask with no options is the ordinary case
// and a card whose only answer path was the option group would leave those runs
// unanswerable. Both arms travel the same already-registered answer method, so
// neither is a second ingress.
//
// AN ANSWER IS A SETTLED ACT AND NOT A KEYSTROKE THAT VANISHED. Both arms dispatch
// through one method and one reply, so the card draws what became of that reply once,
// under both of them: the call is out, the driver acknowledged it, or it was refused
// and the user's words never left this machine. The refused arm is why this
// exists — the reply used to be discarded, so a run blocked on an unanswered question
// looked exactly like one waiting for somebody to type. Neither arm settles the ask.
//
// THE COUNTDOWN DISPLAYS A STAMP AND SETTLES NOTHING. The remaining interval is
// computed from the daemon's stamped deadline against a clock the MOUNT supplies —
// this card holds no timer, starts no interval, and reaches zero without changing
// the ask's state. At zero it says the card is waiting for the daemon, which is a
// statement about the console and not about the ask: an input ask that expires parks
// its run, and only the `driver_ask.expired` row may say that it did.
//
// ONE COMPONENT HERE, AND THE FREE-TEXT ARM IS THE OTHER. Every part of this card
// but one is a branch of a single render over the ask it was handed, so each is a
// plain function returning a node rather than a component of its own. The exception
// is the arm that holds a draft between keystrokes, and it has a module of its own
// for exactly that reason.
//
// THE OPTION ROW IS TWO PARTS AND IS NOT `WireChoiceList`. That primitive renders one
// wire identifier per row, by design, because its callers offer identifiers with no
// provider-supplied label. An ask option carries a `value` the answer is composed
// from AND an optional `label` the provider wrote, and both have to reach the reader:
// the value is what is delivered, and the label is the only thing that says what the
// choice means. A row carrying both is a different row, not a second copy of that one.

import { parseInstant } from "@renderer/lib/instant.js";
import { InlineRefusal } from "@renderer/components/Refusal/InlineRefusal.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatDuration } from "@renderer/lib/wire-figures.js";
import { TypedAnswerField } from "./TypedAnswerField.js";
import type {
  AnswerDelivery,
  QuestionReading,
} from "@renderer/store/session-events/question-reading.js";

import "./question-card.css";

/** What the row hands a supplied body. */
export interface QuestionCardBodyProps {
  readonly ask: QuestionReading;
  /** Where the answer this card last dispatched has got to. */
  readonly delivery: AnswerDelivery;
  readonly onAnswer: (response: string) => void;
}

/** What a mount hands the input-ask card. */
export interface QuestionCardProps {
  /**
   * A body that replaces the built-in card, or `undefined` while the card draws itself.
   *
   * Required and carrying `undefined` rather than optional, so a mount that forgot it is a
   * compile error at the construction site rather than an absent key that renders
   * identically to a deliberate "none".
   */
  readonly body: ((props: QuestionCardBodyProps) => React.ReactNode) | undefined;
  readonly ask: QuestionReading;
  /**
   * The mount's reading of now, in epoch milliseconds.
   *
   * Supplied rather than read here, so this card constructs no clock and starts no
   * timer: the view that already re-renders on the console's own refresh is what
   * decides how often a countdown moves.
   */
  readonly nowEpochMilliseconds: number;
  /**
   * Where the answer this card last dispatched has got to.
   *
   * Held by the row rather than here, because the dispatch is a wire call and this
   * card constructs none — the same split the countdown makes with the clock.
   */
  readonly delivery: AnswerDelivery;
  /** Deliver an answer on the registered driver answer method. */
  readonly onAnswer: (response: string) => void;
}

/** The ask card: the built-in one, or the supplied `body` when the mount passes one. */
export function QuestionCard(props: QuestionCardProps): React.JSX.Element {
  if (props.body !== undefined) {
    return (
      <div className="meridian-input-ask">
        {props.body({ ask: props.ask, delivery: props.delivery, onAnswer: props.onAnswer })}
      </div>
    );
  }
  const isPending = props.ask.state === "requested";
  return (
    <div className="meridian-input-ask">
      {renderPrompt(props.ask.prompt)}
      {isPending ? (
        <>
          {renderCountdown(props.ask.expiresAt, props.nowEpochMilliseconds)}
          {renderAnswerArms(props.ask, props.delivery, props.onAnswer)}
        </>
      ) : (
        renderTerminal(props.ask)
      )}
    </div>
  );
}

/**
 * The question, or the named absence of one.
 *
 * `prompt` is optional on the wire, so an ask can genuinely arrive without one. The
 * card says so rather than rendering an empty region a reader would take for a paint
 * that did not finish — and rather than composing a question of its own, which would
 * put words in the provider's mouth in the one place where that is unrecoverable.
 */
function renderPrompt(prompt: string | undefined): React.ReactNode {
  if (prompt === undefined) {
    return (
      <Nothing
        kind="empty"
        placement="block"
        title="This ask carried no question."
        detail="The provider blocked on an answer without stating what it was asking."
      />
    );
  }
  return <p className="meridian-input-ask__prompt">{prompt}</p>;
}

/**
 * How long the daemon's stamp leaves, or what the card is doing past it.
 *
 * An unparseable or absent stamp renders as the `not-checked` absence rather than as
 * an expired countdown: a card that showed zero for a row carrying no deadline would
 * be asserting a deadline the daemon never stamped.
 */
function renderCountdown(
  expiresAt: string | undefined,
  nowEpochMilliseconds: number,
): React.ReactNode {
  // THROUGH THE CONSOLE'S OWN READER, which is the one that refuses rather than
  // normalizes: a stamp naming a day that does not exist reads as a NUMBER through
  // the platform parser and would put a countdown on screen against an instant the
  // daemon never sent.
  const reading = expiresAt === undefined ? undefined : parseInstant(expiresAt);
  if (reading === undefined || reading.kind === "malformed") {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="No deadline was stamped on this ask."
        detail="The row carries no expiry, so nothing is counted down here."
      />
    );
  }
  const remaining = reading.epochMilliseconds - nowEpochMilliseconds;
  if (remaining <= 0) {
    return (
      <Nothing
        kind="computing"
        placement="inline"
        title="Waiting for the background service."
        detail="The stamped deadline has passed and this ask has not been settled on the wire yet."
      />
    );
  }
  return (
    <p className="meridian-input-ask__countdown">
      Answer within{" "}
      <span className="meridian-input-ask__remaining">{formatDuration(remaining)}</span>
    </p>
  );
}

/**
 * The option group where one was declared, and the free-text field on every ask.
 *
 * THE DELIVERY IS DRAWN ONCE, BELOW BOTH ARMS, because it is one fact about one ask
 * rather than one per control: an option press and a free-text send travel the same
 * method and produce the same reply, so a reader who pressed either meets the same
 * sentence in the same place. Two renderings would be two vocabularies for one wire.
 */
function renderAnswerArms(
  ask: QuestionReading,
  delivery: AnswerDelivery,
  onAnswer: (response: string) => void,
): React.ReactNode {
  // The two statuses in which no further answer may be dispatched: one is on the wire,
  // or one has already reached the driver. A refusal deliberately leaves the controls
  // live, because a refusal never hides the control that produced it.
  const isSettling = delivery.status === "delivering" || delivery.status === "accepted";
  return (
    <div className="meridian-input-ask__arms">
      {ask.options.length === 0 ? null : (
        <ul className="meridian-input-ask__options" aria-label="the answers this ask offers">
          {ask.options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                className="meridian-input-ask__option meridian-action-button"
                disabled={isSettling}
                onClick={() => {
                  onAnswer(option.value);
                }}
              >
                {option.label === undefined ? null : (
                  <span className="meridian-input-ask__option-label">{option.label}</span>
                )}
                <WireFigure value={option.value} title="The answer this choice delivers" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <TypedAnswerField delivery={delivery} isClosed={isSettling} onAnswer={onAnswer} />
      {renderDelivery(delivery)}
    </div>
  );
}

/**
 * What became of the answer this card dispatched, and nothing about the ask itself.
 *
 * `unsent` renders nothing at all, which is every ask nobody has answered yet. The
 * other three are the console's own report: the call is out, the driver took it, or
 * the call did not land — and the last one is the reason this exists, because a
 * discarded refusal left a blocked run looking like an unanswered question.
 *
 * `accepted` says the card is WAITING and never that the ask is settled: only the
 * `driver_ask.responded` row may say that, and the card reads the ask's state from
 * the row's own event type. The refusal renders inline under the control that was
 * pressed, the console's shape for "nothing changed" — the arms above it stay exactly
 * where they were.
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
          title="The answer reached the driver."
          detail="Waiting for this ask's own row to record it."
        />
      );
    case "refused":
      return <InlineRefusal code={delivery.refusal.code} detail={delivery.refusal.detail} />;
  }
}

/**
 * What the settled row itself says, and nothing more.
 *
 * Each sentence is keyed to the row's own event type. `responded` shows the answer
 * that was delivered — verbatim, in the wire's own figure — and the other two say
 * which of the two things happened, because "expired" and "canceled" are different
 * events with different causes and a card that said only "closed" would collapse them.
 */
function renderTerminal(ask: QuestionReading): React.ReactNode {
  if (ask.state === "responded") {
    return (
      <Nothing
        kind="empty"
        placement="block"
        title="This ask was answered."
        detail="The delivered answer is shown as the background service recorded it."
        {...(ask.deliveredAnswer === undefined
          ? {}
          : { action: <WireFigure value={ask.deliveredAnswer} title="Delivered answer" /> })}
      />
    );
  }
  return (
    <Nothing
      kind="empty"
      placement="block"
      title={
        ask.state === "expired"
          ? "This ask expired before it was answered."
          : "This ask was canceled before it was answered."
      }
      detail="The run's own rows say what happened to it next."
    />
  );
}
