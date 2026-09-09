// One row group's error boundary.
//
// Its own module for the one-component rule, and the split separates two different
// jobs that shared a file: the strip beside it reports refusals the PANE collected,
// and this catches a row that threw while being drawn. A pane-level strip and a
// per-group boundary answer to different failures and neither can stand in for the
// other.
//
// THE BOUNDARY COMES THROUGH THE PRIMITIVES DOOR. It used to be `frame/`'s, reached
// by a deep specifier because `frame/index.ts` exports `ConsoleRoot`, which imports
// `console/families.ts`, which imports this family's door — so an edge from here to
// that barrel closes a cycle. `console-cross-family-deep-import` reports the deep
// specifier that shape produces and prescribes the hoist instead, and the boundary
// imports nothing above `core/`, so `primitives/` is the family that owns its inputs.

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { RefusalCard, SurfaceErrorBoundary } from "../../primitives/index.js";

export interface LedgerRowGroupProps {
  /** What failed, in the person's words: "a run chapter", "the streaming message". */
  readonly groupLabel: string;
  readonly children: React.ReactNode;
}

/**
 * A render failure, as a refusal.
 *
 * Built through `refuse` rather than an object literal so this failure carries the
 * same three fields as every daemon refusal and reaches the same three renderers.
 * The code is renderer-local and says so in its own name: nothing here came off a
 * wire, and dressing it as a wire code would make a console defect look like the
 * daemon's answer.
 */
function rowProjectionRefusal(groupLabel: string, error: Error): ConsoleRefusal {
  return refuse(
    "ledger",
    "renderer.row_projection_failed",
    `${groupLabel} could not be drawn: ${error.message}`,
  );
}

/**
 * One row group's boundary.
 *
 * A group rather than the whole feed: a single row that throws must not blank the
 * log around it, which is the same reasoning `primitives/ErrorBoundary.tsx` gives for
 * one boundary per surface rather than one per window, applied one level down.
 *
 * The failure is rendered RED and NAMED (rule 8) through the console's one refusal
 * grammar — the row's own place in the log, holding the reason it could not be
 * drawn, rather than a gap a reader would read as the session having nothing there.
 */
export function LedgerRowGroup(props: LedgerRowGroupProps): React.JSX.Element {
  return (
    <SurfaceErrorBoundary
      surfaceName={props.groupLabel}
      fallback={(error, retry) => (
        <div className="meridian-ledger-row-failure" role="alert">
          <RefusalCard
            {...rowProjectionRefusal(props.groupLabel, error)}
            action={
              <button type="button" className="meridian-ledger-retry" onClick={retry}>
                Try again
              </button>
            }
          />
        </div>
      )}
    >
      {props.children}
    </SurfaceErrorBoundary>
  );
}
