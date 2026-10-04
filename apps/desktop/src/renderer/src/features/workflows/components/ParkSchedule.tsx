// What a park badge says about the end of the wait, for one classified schedule. A sibling of
// `ParkBadge.tsx` (one component per `.tsx`) that owns the unscheduled remedies, whose only
// reader is here.

import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatDateTime } from "@renderer/lib/wire-figures.js";
import type { WorkflowParkReason, WorkflowParkSchedule } from "../runs/run-list-rows.js";

/**
 * What ends the wait when nothing is scheduled to. Total over the closed reason set, so a new
 * reason is a compile error. The ways out differ: a human phase advances when the user submits
 * its form, not through a run control.
 */
const UNSCHEDULED_PARK_REMEDIES: Readonly<Record<WorkflowParkReason, string>> = {
  "waiting-human":
    "Nothing is scheduled to lift this. It ends when a user fills in " +
    "and submits this phase's form.",
  "provider-usage-limited":
    "No reset boundary was reported, so nothing lifts this on its " +
    "own. It waits until a run control does.",
};

/**
 * What the badge says about the end of the wait, for one classified schedule. The armed instant
 * carries its date because a badge stands where no day divider disambiguates a bare time.
 */
export function ParkSchedule(props: {
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
        // The malformed value is shown, not swallowed: it is the only evidence a daemon armed
        // something.
        <span className="meridian-park__unreadable">
          {" "}
          The engine sent a resume instant this console could not read:{" "}
          <WireFigure value={schedule.autoResumeAt} />
        </span>
      ) : null}
    </p>
  );
}
