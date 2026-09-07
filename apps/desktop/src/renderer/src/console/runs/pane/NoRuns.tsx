// What the runs pane says when the read came back with no runs.
//
// Split from `RunsPane.tsx` so the pane's one job — mounting the body against a
// session — is not read through three absence cases.
//
// AN EMPTY LIST AND AN UNREAD LIST ARE DIFFERENT SENTENCES. `hasRead` is what
// separates them, and the refusal that closed the stream is carried rather than
// paraphrased, because "no runs" over a stream nobody could open is a claim this
// surface has no standing to make.
//
// AND THE EMPTY ARM CARRIES THE ACT IT NAMES. Telling a person to send a message and
// then leaving them to find the line themselves is the failure mode an empty state
// has: the sentence is right and the surface is inert. The control puts the caret in
// the composer through `seats/composer-focus.ts` — an ASK and not a handle, so this
// family names no part of the composer's own tree — and it is offered on exactly the
// arm whose sentence names the act. The two absence arms above it offer nothing,
// because neither says a run could be started right now.
//
// WHETHER IT IS OFFERED IS `run-start-offer.ts`'s ANSWER AND NOT THIS FILE'S. The
// same act is reachable from the command palette, and an offer rule spelled out here
// and again in the pane's contribution is one rule with two authors. This component
// renders the arm; the predicate decides the act.

import { type ConsoleRefusal } from "../../core/index.js";
import { InlineRefusal, Nothing } from "../../primitives/index.js";
import {
  RUN_START_ACTION_LABEL,
  offersRunStart,
  type RunStartOfferReading,
} from "./run-start-offer.js";

/**
 * Two different absences, told apart by whether the read that says WHICH RUNS EXIST
 * has completed — and, ahead of both, the refusal that says the stream was never
 * opened.
 *
 * Reached only when the seating produced no row at all, which is now the exact
 * condition under which the session knows of no run and the stream has projected
 * none. `empty` is the arm once the snapshot has landed, and `not-loaded` the arm
 * before it: a session whose snapshot names runs seats rows for them and never
 * arrives here, which is what retires the skeleton that used to outlive every
 * terminal pre-existing run.
 */
export function NoRuns(props: {
  /** The whole reading, so the arm shown and the act offered are one decision. */
  readonly reading: RunStartOfferReading;
  /** Put the caret where the sentence points. Offered on the empty arm only. */
  readonly onStart: () => void;
}): React.JSX.Element {
  const openRefusal: ConsoleRefusal | undefined = props.reading.openRefusal;
  if (openRefusal !== undefined) {
    return <InlineRefusal code={openRefusal.code} detail={openRefusal.detail} />;
  }
  if (!props.reading.hasRead) {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading the runs in this session." />
    );
  }
  return (
    <Nothing
      kind="empty"
      placement="surface"
      title="No run has started in this session yet."
      detail="Send a message to an agent and its run appears here with its status, its queue, and every intervention raised against it."
      action={
        offersRunStart(props.reading) ? (
          <button type="button" className="meridian-runs__start" onClick={props.onStart}>
            {RUN_START_ACTION_LABEL}
          </button>
        ) : undefined
      }
    />
  );
}
