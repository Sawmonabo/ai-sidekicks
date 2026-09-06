// What each of the six controls is CALLED, and the mark it wears.
//
// A sibling module rather than a table inside `ControlButton.tsx`, where it was
// written, because it stopped having one reader: the palette contributes the same
// six acts the row draws, and a phrase written twice is how a control ends up
// called "Stop" on the row and "Interrupt" in the palette — two names for one
// wire call, and the person who learned one cannot find the other.
//
// TWO PHRASES PER CONTROL, WHICH IS NOT REDUNDANCY. `label` sits inside a button
// whose surrounding row already names the run, so it is the bare verb; `title` is
// a palette row read out of context and has to be a sentence-case act on its own
// terms. Deriving the second from the first by concatenation would produce
// "Rewind the run" and "Stop the run" correctly and then something wrong the first
// time a control's verb is not a bare imperative — so both are written down.

import { type GlyphName } from "../../../primitives/index.js";
import { type RunControl } from "./run-control-dispatch.js";

/** One control's two phrases and its mark. */
export interface RunControlPresentation {
  /** The button's own word, beside a row that already names the run. */
  readonly label: string;
  /** The palette's phrase: sentence case, no trailing punctuation, names the act. */
  readonly title: string;
  readonly glyph: GlyphName;
}

/** Total over the six, so a seventh control has to answer this rather than default. */
export const RUN_CONTROL_PRESENTATION: Readonly<Record<RunControl, RunControlPresentation>> = {
  pause: { label: "Pause", title: "Pause the run", glyph: "pause" },
  resume: { label: "Resume", title: "Resume the run", glyph: "play" },
  steer: { label: "Steer", title: "Steer the run", glyph: "pencil" },
  interrupt: { label: "Stop", title: "Stop the run", glyph: "stop" },
  cancel: { label: "Cancel", title: "Cancel the run", glyph: "close" },
  rollback: { label: "Rewind", title: "Rewind the run", glyph: "external" },
};
