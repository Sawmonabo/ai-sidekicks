// A parked phase in one line: why it stopped, and whether it will start again on its own.
// The badge takes the projection's classified schedule rather than re-deriving it from
// `autoResumeAt`, which would render "Scheduled to resume at —" for a malformed instant.
// The cause is the engine's sentence, verbatim. The one control is a route to the phase's form.

import "./ParkBadge.css";

import { Chip } from "@renderer/components/Chip/Chip.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { ParkFormRoute, type WorkflowParkFormRoute } from "./ParkFormRoute.js";
import { PARK_REASON_LABELS, parkAttentionTone } from "../park-presentation.js";
import { ParkSchedule } from "./ParkSchedule.js";
import { parkAwaitsPerson } from "../runs/run-list-rows.js";
import type { WorkflowParkedPhase } from "../runs/run-list-rows.js";

/** A parked phase as the projection classified it, and the route to its form if any. */
export interface ParkBadgeProps {
  /** The badge reads `schedule` and never re-derives it from the raw park. */
  readonly parked: WorkflowParkedPhase;
  /** Absent, not disabled, when the view holds none: the run list draws runs it does not host. */
  readonly formRoute?: WorkflowParkFormRoute;
}

/** One parked phase's reason, what ends its wait, and the engine's own cause. */
export function ParkBadge(props: ParkBadgeProps): React.JSX.Element {
  const { park, schedule } = props.parked;
  return (
    <div className="meridian-park">
      <div className="meridian-park__head">
        <Chip
          // The reading is `parkAwaitsPerson`'s and the tone `park-presentation.ts`'s, so this
          // badge and the run list's attention fold spend amber on the same answer.
          tone={parkAttentionTone(parkAwaitsPerson(schedule))}
          glyph={schedule.kind === "armed" ? "clock" : "alert"}
          label={PARK_REASON_LABELS[park.parkReason]}
        />
        {/*
          The reason's wire value beside the label: the label alone hides what a person pastes
          into a search, and the wire value alone is a row of enum values.
        */}
        <WireFigure value={park.parkReason} />
        {/*
          The phase's authored name where there is one, and its wire identifier always: no
          registered read carries a phase name, so two `waiting-human` parks from one fan-out
          would otherwise read alike. The id is never passed as the name.
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
