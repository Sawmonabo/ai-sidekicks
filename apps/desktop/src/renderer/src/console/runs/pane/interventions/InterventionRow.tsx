// One intervention, as the run's history shows it.
//
// Split from `InterventionHistory.tsx`, which owns the list — what is in it, in
// what order — while this owns one entry and the two readings it carries: how the
// intervention settled, and what it actually said.
//
// THE TERMINAL AND THE BODY TRAVEL WITH THE ROW because neither is read anywhere
// else, and a settlement rendered apart from the directive it settled is two halves
// of one record a reader has to reassemble. They are siblings rather than three
// components in this file: a `.tsx` declares one, and the two are reached by this
// row's deep import and by nothing else.

import { Chip } from "../../../primitives/index.js";
import type { ConsoleRefusal } from "../../../core/index.js";
import { InterventionBody } from "./InterventionBody.js";
import { InterventionTerminal } from "./InterventionTerminal.js";
import type { RunControlRecord } from "../controls/run-control-surface.js";

/** One intervention, in the daemon's own figures. */
export function InterventionRow(props: {
  readonly record: RunControlRecord;
  /** Threaded to the settlement's file half; the list above owns the action. */
  readonly onPathAction: ((path: string) => void) | undefined;
  readonly pathActionRefusal: ConsoleRefusal | undefined;
}): React.JSX.Element {
  const { record } = props;
  return (
    <li className="meridian-interventions__row">
      <div className="meridian-interventions__head">
        <Chip tone="neutral" label={record.control} mono />
        <InterventionTerminal record={record} />
      </div>
      <InterventionBody
        record={record}
        onPathAction={props.onPathAction}
        pathActionRefusal={props.pathActionRefusal}
      />
    </li>
  );
}
