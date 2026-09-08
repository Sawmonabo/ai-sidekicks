// The ask row's own component, and the reason it is one.
//
// A HOOK ARMED ON EVERY ROW IS PAID FOR BY EVERY ROW. The shell used to call the
// answer dispatcher, the clock, and the deadline wake in its own body — under a
// comment saying the rules of hooks left it no choice — and then branch to the ask
// card. The rules of hooks say a COMPONENT may not call a hook conditionally; they
// say nothing about which component renders. So the machinery an ask needs lives in
// the component that draws an ask, and a row that is not one arms none of it.
//
// WHAT THAT COST, MEASURED. `useDeadlineWake` holds a subject-scoped holder with its
// own emitter and disposal, a ref, and an effect, and every mounted row was building
// one to hand it an empty deadline list. On a mounted window that is one holder per
// row per mount, re-created on every navigation back into the pane — the frame time a
// streaming lane spends and the heap a console left open keeps, both for a countdown
// almost no row has.
//
// THE DEADLINE IS STILL THE CONSOLE'S ONE WAKE-UP, unchanged: one timeout for the
// soonest instant still ahead, re-asked of the clock at every step so a host that
// slept moves the wake-up nowhere.

import { useMemo } from "react";

import { useConsoleClock } from "../../../bridge/index.js";
import { parseInstant } from "../../../core/index.js";
import { useDeadlineWake } from "../../../store/index.js";
import {
  INPUT_ASK_SLOT,
  InputAskCard,
  askSettledBy,
  useLedgerAskTerminal,
  type DriverAskReading,
} from "../bodies/index.js";
import { useDriverAskAnswer } from "./shell-row-reads.js";
import type { RunId } from "@ai-sidekicks/contracts";

export interface FixtureShellAskRowProps {
  /** The ask this row is blocked on, read off the row by the shell that dispatched here. */
  readonly ask: DriverAskReading;
  /** The run the answer is delivered for, or `undefined` where the row attributes none. */
  readonly attributedRunId: RunId | undefined;
}

/** One provider-raised ask, with the answer path and the countdown it needs. */
export function FixtureShellAskRow(props: FixtureShellAskRowProps): React.JSX.Element {
  const askAnswer = useDriverAskAnswer(props.attributedRunId, props.ask.askId);
  const clock = useConsoleClock();
  // THE WINDOW'S ANSWER TO "IS THIS ASK STILL OPEN", not this row's and not this
  // mount's. The row says only what its own event type says, and the delivery state
  // beside it is local to a mount and resets with one — so a request answered from
  // another window, or answered here and then scrolled out and back, kept its controls.
  // The fold is the ledger's row model's; this is the lookup and the merge.
  const askTerminal = useLedgerAskTerminal(props.ask.askId);
  const ask = useMemo(() => askSettledBy(props.ask, askTerminal), [props.ask, askTerminal]);
  // ARMED ONLY WHILE THE ASK IS OPEN. A settled ask draws no countdown, so a wake-up
  // for its stamped deadline would be a timer this row can never spend.
  const deadlines = useMemo(
    () => (ask.state === "requested" ? askDeadlineMillisecondsOf(ask.expiresAt) : NO_DEADLINES),
    [ask.expiresAt, ask.state],
  );
  const nowEpochMilliseconds = useDeadlineWake(clock, deadlines);
  return (
    <InputAskCard
      slot={{ contract: INPUT_ASK_SLOT, body: undefined }}
      ask={ask}
      nowEpochMilliseconds={nowEpochMilliseconds}
      delivery={askAnswer.delivery}
      onAnswer={askAnswer.answer}
    />
  );
}

/**
 * One ask's deadline as a wake-up list, or none.
 *
 * Read through the console's own instant reader, which is the reader the card uses
 * for the same stamp — so the row that arms a wake-up and the card that counts one
 * down can never disagree about whether a stamp is readable. A stamp neither can
 * read arms nothing rather than firing a timer forever, and the card renders it as
 * the named absence it is.
 */
function askDeadlineMillisecondsOf(expiresAt: string | undefined): readonly number[] {
  if (expiresAt === undefined) {
    return NO_DEADLINES;
  }
  const reading = parseInstant(expiresAt);
  return reading.kind === "instant" ? [reading.epochMilliseconds] : NO_DEADLINES;
}

/** No deadline at all. One frozen value, so an unreadable stamp allocates none. */
const NO_DEADLINES: readonly number[] = Object.freeze([]);
