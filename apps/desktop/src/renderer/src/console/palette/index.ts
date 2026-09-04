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
export type { ConsoleCommand, KeyBinding } from "./contributions.js";

// The bridge-backed acts are the palette's own contribution, and they reach the
// frame through this door like every other symbol a family consumes. Only the
// hook is forwarded: the builder beside it exists so the BEHAVIOUR can be driven
// without a React tree, which is its own family's business and not a caller's.
export { useBridgeCommands } from "./bridge-commands.js";

export { KeyBindingTable } from "./keybindings.js";

// The chord grammar itself, forwarded because it is this family's own and because a
// second consumer arrived for it: `browser/keyboard-handback.ts` has to decide whether
// a keystroke inside an embedded page is one the console bound, which is the same
// question `keybindings.ts` asks and has to be answered by the same parser and the
// same matcher. A chord grammar written a second time beside that decision is how a
// mirror and a table start disagreeing about what `$mod+KeyK` means — and the MATCHER
// rather than the comparison key is what that consumer needs, because the grammar's
// optional-modifier set (`$mod+[Shift]+KeyK`) is a claim about which keystrokes
// satisfy a chord and not about which chords are the same chord.
export { chordMatchesEvent, parseChord } from "./keybinding-chord.js";

export type { WhenClauseContext } from "./when-clause.js";

export { COMMAND_PALETTE_OPEN_CHORD, PaletteOverlay } from "./PaletteOverlay.js";
