// The transcript feature's public entry: the registrations `app/` calls, the size of the opening
// read the session store asks the daemon for, the share of the log it keeps off screen, and
// whether the window's transcript holds a run group, which the palette's `when` context reads.

export { registerTranscriptCommands } from "./contributions/commands.js";
export { registerTranscriptPanes } from "./contributions/panes.js";
export { registerTranscriptScreens } from "./contributions/screens.js";
export { transcriptOffScreenRowLimit, transcriptOpeningPageLimit } from "./history/page-limit.js";
export { useTranscriptHoldsRunGroup } from "./hooks/useTranscriptHoldsRunGroup.js";
