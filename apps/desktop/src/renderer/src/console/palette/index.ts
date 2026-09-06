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

// This window's one registry, the plural call a family contributes through, the host
// chord platform the printer formats for, and the `when` vocabulary a clause is
// written against. On this door rather than the frame's because the frame is a
// CONSUMER of them and this family declares what they are made of — and because the
// two other consumers, a view family and the composer's shell half, both close a
// cycle on `frame/index.ts` and can reach nothing there at all.
//
// `registerConsoleCommand`, the singular, is deliberately absent; so is the
// `CONSOLE_WHEN_CLAUSE_KEYS` tuple the clause types are derived FROM, and so is
// `ConsoleWhenClauseKey` itself, which now has no reader outside this family at all —
// `command-surface.ts` beside it scopes the frame's two shapes to the key and imports
// it as a sibling. Every family that contributes contributes a SET, and every family
// that writes a clause writes it against the CONTEXT. A door line for any of the three
// would be a specifier no production module reaches, which the barrel census reports
// rather than tolerates.
export {
  CONSOLE_CHORD_PLATFORM,
  consoleCommands,
  registerConsoleCommands,
  type ConsoleWhenClauseContext,
} from "./console-commands.js";

// `KeyBinding` rides beside the command shape because a view family declares a
// binding table of its own — the workspace sidebar's — and types it by this element.
// It is on the door for that reader and not for symmetry: the moment no production
// module outside this family writes the type, the line comes off, which is how it
// came off once already when the frame's own vocabulary moved into the family.
export type { ConsoleCommand, KeyBinding } from "./contributions.js";

// The frame's own command vocabulary — the shapes its contributions take, the rail's
// navigation table, and the chords it binds. On this door because a command IS a
// registry entry and a chord IS a key-binding-table row, both declared next door, and
// because the frame is no longer the only reader: a settings page renders the bound
// chords, and a view family can reach neither `frame/command-surface.js` nor
// `frame/index.js` — the first is a cross-family deep import, the second closes a
// cycle back through `families.ts`.
//
// `FrameKeyBinding` is deliberately absent. `FRAME_KEY_BINDINGS` is typed by it and
// every consumer reads the array, so a door line for the element type would be a
// specifier no production module writes.
export { FRAME_KEY_BINDINGS, RAIL_NAVIGATION_DETAILS } from "./command-surface.js";
export type { FrameCommand } from "./command-surface.js";

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

// The open chord is NOT forwarded, and it is no longer this family's to forward. The
// overlay BINDS it and two surfaces PRINT it, one of them a primitive, so the literal
// sits in `primitives/chord-format.ts` beside the printer and this family imports it
// down like every other caller.
export { PaletteOverlay } from "./PaletteOverlay.js";

// The keybinding surface this family added beside the table: what a chord audit
// answers, how a person's overrides compose onto the shipped bindings, and the store
// that holds them for a window. Published because the keyboard settings page is the
// reader of all three, and settings is a view family that may reach nothing inside
// this one by any other path.
export { auditKeybindings, reservedChordReason } from "./keybinding-audit.js";

export { composeEffectiveBindings, type KeybindingOverrideMap } from "./keybinding-overrides.js";

export { consoleKeybindingOverrides, useKeybindingSurface } from "./keybinding-override-store.js";
