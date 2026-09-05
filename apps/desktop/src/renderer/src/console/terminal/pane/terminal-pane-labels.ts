// The emulator's accessible name, derived from what the pane is called.
//
// ONE NAME IS LEFT HERE, and the module survives the loss of the other rather than
// folding into its reader. `seats/ConsolePaneChrome` names the pane's own region now,
// from a title table that is module-private to it — deliberately, so the six families
// cannot each spell the same pane two ways — and the emulator inside it is still this
// family's to name. Deriving from a local word rather than reaching for that table is
// what keeps the private table private; the cost is that a rename of the pane kind
// does not reach in here, which is why the word below is stated as the base of a
// derivation rather than as the pane's name.
//
// It lives beside the two components rather than on either, because the boundary
// component mounts the frame and the bound one names the emulator inside it — a
// constant exported by one and imported by the other would close a cycle between them.

/** What this family calls the surface, and the base the name below is built on. */
const TERMINAL_SURFACE_WORD = "Terminal";

/** The emulator's accessible name, inside the pane. */
export const TERMINAL_OUTPUT_LABEL: string = `${TERMINAL_SURFACE_WORD} output`;
