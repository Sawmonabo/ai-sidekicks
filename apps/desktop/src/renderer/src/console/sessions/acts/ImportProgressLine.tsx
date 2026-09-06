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

import { InlineRefusal, WireFigure, formatCount } from "../../primitives/index.js";
import type { ImportProgressReading } from "./provider-import.js";

export interface ImportProgressLineProps {
  readonly progress: ImportProgressReading;
}

export function ImportProgressLine(props: ImportProgressLineProps): React.JSX.Element | null {
  const { progress } = props;
  if (progress.status === "unsubscribed") {
    return null;
  }
  if (progress.status === "refused") {
    return <InlineRefusal {...progress.refusal} />;
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
