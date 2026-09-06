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

// The console's ONE matcher, published because two settings surfaces rank against
// it. `Spec-023 §Console Libraries` requires the palette, settings search, the
// sidebar filter, and find to score "identically in both places", which is a rule
// about one implementation rather than one algorithm — so the sharing is declared
// here rather than performed by a deep import that no layering rule can see.
export { scoreSubsequence } from "./subsequence-score.js";

export { KeyBindingTable } from "./keybindings.js";

export type { WhenClauseContext } from "./when-clause.js";

export { PaletteOverlay } from "./PaletteOverlay.js";

// The command surface and the chord surface, which moved here from `frame/`.
//
// They were authored beside the frame because the frame is what registers the
// console's own commands and installs their chords. But the settings pages read
// both — the keyboard page lists every binding and rebinds one, the appearance
// page registers a scheme command — and settings is a VIEW family, so those reads
// were cross-family imports reaching past a door into another family's subtree.
// The rule's own remedy is to hoist to the lowest family that owns the inputs, and
// that family is this one: a command IS a `CommandRegistry` entry and a chord IS a
// `KeyBindingTable` row, both declared next door. The frame keeps what only the
// frame does — composing the registry into a running window — and imports the
// vocabulary through this door like every other consumer.
export {
  CONSOLE_CHORD_PLATFORM,
  FRAME_KEY_BINDINGS,
  RAIL_NAVIGATION_DETAILS,
  consoleCommands,
  registerConsoleCommands,
  type FrameCommand,
  type FrameWhenClauseContext,
} from "./command-surface.js";

export { auditKeybindings, reservedChordReason } from "./keybinding-audit.js";

export { composeEffectiveBindings, type KeybindingOverrideMap } from "./keybinding-overrides.js";

export { consoleKeybindingOverrides, useKeybindingSurface } from "./keybinding-override-store.js";
