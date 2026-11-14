// What each palette run control is called.
//
// One table, so one wire call is not "Stop" in one place and "Interrupt" in another. `label`
// is the bare verb and `title` a palette sentence; the title is written, not derived, because
// a verb that is not a bare imperative would break concatenation.

import { type PaletteRunControl } from "./gating.js";

/** One control's bare verb and the phrase its palette row reads. */
export interface RunControlPresentation {
  /** The control's own bare verb. */
  readonly label: string;
  /** The palette's phrase: sentence case, no trailing punctuation, names the act. */
  readonly title: string;
}

/** Total over the palette's controls, so a new one has to answer this rather than default. */
export const RUN_CONTROL_PRESENTATION: Readonly<Record<PaletteRunControl, RunControlPresentation>> =
  {
    pause: { label: "Pause", title: "Pause the run" },
    resume: { label: "Resume", title: "Resume the run" },
    interrupt: { label: "Stop", title: "Stop the run" },
  };
