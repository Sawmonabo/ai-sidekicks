// What each run control is CALLED, and the mark it wears.
//
// One table, because a phrase written twice is how a control ends up called "Stop"
// in one place and "Interrupt" in another — two names for one wire call, and the
// person who learned one cannot find the other.
//
// TWO PHRASES PER CONTROL, WHICH IS NOT REDUNDANCY. `label` is the bare verb; `title`
// is a palette row read out of context and has to be a sentence-case act on its own
// terms. Deriving the second from the first by concatenation would produce "Stop the
// run" correctly and then something wrong the first time a control's verb is not a
// bare imperative — so both are written down.

import { type GlyphName } from "../../../primitives/index.js";
import { type RunControl } from "./run-control-dispatch.js";

/** One control's two phrases and its mark. */
export interface RunControlPresentation {
  /** The control's own bare verb. */
  readonly label: string;
  /** The palette's phrase: sentence case, no trailing punctuation, names the act. */
  readonly title: string;
  readonly glyph: GlyphName;
}

/** Total over the controls, so a new one has to answer this rather than default. */
export const RUN_CONTROL_PRESENTATION: Readonly<Record<RunControl, RunControlPresentation>> = {
  pause: { label: "Pause", title: "Pause the run", glyph: "pause" },
  resume: { label: "Resume", title: "Resume the run", glyph: "play" },
  steer: { label: "Steer", title: "Steer the run", glyph: "pencil" },
  interrupt: { label: "Stop", title: "Stop the run", glyph: "stop" },
};
