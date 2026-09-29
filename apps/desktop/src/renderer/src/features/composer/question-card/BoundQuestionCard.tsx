// A provider-raised question bound to its answer path, its settlement and its countdown.
//
// Its own component so that only a row that is a question arms this machinery: the answer
// dispatcher, the clock, and a deadline wake-up, which holds a subject-scoped timer. A row
// that is not a question renders something else and arms none of it.
//
// The deadline is one timeout for the soonest instant still ahead, re-asked of the clock at
// every step, so a host that slept moves the wake-up nowhere.

import { useMemo } from "react";
import { useConsoleClock } from "@renderer/services/platform/hooks/useClock.js";
import { parseInstant } from "@renderer/lib/instant.js";
import { useDeadlineWake } from "@renderer/hooks/useDeadlineWake.js";
import {
  applyQuestionSettlement,
  type QuestionReading,
} from "@renderer/store/session-events/question-reading.js";
import { useQuestionSettlement } from "@renderer/store/session-events/hooks/useQuestionSettlement.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { useQuestionAnswer } from "./hooks/useQuestionAnswer.js";
import { InputAskCard } from "./QuestionCard.js";

export interface BoundQuestionCardProps {
  /**
   * The ask this row is blocked on, read off the row by the shell that dispatched here.
   *
   * It carries the run the answer is delivered for, so this row takes no second
   * attribution beside it: the reading and the dispatcher then name one run by
   * construction, and no caller can hand a row an ask belonging to another.
   */
  readonly ask: QuestionReading;
  /** The session the ask belongs to, whose store folds every settlement it admits. */
  readonly sessionStore: SessionStore;
}

/**
 * One provider-raised ask, with the answer path and the countdown it needs.
 *
 * @consumedBy the composer's question card
 */
export function FixtureShellAskRow(props: BoundQuestionCardProps): React.JSX.Element {
  const askAnswer = useQuestionAnswer(props.ask.runId, props.ask.askId);
  const clock = useConsoleClock();
  // THE WINDOW'S ANSWER TO "IS THIS ASK STILL OPEN", not this row's and not this
  // mount's. The row says only what its own event type says, and the delivery state
  // beside it is local to a mount and resets with one — so a request answered from
  // another window, or answered here and then scrolled out and back, kept its controls.
  // The session store folds every settlement; this is the lookup and the merge.
  const askTerminal = useQuestionSettlement(props.sessionStore, props.ask);
  const ask = useMemo(
    () => applyQuestionSettlement(props.ask, askTerminal),
    [props.ask, askTerminal],
  );
  // ARMED ONLY WHILE THE ASK IS OPEN. A settled ask draws no countdown, so a wake-up
  // for its stamped deadline would be a timer this row can never spend.
  const deadlines = useMemo(
    () =>
      ask.state === "requested" ? readQuestionDeadlineMilliseconds(ask.expiresAt) : NO_DEADLINES,
    [ask.expiresAt, ask.state],
  );
  const nowEpochMilliseconds = useDeadlineWake(clock, deadlines);
  return (
    <InputAskCard
      body={undefined}
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
function readQuestionDeadlineMilliseconds(expiresAt: string | undefined): readonly number[] {
  if (expiresAt === undefined) {
    return NO_DEADLINES;
  }
  const reading = parseInstant(expiresAt);
  return reading.kind === "instant" ? [reading.epochMilliseconds] : NO_DEADLINES;
}

/** No deadline at all. One frozen value, so an unreadable stamp allocates none. */
const NO_DEADLINES: readonly number[] = Object.freeze([]);
