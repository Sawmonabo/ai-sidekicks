// The input-ask card: the provider's question, in the ledger, where it was asked.
//
// THE SHELL AND ITS DEATH NOTICE. The body an ask row eventually renders is the
// timeline plan's, absorbed by import — so this file is a slot with a shell behind
// it, and the change that authors the real body deletes the shell. `input-ask.ts`
// carries the three facts that arrangement owes and the reading this card renders.
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
// THE COUNTDOWN DISPLAYS A STAMP AND SETTLES NOTHING. The remaining interval is
// computed from the daemon's stamped deadline against a clock the MOUNT supplies —
// this card holds no timer, starts no interval, and reaches zero without changing
// the ask's state. At zero it says the surface is waiting for the daemon, which is a
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

import { parseInstant } from "../../../core/index.js";
import { Nothing, WireFigure, formatDuration } from "../../../primitives/index.js";
import type { OwnerSlotProps } from "../../../seats/index.js";
import { AskFreeTextArm } from "./AskFreeTextArm.js";
import type { DriverAskReading } from "./input-ask.js";

/** What the row hands the body the timeline plan authors. */
export interface InputAskBodyProps {
  readonly ask: DriverAskReading;
  readonly onAnswer: (response: string) => void;
}

export interface InputAskCardProps {
  /**
   * The plan-owned body's slot. Required and carrying `undefined` rather than
   * optional, so a mount that forgot the slot is a compile error at the construction
   * site rather than an absent key that renders identically to an unfilled one.
   */
  readonly slot: OwnerSlotProps<(props: InputAskBodyProps) => React.ReactNode>;
  readonly ask: DriverAskReading;
  /**
   * The mount's reading of now, in epoch milliseconds.
   *
   * Supplied rather than read here, so this card constructs no clock and starts no
   * timer: the surface that already re-renders on the console's own refresh is what
   * decides how often a countdown moves.
   */
  readonly nowEpochMilliseconds: number;
  /** Deliver an answer on the registered driver answer method. */
  readonly onAnswer: (response: string) => void;
}

export function InputAskCard(props: InputAskCardProps): React.JSX.Element {
  if (props.slot.body !== undefined) {
    return (
      <div className="meridian-input-ask">
        {props.slot.body({ ask: props.ask, onAnswer: props.onAnswer })}
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
          {renderAnswerArms(props.ask, props.onAnswer)}
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
 * put words in the provider's mouth on the one surface where that is unrecoverable.
 */
function renderPrompt(prompt: string | undefined): React.ReactNode {
  if (prompt === undefined) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="This ask carried no question."
        detail="The provider blocked on an answer without stating what it was asking."
      />
    );
  }
  return <p className="meridian-input-ask__prompt">{prompt}</p>;
}

/**
 * How long the daemon's stamp leaves, or what the surface is doing past it.
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
        title="Waiting for the daemon."
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

/** The option group where one was declared, and the free-text field on every ask. */
function renderAnswerArms(
  ask: DriverAskReading,
  onAnswer: (response: string) => void,
): React.ReactNode {
  return (
    <div className="meridian-input-ask__arms">
      {ask.options.length === 0 ? null : (
        <ul className="meridian-input-ask__options" aria-label="the answers this ask offers">
          {ask.options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                className="meridian-input-ask__option"
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
      <AskFreeTextArm askId={ask.askId} onAnswer={onAnswer} />
    </div>
  );
}

/**
 * What the settled row itself says, and nothing more.
 *
 * Each sentence is keyed to the row's own event type. `responded` shows the answer
 * that was delivered — verbatim, in the wire's own figure — and the other two say
 * which of the two things happened, because "expired" and "canceled" are different
 * events with different causes and a card that said only "closed" would collapse them.
 */
function renderTerminal(ask: DriverAskReading): React.ReactNode {
  if (ask.state === "responded") {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="This ask was answered."
        detail="The delivered answer is shown as the daemon recorded it."
        {...(ask.deliveredAnswer === undefined
          ? {}
          : { action: <WireFigure value={ask.deliveredAnswer} title="Delivered answer" /> })}
      />
    );
  }
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title={
        ask.state === "expired"
          ? "This ask expired before it was answered."
          : "This ask was canceled before it was answered."
      }
      detail="The run's own rows say what happened to it next."
    />
  );
}
