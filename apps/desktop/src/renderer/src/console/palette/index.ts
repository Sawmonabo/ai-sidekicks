// The palette subtree's public surface.
//
// One door, whatever the module count behind it. The frame mounts
// `PaletteOverlay`, contributes commands through `CommandRegistry`, and installs
// chords through `KeyBindingTable`.
// Settings search and the sidebar filter reach past none of that — they import
// `scoreSubsequence` directly, which is what "one matcher shared with settings
// search" (`Spec-023 §Console Design (Meridian)` §Layout grammar) means in code.
//
// A door forwards only what its own family owns. How a chord is PRINTED is
// `primitives/chord-format.ts`, and a caller that wants it imports it from
// `primitives/index.js` — re-exporting it here would make this family look like the
// owner of a table it consumes, and the next reader would put the next chord
// concern in the wrong place.
//
// The stylesheet is imported HERE and not from `PaletteOverlay.tsx`, so every
// family's CSS arrives through that family's one door. A component importing its
// own sheet works until a second component in the family needs it, at which point
// the sheet's presence depends on which component the bundler reached first.

import "./palette.css";

export { CommandRegistry } from "./command-registry.js";

// This window's one registry, the plural call a family contributes through, and the
// `when` vocabulary the console evaluates clauses against. On this door rather than
// the frame's because the frame is a consumer of them and this family declares what
// they are made of — and because the console's other consumer, the composer's shell
// half, stands above the frame and cannot import its door without closing a cycle.
//
// `registerConsoleCommand`, the singular, is deliberately absent, and so is the
// `CONSOLE_WHEN_CLAUSE_KEYS` tuple the context type is derived FROM: every family
// that contributes contributes a set, and every family that writes a clause writes
// it against the type. Their only readers are this family and the suites, so a door
// line for either would be a specifier no production module reaches — which the
// barrel census reports rather than tolerates.
export {
  CONSOLE_CHORD_PLATFORM,
  consoleCommands,
  registerConsoleCommands,
  type ConsoleWhenClauseContext,
  type ConsoleWhenClauseKey,
} from "./console-commands.js";
export type { ConsoleCommand, KeyBinding } from "./contributions.js";

// The bridge-backed acts are the palette's own contribution, and they reach the
// frame through this door like every other symbol a family consumes. Only the
// hook is forwarded: the builder beside it exists so the BEHAVIOUR can be driven
// without a React tree, which is its own family's business and not a caller's.
export { useBridgeCommands } from "./bridge-commands.js";

export { KeyBindingTable } from "./keybindings.js";

export type { WhenClauseContext } from "./when-clause.js";

export { COMMAND_PALETTE_OPEN_CHORD, PaletteOverlay } from "./PaletteOverlay.js";
