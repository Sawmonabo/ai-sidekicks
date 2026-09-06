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

// This window's one registry, the plural call a family contributes through, the seat
// a family contributes its whole set at composition time, the host chord platform the
// printer formats for, and the `when` vocabulary a clause is written against. On this
// door rather than the frame's because the frame is a CONSUMER of them and this family
// declares what they are made of — and because the two other consumers, a view family
// and the composer's shell half, both close a cycle on `frame/index.ts` and can reach
// nothing there at all.
//
// `registerConsoleCommand`, the singular, is deliberately absent; so is the
// `CONSOLE_WHEN_CLAUSE_KEYS` tuple the clause types are derived FROM, and so is
// `ConsoleWhenClauseKey` itself, which now has no reader outside this family at all —
// `command-surface.ts` beside it scopes the frame's two shapes to the key and imports
// it as a sibling — and so are `consoleFamilyKeyBindings` and
// `subscribeToConsoleFamilyContributions`, whose one reader is that same sibling.
// Every family that contributes contributes a SET, and every family that writes a
// clause writes it against the CONTEXT. A door line for any of the five would be a
// specifier no production module reaches, which the barrel census reports rather than
// tolerates.
export {
  CONSOLE_CHORD_PLATFORM,
  // Consumed by T-023p-1C-2
  consoleCommandSurface,
  consoleCommands,
  registerConsoleCommands,
  /**
   * The seat's own type, for the composition site that holds one.
   *
   * @consumedBy T-023p-1C-2
   */
  type ConsoleCommandSurface,
  type ConsoleWhenClauseContext,
} from "./console-commands.js";

// `KeyBinding` rides beside the command shape because modules outside this family
// declare binding tables of their own and type them by this element: the keyboard
// settings page's map, which prints a chord per command, and the workspace sidebar's
// own table. It is on the door for those readers and not for symmetry — the moment no
// production module outside this family writes the type, the line comes off, which is
// how it came off once already when the frame's own vocabulary moved into the family.
export type { ConsoleCommand, KeyBinding } from "./contributions.js";

// The frame's own command vocabulary — the shapes its contributions take, the rail's
// navigation table, and the chords it binds. On this door because a command IS a
// registry entry and a chord IS a key-binding-table row, both declared next door, and
// because the frame is no longer the only reader: a settings page renders the bound
// chords, and a view family can reach neither `frame/command-surface.js` nor
// `frame/index.js` — the first is a cross-family deep import, the second closes a
// cycle back through `families.ts`.
//
// `subscribeToConsoleKeyBindings` is the SIGNAL and not the table. What a window
// installs is the frame's own chords with the families' behind them, and the override
// store next door composes a person's rebindings onto exactly that — reading it as a
// sibling, deeply, which is what an intra-family import is for. The frame takes the
// signal through this door because it has to bump the revision the palette lists
// against when a family contributes late.
//
// Three names are deliberately absent, each because no module outside this family
// reaches it and the barrel census fails a line like that. `consoleKeyBindings` is
// read by the store beside it. `FRAME_KEY_BINDINGS` was on this door for one reader —
// the keyboard page's stale-override rows — and that reader now takes
// `surface.shippedBindings`, which is the base the store actually composed over;
// publishing the half beside the whole would let a caller print one table while the
// keyboard held the other, and would report a chord a view family contributed as an
// override of nothing. `FrameKeyBinding` types that half and goes with it.
export { RAIL_NAVIGATION_DETAILS, subscribeToConsoleKeyBindings } from "./command-surface.js";
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

// The chord grammar itself, forwarded because it is this family's own and because a
// second consumer arrived for it: `browser/pane/keyboard-handback.ts` has to decide whether
// a keystroke inside an embedded page is one the console bound, which is the same
// question `keybindings.ts` asks and has to be answered by the same parser and the
// same matcher. A chord grammar written a second time beside that decision is how a
// mirror and a table start disagreeing about what `$mod+KeyK` means — and the MATCHER
// rather than the comparison key is what that consumer needs, because the grammar's
// optional-modifier set (`$mod+[Shift]+KeyK`) is a claim about which keystrokes
// satisfy a chord and not about which chords are the same chord.
export { chordMatchesEvent, parseChord } from "./keybinding-chord.js";

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

// The lifecycle a VIEW family's commands take: contributed while a surface is on
// screen, cleared when it goes. Published because the runs and approvals panes are
// its readers and a view family may reach nothing else in this one — and because the
// alternative, each pane writing its own register/unregister effect against
// `registerConsoleCommands`, is a contribution the open palette never re-reads.
export { useConsoleCommandSeat } from "./command-seat.js";
