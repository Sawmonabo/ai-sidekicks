// The terminal pane's accessible names, held in one place so they stay in step.
//
// The emulator's name DERIVES from the region's rather than repeating it: the two are
// the same surface to a screen-reader user moving between landmarks, and a rename that
// reached one and not the other would leave "Terminal" containing "Shell output".
//
// They live beside the two components rather than on either, because the boundary
// component names the region and the bound one names the emulator inside it — a
// constant exported by one and imported by the other would close a cycle between them.

/** The pane region's accessible name. */
export const TERMINAL_PANE_LABEL = "Terminal";

/** The emulator's accessible name, inside that region. */
export const TERMINAL_OUTPUT_LABEL: string = `${TERMINAL_PANE_LABEL} output`;
