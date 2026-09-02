// A parked phase, said in one line: why it stopped, and whether it will start again
// on its own.
//
// The badge exists because a park is the state an operator is most likely to be
// looking at and least able to explain from a status word alone
// (`Spec-017 §Park surfacing on the read model (SA-44)`). Two rules shape it:
//
//   • **A park is read from `parkReason`, never from a phase's `state`.** The
//     phase-run status union has five values and no suspended arm; the park rides
//     four live-scoped members beside it. This component therefore takes a
//     `WorkflowPhasePark` — a value that exists only when there IS a park — so the
//     discriminator is applied once, in the projection, and never re-derived here.
//   • **The armed schedule is what separates the two kinds of park.** With an
//     `autoResumeAt` the machine will pick the run back up, and nobody is being
//     asked for anything; without one, the wait ends when a person ends it. The
//     tones follow that distinction rather than the reason, which is why a
//     usage-limited park with a reset boundary is quiet and the same park without
//     one is not.
//
// THE CAUSE IS THE ENGINE'S SENTENCE AND IS RENDERED VERBATIM. It is bounded and
// truncated at its source, and it is prose rather than a figure — so it renders as
// prose, not in mono, on the same reasoning that keeps a daemon's refusal message
// out of the mono column while its code stays in it.
//
// NOTHING HERE IS A CONTROL. Resuming, cancelling, and re-pinning are daemon
// adjudications; this says what is true, and the surface that offers an action
// renders the daemon's typed refusal when the daemon declines it.

import { Chip, WireFigure, formatClockTime, type ChipTone } from "../primitives/index.js";
import type { WorkflowPhasePark, WorkflowParkReason } from "./run-list-projection.js";

/**
 * What each reason is called on screen.
 *
 * Total over the closed reason set, so a third reason is a compile error here
 * rather than a phase that parks and says nothing. The labels are the console's
 * prose — the wire value is `waiting-human`, and a person reading a list wants the
 * sentence — so they are NOT mono and the wire string travels in the badge's title.
 */
const PARK_REASON_LABELS: Readonly<Record<WorkflowParkReason, string>> = {
  "waiting-human": "Waiting on a person",
  "provider-usage-limited": "Waiting on provider capacity",
};

/**
 * The tone a park wears, decided by whether anything will end the wait on its own.
 *
 * Amber is spent on "a person is needed" and on nothing else (`Spec-023 §Console
 * Design (Meridian)` rule 3), which is exactly the unscheduled park: no armed
 * boundary means the run waits until someone resumes it. A scheduled park is a
 * machine waiting for a machine and earns no colour.
 */
function parkTone(park: WorkflowPhasePark): ChipTone {
  return park.autoResumeAt === undefined ? "attention" : "neutral";
}

export interface ParkBadgeProps {
  readonly park: WorkflowPhasePark;
  /** The phase that is parked, when the badge is shown away from its own row. */
  readonly phaseName?: string | undefined;
}

/** One parked phase's reason, its armed resume if it has one, and the cause. */
export function ParkBadge(props: ParkBadgeProps): React.JSX.Element {
  const { park } = props;
  return (
    <div className="meridian-park">
      <div className="meridian-park__head">
        <Chip
          tone={parkTone(park)}
          glyph={park.autoResumeAt === undefined ? "member" : "clock"}
          label={PARK_REASON_LABELS[park.parkReason]}
        />
        {/*
          The reason's own wire value, beside the sentence rather than instead of
          it. Rule 4's provenance signature belongs on the string the daemon sent;
          the label above is the console's reading of it, and showing only one of
          the two would either hide what a person pastes into a search or turn the
          badge into a row of enum values.
        */}
        <WireFigure value={park.parkReason} />
        {props.phaseName === undefined ? null : (
          <span className="meridian-park__phase">{props.phaseName}</span>
        )}
      </div>
      <p className="meridian-park__cause">{park.parkCause}</p>
      {park.autoResumeAt === undefined ? (
        <p className="meridian-park__schedule">
          Nothing is scheduled to lift this. It waits until a run control does.
        </p>
      ) : (
        <p className="meridian-park__schedule">
          Scheduled to resume at{" "}
          <WireFigure value={formatClockTime(park.autoResumeAt)} title={park.autoResumeAt} />
        </p>
      )}
    </div>
  );
}
