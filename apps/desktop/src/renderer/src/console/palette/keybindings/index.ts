// The chord grammar and the binding table a window installs.
//
// A SUB-MODULE DOOR, published to `palette/` alone, earned by one sibling:
// `overlay/PaletteOverlay.tsx` matches a keystroke against the open chord with the
// grammar and prints each row's binding out of the table, and
// `overlay/PaletteResultList.tsx` types its rows by the same table.
//
// The conflict comparator, the audit, the override composition and its store are
// absent: their readers are inside this directory or outside the family, and the
// family door forwards those from the modules that declare them.
export { chordMatchesEvent, parseChord } from "./keybinding-chord.js";
export { KeyBindingTable, type KeyBindingTarget } from "./keybindings.js";
