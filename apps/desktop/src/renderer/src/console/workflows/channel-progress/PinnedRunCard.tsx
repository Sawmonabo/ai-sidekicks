// What a pinned channel run looks like, once there is one to draw.
//
// Split from the card beside it on the seam the console holds everywhere: that module
// performs the read and decides whether anything is pinned, and this one draws what it
// decided. The split is also what makes the drawing testable without a bridge — a
// component that both read and drew could only be exercised through a provider, and
// every claim about what is on screen would be carrying a fixture it does not need.
//
// The two figures and the park readings are the whole of it. Nothing here reads a
// wire, nothing here decides eligibility, and the park badge is the one the run pane
// draws, so a park never reads two ways in one window.

import { Chip, WireFigure } from "../../primitives/index.js";
import { ParkBadge } from "../parks/ParkBadge.js";
import { type ChannelWorkflowProgress } from "./channel-progress.js";

export interface PinnedRunCardProps {
  readonly progress: ChannelWorkflowProgress;
  /**
   * Open the run's own pane, where the card was given a way to.
   *
   * Absent draws no button rather than a disabled one — `seats/pane-controls.ts`'
   * absent-not-disabled rule, which this card is downstream of: the eligibility was
   * decided by the module that composed this callback, and nothing here re-derives it.
   */
  readonly onOpenRun?: (() => void) | undefined;
}

/** The channel's pinned run: what it is, how far it has got, and what it waits on. */
export function PinnedRunCard(props: PinnedRunCardProps): React.JSX.Element {
  const { row, completedPhaseCount, totalPhaseCount } = props.progress;
  const { onOpenRun } = props;
  return (
    <article className="meridian-channel-progress">
      <div className="meridian-channel-progress__head">
        {/*
          The definition's name where the enumeration carried one, and the run's own
          identifier always — rule 4's provenance signature on the wire figure, and the
          console's prose beside it. The name is optional on the row for the reason
          `runs/run-list-rows.ts` gives, so a card that showed only a name would show
          nothing for a run read that carried none.
        */}
        {row.run.definitionName === undefined ? null : (
          <span className="meridian-channel-progress__definition">{row.run.definitionName}</span>
        )}
        <WireFigure value={row.run.workflowRunId} />
        {/*
          The run's own state word, as the wire spells it. Neutral always: the amber in
          this card belongs to a park that is waiting on a person, and a second thing
          wearing attention beside it would spend the palette's one loud mark twice for
          one situation (`Spec-023 §Console Design (Meridian)` rule 3).
        */}
        <Chip tone="neutral" glyph="workflow" label={row.run.state} />
      </div>
      {/*
        Completed of known, and both numbers on screen. A bar or a percentage would
        hide the denominator, and this one moves: the phase list is what the run read
        carried when it answered, so a fan-out that adds phases changes what "of" means
        and a person can see that it did.
      */}
      <p className="meridian-channel-progress__phases">
        {`${String(completedPhaseCount)} of ${String(totalPhaseCount)} phases completed`}
      </p>
      {row.parkedPhases.map((parked) => (
        <ParkBadge key={parked.phaseId} parked={parked} />
      ))}
      {/*
        Its own class and not the family's `meridian-workflow__action`, which the run
        list, the definitions browser and the pane host's back control all wear. That
        class is declared in `workflows.css`, which rides this family's three chunks —
        and this card is the one thing the family draws on the FIRST paint, so wearing it
        left a bare user-agent button above the timeline until some workflows body
        happened to load. `channel-progress.css` restates the treatment and says why.
        Named for the destination and not for the gesture — a person reads where it goes,
        not that it is a link.
      */}
      {onOpenRun === undefined ? null : (
        <button type="button" className="meridian-channel-progress__route" onClick={onOpenRun}>
          Open the run
        </button>
      )}
    </article>
  );
}
