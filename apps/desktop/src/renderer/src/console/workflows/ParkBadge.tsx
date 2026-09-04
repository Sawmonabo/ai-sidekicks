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
// NOTHING HERE ADJUDICATES. Resuming, cancelling, and re-pinning are the daemon's
// decisions; this says what is true, and the surface that offers one of those actions
// renders the daemon's typed refusal when the daemon declines it.
//
// THE ONE CONTROL THIS CARD CARRIES IS A ROUTE AND NOT A DECISION. A phase waiting on
// a person ends when that person submits ITS form, and this card is where the sentence
// saying so is drawn — so when the surface mounting the card can open that form, the
// route to it belongs here rather than somewhere else on the surface. It is optional
// and absent by default: the run list renders the same card for a phase in another
// pane's run and has nowhere to send anybody.

import { Chip, WireFigure, formatDateTime, type ChipTone } from "../primitives/index.js";
import { parkAwaitsPerson } from "./run-list-projection.js";
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
 *
 * The reading itself is `parkAwaitsPerson`'s and is not made here. The phase graph
 * beside this badge draws the SAME phase and spends the same amber on it, and a badge
 * that decided for itself is how one park came to read as needing nobody in a card
 * and as needing somebody on the node above it.
 */
function parkTone(schedule: WorkflowParkSchedule): ChipTone {
  return parkAwaitsPerson(schedule) ? "attention" : "neutral";
}

/**
 * What the badge says about the end of the wait, for one classified schedule.
 *
 * THE ARMED INSTANT CARRIES ITS DATE. A badge stands wherever a parked phase does —
 * in a run row, in the run pane's stack of cards — and none of those places carries a
 * day divider, which is the only thing that makes the ledger's date-free reading
 * unambiguous. This surface used to render that reading, so a resume armed for
 * tomorrow morning and one armed for next week's were the same four digits on screen,
 * and the wire instant behind them was reachable only by hovering. `formatDateTime`
 * is the figure chokepoint's reading for exactly this position.
 */
function ParkSchedule(props: {
  readonly schedule: WorkflowParkSchedule;
  readonly parkReason: WorkflowParkReason;
}): React.JSX.Element {
  const { schedule } = props;
  if (schedule.kind === "armed") {
    return (
      <p className="meridian-park__schedule">
        Scheduled to resume at{" "}
        <WireFigure value={formatDateTime(schedule.autoResumeAt)} title={schedule.autoResumeAt} />
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

/**
 * How this card reaches the form that ends its wait, where the caller can offer one.
 *
 * Three arms because the operator's next move differs: press this to answer the phase,
 * nothing to press because this phase's form is already the one open, and nothing to
 * press because the run did not report the handle it would be answered through. A
 * boolean plus a detail string would collapse the last two, and they are the difference
 * between "you are already here" and "this cannot be answered from this build".
 */
export type WorkflowParkFormRoute =
  | { readonly kind: "openable"; readonly openForm: () => void }
  | { readonly kind: "open" }
  | { readonly kind: "unaddressable"; readonly detail: string };

/** The route's own line: a control, or the sentence saying why there is none. */
function ParkFormRoute(props: { readonly route: WorkflowParkFormRoute }): React.JSX.Element {
  const { route } = props;
  if (route.kind === "openable") {
    return (
      <button type="button" className="meridian-park__form-action" onClick={route.openForm}>
        Open this phase&apos;s form
      </button>
    );
  }
  return (
    <p className="meridian-park__form-state">
      {route.kind === "open" ? "This phase\u2019s form is open below." : route.detail}
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
  /**
   * The route to this phase's form, where the surface mounting the card holds one.
   *
   * Absent, not disabled, and absent is the ordinary case: the run list draws this
   * card for phases of runs it does not host, and a control there would point nowhere.
   */
  readonly formRoute?: WorkflowParkFormRoute;
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
        {/*
          The phase this card is about, on exactly the same terms one line up: the
          console's prose where a name was authored, and the wire's own identifier
          always, in the mono signature rule 4 gives a wire-true figure.

          The identifier is unconditional because the name is not. The run READ that
          feeds the pane's stack of cards carries no phase name at all — the authored
          name lives on the definition body, which no read reachable from this build
          serves — so a card that showed only a name showed nothing, and two
          `waiting-human` parks from one fan-out read identically. The caller used to
          paper over that by passing the id INTO the name slot, which put an opaque
          key on screen in the face and weight of something a person had chosen.
        */}
        <span className="meridian-park__phase">
          {props.parked.phaseName === undefined ? null : (
            <span className="meridian-park__phase-name">{props.parked.phaseName}</span>
          )}
          <WireFigure value={props.parked.phaseId} />
        </span>
      </div>
      <p className="meridian-park__cause">{park.parkCause}</p>
      <ParkSchedule schedule={schedule} parkReason={park.parkReason} />
      {props.formRoute === undefined ? null : <ParkFormRoute route={props.formRoute} />}
    </div>
  );
}
