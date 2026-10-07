import type { SettingsControl } from "../../types.js";

/** The head of the Keyboard page's chord list. */
export const CHORDS_HEADING = "Chords";

/** The controls the Keyboard page draws that search finds, in the order the page draws them. */
export const KEYBOARD_CONTROLS: Readonly<Record<"shortcutSearch", SettingsControl>> = {
  shortcutSearch: { id: "shortcut-search", label: "Search shortcuts", heading: CHORDS_HEADING },
};
