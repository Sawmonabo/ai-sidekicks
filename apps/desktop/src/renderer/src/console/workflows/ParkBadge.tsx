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
//   • **The armed schedule is what separates the kinds of park, and the badge is
//     handed that reading rather than making it.** With a READABLE `autoResumeAt`
//     the machine will pick the run back up and nobody is being asked for anything;
//     without one, the wait ends when a person ends it. The badge used to decide
//     that on `autoResumeAt === undefined`, which put a present-but-malformed
//     instant on the scheduled branch and rendered "Scheduled to resume at —": a
//     promise with no time in it, made about a value the projection had already
//     classified as unreadable. It now takes the projected parked phase, so the
//     classification has exactly one home and the tone follows it.
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
import type {
  WorkflowParkedPhase,
  WorkflowParkReason,
  WorkflowParkSchedule,
} from "./run-list-projection.js";

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
 * What ends the wait, when nothing is scheduled to.
 *
 * Total over the closed reason set, so a third reason is a compile error here rather
 * than a phase that parks and is told the wrong way out. One sentence per reason
 * because the ways out are genuinely different: a human phase advances when the
 * participant submits the form the run pane mounts for exactly this phase, so telling
 * that operator to reach for a run control points them away from the act the engine
 * is waiting on. A usage-limit park with no reported reset boundary really does wait
 * for an operator.
 */
const UNSCHEDULED_PARK_REMEDIES: Readonly<Record<WorkflowParkReason, string>> = {
  "waiting-human":
    "Nothing is scheduled to lift this. It ends when a participant fills in and submits this phase's form.",
  "provider-usage-limited":
    "No reset boundary was reported, so nothing lifts this on its own. It waits until a run control does.",
};

/**
 * The tone a park wears, decided by whether anything will end the wait on its own.
 *
 * Amber is spent on "a person is needed" and on nothing else (`Spec-023 §Console
 * Design (Meridian)` rule 3), which is every park that did not arm a boundary this
 * console can read. A scheduled park is a machine waiting for a machine and earns no
 * colour; an unreadable boundary earns the amber, because nothing legible says the
 * run will resume itself.
 */
function parkTone(schedule: WorkflowParkSchedule): ChipTone {
  return schedule.kind === "armed" ? "neutral" : "attention";
}

/** What the badge says about the end of the wait, for one classified schedule. */
function ParkSchedule(props: {
  readonly schedule: WorkflowParkSchedule;
  readonly parkReason: WorkflowParkReason;
}): React.JSX.Element {
  const { schedule } = props;
  if (schedule.kind === "armed") {
    return (
      <p className="meridian-park__schedule">
        Scheduled to resume at{" "}
        <WireFigure value={formatClockTime(schedule.autoResumeAt)} title={schedule.autoResumeAt} />
      </p>
    );
  }
  return (
    <p className="meridian-park__schedule">
      {UNSCHEDULED_PARK_REMEDIES[props.parkReason]}
      {schedule.kind === "unreadable" ? (
        // The malformed value is shown rather than swallowed. It is the only evidence
        // a daemon armed something, and a badge that dropped it would report this park
        // as identical to one that armed nothing at all.
        <span className="meridian-park__unreadable">
          {" "}
          The engine sent a resume instant this console could not read:{" "}
          <WireFigure value={schedule.autoResumeAt} />
        </span>
      ) : null}
    </p>
  );
}

export interface ParkBadgeProps {
  /**
   * The parked phase as the projection classified it — never the raw park.
   *
   * The badge reads `schedule` and does not re-derive it. A component handed the
   * four wire members would have to apply the discriminator and the readability rule
   * itself, which is the second authority that produced "Scheduled to resume at —".
   */
  readonly parked: WorkflowParkedPhase;
}

/** One parked phase's reason, what ends its wait, and the engine's own cause. */
export function ParkBadge(props: ParkBadgeProps): React.JSX.Element {
  const { park, schedule } = props.parked;
  return (
    <div className="meridian-park">
      <div className="meridian-park__head">
        <Chip
          tone={parkTone(schedule)}
          glyph={schedule.kind === "armed" ? "clock" : "member"}
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
        {props.parked.phaseName === undefined ? null : (
          <span className="meridian-park__phase">{props.parked.phaseName}</span>
        )}
      </div>
      <p className="meridian-park__cause">{park.parkCause}</p>
      <ParkSchedule schedule={schedule} parkReason={park.parkReason} />
    </div>
  );
}
