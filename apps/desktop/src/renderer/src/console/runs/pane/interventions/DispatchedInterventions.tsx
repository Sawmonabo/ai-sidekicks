// What THIS window dispatched against one run, and how each call settled.
//
// Its own module because a `.tsx` declares one component. It is the half of the history
// carrying a settlement the durable read does not — the rollback result union and, on
// the three dispositions that carry them, both never-silent file enumerations.

import { InterventionRow } from "./InterventionRow.js";
import { InterventionSourceList } from "./InterventionSourceList.js";
import type { EnumeratedPathAction } from "../controls/enumerated-path-action.js";
import type { RunControlRecord } from "../controls/run-control-surface.js";

/**
 * What THIS window dispatched, and how each call settled.
 *
 * Kept beside the durable rows rather than folded into them: this half carries the
 * settlement the durable read does not — the rollback result union and, on the three
 * dispositions that carry them, both never-silent file enumerations.
 */
export function DispatchedInterventions(props: {
  readonly rows: readonly RunControlRecord[];
  readonly pathAction: EnumeratedPathAction;
}): React.JSX.Element | null {
  if (props.rows.length === 0) {
    return null;
  }
  return (
    <InterventionSourceList caption="Sent from this window, and how each settled">
      {props.rows.map((record) => (
        <InterventionRow key={record.recordId} record={record} pathAction={props.pathAction} />
      ))}
    </InterventionSourceList>
  );
}
