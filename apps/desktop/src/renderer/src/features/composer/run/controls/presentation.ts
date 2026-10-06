// What each run control is called, and the mark it wears.
//
// One table, so one wire call is not "Stop" in one place and "Interrupt" in another. `label`
// is the bare verb and `title` a palette sentence; the title is written, not derived, because
// a verb that is not a bare imperative would break concatenation.

import { type GlyphName } from "#renderer/styles/glyphs.js";
import { type RunControl } from "./services/dispatch.js";

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
