// One row group's error boundary: catches a row that threw while being drawn. The pane-level
// strip (`TranscriptErrors.tsx`) reports refusals the pane collected, a different failure.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { RefusalCard } from "@renderer/components/Refusal/RefusalCard.js";
import { ErrorBoundary } from "@renderer/components/ErrorBoundary/ErrorBoundary.js";

/** Props for `TranscriptRowGroup`. */
export interface TranscriptRowGroupProps {
  /** What failed, in the person's words: "a run group", "the streaming message". */
  readonly groupLabel: string;
  readonly children: React.ReactNode;
}

/**
 * One row group's boundary. A group rather than the whole feed, so a single row that throws
 * does not blank the log around it. The failure renders as a named refusal in the row's own
 * place, not a gap a reader would take for an empty session.
 */
export function TranscriptRowGroup(props: TranscriptRowGroupProps): React.JSX.Element {
  return (
    <ErrorBoundary
      regionName={props.groupLabel}
      fallback={(error, retry) => (
        <div className="meridian-transcript-row-failure" role="alert">
          <RefusalCard
            {...rowProjectionRefusal(props.groupLabel, error)}
            action={
              <button type="button" className="meridian-transcript-retry" onClick={retry}>
                Try again
              </button>
            }
          />
        </div>
      )}
    >
      {props.children}
    </ErrorBoundary>
  );
}

/**
 * A render failure, as a refusal. Built through `refuse` so it carries the same fields as a
 * daemon refusal; the code is renderer-local by name because nothing here came off a wire.
 */
function rowProjectionRefusal(groupLabel: string, error: Error): Refusal {
  return refuse(
    "transcript",
    "renderer.row_projection_failed",
    `${groupLabel} could not be drawn: ${error.message}`,
  );
}
