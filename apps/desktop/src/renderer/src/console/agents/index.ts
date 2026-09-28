// The agents family's door: the one registrar a surface outside `agents/` composes.
// Everything else is reached deeply from inside the family.
//
// NO STYLESHEET IS IMPORTED HERE. `panes/index.ts` imports this door eagerly, so every
// sheet it reached statically would be on the initial graph of every launch; the
// sheets enter at the pane body's chunk root instead.

// Straight from the module that DECLARES it rather than through a door of that
// directory's own, which would be the barrel chain `console-no-barrel-chain` fails.
export { registerAgentConsolePane } from "./agent-console/agent-console-mounts.js";
