// The sessions feature's public entry: the registrations `app/` calls, the session screen
// component `app/` hands the transcript's screen registration to mount, whether a window's focus
// is in a pane, which the window's chords read, and the widths a pane's own window opens at,
// which `app/` hands main.

export { registerPaneLayoutCommands } from "./contributions/commands.js";
export { registerSessionsFlyout } from "./contributions/screens.js";
export { useIsFocusInPane } from "./pane-layout/hooks/useIsFocusInPane.js";
export { paneWindowWidthsPx } from "./pane-layout/widths.js";
export { SessionScreen } from "./SessionScreen.js";
