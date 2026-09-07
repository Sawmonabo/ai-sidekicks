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
// row's deep import and by nobody else.
//
// AND THE ROW IS WHERE THE PATH ACTION IS BOUND TO ITS OWN RECORD. The list holds
// one action for every row, so the binding has to happen somewhere per row — here,
// where the record's own id is in scope, rather than in the list's map, so the id a
// press is recorded under and the id a refusal is rendered against are read from one
// place and cannot come apart.

import { useCallback } from "react";

import { Chip } from "../../../primitives/index.js";
import { type EnumeratedPathAction } from "../controls/enumerated-path-action.js";
import { InterventionBody } from "./InterventionBody.js";
import { InterventionTerminal } from "./InterventionTerminal.js";
import type { RunControlRecord } from "../controls/run-control-surface.js";

/** One intervention, in the daemon's own figures. */
export function InterventionRow(props: {
  readonly record: RunControlRecord;
  /** The history's one path action, asked about this row alone. */
  readonly pathAction: EnumeratedPathAction;
}): React.JSX.Element {
  const { record, pathAction } = props;
  const { copyPath } = pathAction;
  const recordId = record.recordId;
  const onPathAction = useCallback(
    (path: string) => {
      copyPath(recordId, path);
    },
    [copyPath, recordId],
  );
  return (
    <li className="meridian-interventions__row">
      <div className="meridian-interventions__head">
        <Chip tone="neutral" label={record.control} mono />
        <InterventionTerminal record={record} />
      </div>
      <InterventionBody
        record={record}
        onPathAction={onPathAction}
        pathActionRefusal={
          pathAction.refusal?.sourceId === recordId ? pathAction.refusal.refusal : undefined
        }
      />
    </li>
  );
}
