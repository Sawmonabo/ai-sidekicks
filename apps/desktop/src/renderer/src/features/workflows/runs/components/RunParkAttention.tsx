// What this session is waiting on, counted once per cause rather than once per run. The engine
// stamps every phase parked against one provider account with the same `parkAttentionKey`, so six
// runs on one spent account fold into one entry. It derives nothing and gates no control: the
// fold, counts and tone arrive from `run-list-projection.ts`, and refusals are the daemon's.

import { Chip } from "@renderer/components/Chip/Chip.js";
import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { ParkBadge } from "../../components/ParkBadge.js";
import { PARK_REASON_LABELS, parkAttentionTone } from "../../park-presentation.js";
import type { WorkflowParkAttentionEntry, WorkflowFoldedParks } from "../park-attention-fold.js";

/** The attention entries the projection folded from the session's parked runs. */
export interface RunParkAttentionProps {
  readonly entries: readonly WorkflowParkAttentionEntry[];
}

/** Every live wait, folded where the engine correlated it. Nothing where none is. */
export function RunParkAttention(props: RunParkAttentionProps): React.JSX.Element | null {
  if (props.entries.length === 0) {
    // Nothing waiting is the healthy state; a permanent empty panel would be furniture.
    return null;
  }
  return (
    <ul className="meridian-run-attention">
      {props.entries.map((entry) =>
        entry.kind === "folded" ? (
          renderFoldedParks(entry)
        ) : (
          /*
            An uncorrelated park stands for its own run. It draws the same card the run's row
            does, plus the run id, which tells two identical waits apart.
          */
          <li
            key={`park:${entry.workflowRunId}:${entry.parked.phaseId}`}
            className="meridian-run-attention__entry meridian-run-attention__entry--single"
          >
            <WireFigure value={entry.workflowRunId} />
            <ParkBadge parked={entry.parked} />
          </li>
        ),
      )}
    </ul>
  );
}

/**
 * What a folded entry is called: its reasons joined, because a fold may span more than one and
 * naming only the first would misreport the wait.
 */
function foldedParksLabel(entry: WorkflowFoldedParks): string {
  return entry.parkReasons.map((reason) => PARK_REASON_LABELS[reason]).join(" · ");
}

/** One folded cause: what it is, which key correlated it, and how many runs it holds. */
function renderFoldedParks(entry: WorkflowFoldedParks): React.JSX.Element {
  return (
    <li key={`fold:${entry.parkAttentionKey}`} className="meridian-run-attention__entry">
      <Chip
        tone={parkAttentionTone(entry.awaitsPerson)}
        glyph="fold"
        label={foldedParksLabel(entry)}
      />
      {/* The engine's correlation key verbatim, in mono; no read maps it to an account name. */}
      <WireFigure value={entry.parkAttentionKey} />
      {/* The count wears the derived signature; the noun sits beside the figure, unpluralized. */}
      <span className="meridian-run-attention__count">
        Runs affected <DerivedFigure text={formatCount(entry.affectedRunCount)} />
      </span>
    </li>
  );
}
