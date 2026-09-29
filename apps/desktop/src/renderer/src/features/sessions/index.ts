// The sessions feature's public entry: the registrations `app/` calls, and the session
// screen `app/` hands the transcript as the component its workspace slot mounts.

export { registerPaneLayoutCommands } from "./contributions/commands.js";
export { registerSessionsSurface } from "./contributions/screens.js";
export { Workspace } from "./SessionScreen.js";
