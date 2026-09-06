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
import "./surface-absence.css";

export { CommandRegistry } from "./command-registry.js";
export type { ConsoleCommand, KeyBinding } from "./contributions.js";

// The window's registry and the door every family contributes through. They sit in
// this family because every input is this family's or below it, and they leave
// through this door because a view family cannot import the frame's: `frame/index.ts`
// reaches `ConsoleRoot` and through it every family, so that edge closes a cycle.
// `consoleFamilyKeyBindings` is read by the frame alone, which prepends its own rail
// chords and publishes the whole table.
// The singular `registerConsoleCommand` and the contribution SHAPE are deliberately
// not among them: every caller outside this family registers a batch, and every one
// of them builds its contribution inline against the interface below, so a door line
// for either would publish a name nothing outside the family types.
export {
  CONSOLE_CHORD_PLATFORM,
  consoleCommandSurface,
  consoleCommands,
  consoleFamilyKeyBindings,
  publishConsoleActRefusalSink,
  raiseConsoleActRefusal,
  registerConsoleCommands,
  type ConsoleCommandSurface,
} from "./console-commands.js";

// The bridge-backed acts are the palette's own contribution, and they reach the
// frame through this door like every other symbol a family consumes. Only the
// hook is forwarded: the builder beside it exists so the BEHAVIOUR can be driven
// without a React tree, which is its own family's business and not a caller's.
export { useBridgeCommands } from "./bridge-commands.js";

export { KeyBindingTable } from "./keybindings.js";

export type { WhenClauseContext } from "./when-clause.js";

// The open chord is NOT forwarded. Its one reader outside `PaletteOverlay.tsx` is
// `SurfaceAbsence.tsx` beside it, which is this family's own module and reads it
// directly; a door line for a symbol nothing outside the family imports is a claim
// about a consumer that does not exist.
export { PaletteOverlay } from "./PaletteOverlay.js";

// The surface-scale absence wrapper. Its producers are the frame's route surface and
// the legacy-surface mounts, and one view family's reserved arm — which is why it is
// published rather than kept behind the family that draws it most.
export { SurfaceAbsence } from "./SurfaceAbsence.js";
