// What one import's progress subscription has said, in its own words.
//
// Its own module rather than a second component beside the panel, which the console's
// one-component-per-module rule forbids — and the split earns itself here: the panel
// owns two calls and their disclosure, and this owns the four arms one stream can be
// in. They fail differently and they read differently.
//
// EVERY ARM RENDERS, including the two that are easy to leave out: an open stream that
// has not spoken yet is "reading, nothing counted so far" and never a blank, and a
// closed one that never spoke is a stream that ended having said nothing — a different
// fact from one that ended at sixty turns, and it must not render as it.
//
// NOTHING IS COMPUTED FROM THE FRAMES. The turn count and the state are the producer's
// own words; a percentage would be this console inventing a denominator nobody sent.
//
// AND THE REFUSED ARM CARRIES THE WAY BACK ONTO THE STREAM. The operator's next move
// belongs in the refusal's own action slot, and for a delivery that stopped over an
// import the daemon may still be running that move is re-attaching rather than
// starting again. Whether there is one to offer is the model's answer and never this
// component's: the handler is absent where nothing can be re-attached, so the control
// is not rendered rather than rendered inert.

import { InlineRefusal, WireFigure, formatCount } from "../../primitives/index.js";
import type { ImportProgressReading } from "./provider-import.js";

export interface ImportProgressLineProps {
  readonly progress: ImportProgressReading;
  /** Re-attach to the running import, or `undefined` where nothing can be. */
  readonly onRetry?: (() => void) | undefined;
}

export function ImportProgressLine(props: ImportProgressLineProps): React.JSX.Element | null {
  const { progress, onRetry } = props;
  if (progress.status === "unsubscribed") {
    return null;
  }
  if (progress.status === "refused") {
    return (
      <InlineRefusal
        {...progress.refusal}
        action={
          onRetry === undefined ? undefined : (
            <button type="button" className="meridian-session-import__retry" onClick={onRetry}>
              Watch this import again
            </button>
          )
        }
      />
    );
  }
  const { newest } = progress;
  const isOpen = progress.status === "open";
  if (newest === undefined) {
    return (
      <p className="meridian-session-import__progress" aria-live="polite">
        {isOpen ? "Reading. Nothing counted yet." : "The import ended without reporting anything."}
      </p>
    );
  }
  return (
    <p className="meridian-session-import__progress" aria-live="polite">
      {isOpen ? "Reading" : "Ended"} — <WireFigure value={newest.state} /> at{" "}
      <WireFigure value={formatCount(newest.turnsSeen)} title={String(newest.turnsSeen)} /> turns.
    </p>
  );
}
