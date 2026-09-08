// What a command IS in this console: the contribution shape, the window registry
// that holds them, the ranking a search produces, and the frame's own surface.
//
// A SUB-MODULE DOOR, published to `palette/` alone. Two siblings earn it:
// `keybindings/` types every binding table by `KeyBinding` and invokes through
// `CommandRegistry`, and `overlay/` lists ranked results out of the same registry.
//
// Absent on purpose: `console-commands.ts`, `command-seat.ts`, `bridge-commands.ts`
// and `subsequence-score.ts`, whose readers are all outside this family and reach
// them through `palette/index.ts` — which forwards from each declaring module, so a
// second line here would publish a name no sibling takes.
export type { CommandSearchResult } from "./command-ranking.js";
export { CommandRegistry, type CommandInvocationOutcome } from "./command-registry.js";
export { consoleKeyBindings, subscribeToConsoleKeyBindings } from "./command-surface.js";
export type { ConsoleCommand, KeyBinding } from "./contributions.js";
