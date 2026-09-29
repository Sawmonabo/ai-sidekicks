// What a park badge says about the end of the wait, for one classified schedule.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN `ParkBadge.tsx`, which is the package's
// one-component-per-`.tsx` rule: a module holding three components is a module whose
// name answers for one of them, and the other two are reached only by reading the
// file. The badge imports it by relative path and the feature's `index.ts` does not
// export it, because nothing outside the workflows feature composes it.
//
// THE UNSCHEDULED REMEDIES TRAVEL WITH IT. That table has exactly one reader and it is
// the component below; a remedy sentence in one module and the only line that renders
// it in another is a closed set split across two files.

import { WireFigure, formatDateTime } from "@renderer/console/primitives/index.js";
import type { WorkflowParkReason, WorkflowParkSchedule } from "../runs/run-list-rows.js";

/**
 * What ends the wait, when nothing is scheduled to.
 *
 * Total over the closed reason set, so a third reason is a compile error here rather
 * than a phase that parks and is told the wrong way out. One sentence per reason
 * because the ways out are genuinely different: a human phase advances when the
 * user submits the form the run pane mounts for exactly this phase, so telling
 * that operator to reach for a run control points them away from the act the engine
 * is waiting on. A usage-limit park with no reported reset boundary really does wait
 * for an operator.
 */
const UNSCHEDULED_PARK_REMEDIES: Readonly<Record<WorkflowParkReason, string>> = {
  "waiting-human":
    "Nothing is scheduled to lift this. It ends when a user fills in and submits this phase's form.",
  "provider-usage-limited":
    "No reset boundary was reported, so nothing lifts this on its own. It waits until a run control does.",
};

/**
 * What the badge says about the end of the wait, for one classified schedule.
 *
 * THE ARMED INSTANT CARRIES ITS DATE. A badge stands wherever a parked phase does —
 * in a run row, in the run pane's stack of cards — and none of those places carries a
 * day divider, which is the only thing that makes the transcript's date-free reading
 * unambiguous. In that reading a resume armed for tomorrow morning and one armed for
 * next week's would be the same four digits on screen, with the wire instant behind
 * them reachable only by hovering. `formatDateTime`
 * is the figure chokepoint's reading for exactly this position.
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
