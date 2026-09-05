// One run's status history: the states it has been through, in order.
//
// Split from `RunRow.tsx`, which owns the row — the run's identity, its current
// state, its controls — while this owns the trail behind it.
//
// ORDER IS THE WIRE'S, NOT THIS SURFACE'S. The rows arrive ordered by the feed that
// folded them and are rendered in that order; re-sorting them here by a timestamp
// this surface reads would be a second answer to which transition came first.

import { Glyph, WireFigure } from "../../primitives/index.js";
import { type RunStatusRow } from "./run-state-feed.js";
import { runStatusSubtypeTraits } from "./run-status.js";

/** The status-history mark, at the size the ledger's own inline glyphs use. */
const HISTORY_MARK_SIZE = 12;

/**
 * The run's transitions, newest last.
 *
 * The subtype is the console's derived phrase and the two states beside it are the
 * wire's own strings — `run-status.ts` records why the phrase cannot be a wire kind.
 */
export function StatusHistory(props: {
  readonly rows: readonly RunStatusRow[];
}): React.JSX.Element {
  if (props.rows.length === 0) {
    return <p className="meridian-run-row__no-history">No transition has been delivered yet.</p>;
  }
  return (
    <ol className="meridian-run-row__history">
      {props.rows.map((row, position) => {
        const traits = runStatusSubtypeTraits(row.subtype);
        return (
          <li
            className="meridian-run-row__history-row"
            key={`${String(position)}:${String(row.runVersion)}`}
          >
            <span className="meridian-run-row__history-mark">
              <Glyph name={traits.glyph} size={HISTORY_MARK_SIZE} />
              {traits.label}
            </span>
            {row.previousState === undefined || row.currentState === undefined ? null : (
              <span className="meridian-run-row__history-states">
                <WireFigure value={row.previousState} /> → <WireFigure value={row.currentState} />
              </span>
            )}
            {row.targetPosition === undefined ? null : (
              <span className="meridian-run-row__history-position">
                position <WireFigure value={String(row.targetPosition)} />
              </span>
            )}
            <WireFigure value={`v${String(row.runVersion)}`} />
            {row.occurredAtIso === undefined ? null : <WireFigure value={row.occurredAtIso} />}
          </li>
        );
      })}
    </ol>
  );
}
