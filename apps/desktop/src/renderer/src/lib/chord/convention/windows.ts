// The Windows keyboard.

import type { ResolvedModifierToken } from "../modifiers.js";
import type { ChordKeyRendering, KeyboardConvention } from "./contract.js";
import { PC_KEY_PRINTING, PC_MODIFIER_KEYS } from "./pc-keycaps.js";
import { PC_SELECTION_KEYS } from "./pc-selection-keys.js";

/**
 * Windows: `$mod` is Control, the Meta key is the Windows key, which Windows keeps for itself in
 * every chord, whether or not Windows uses that chord today, and the window switcher, the Start
 * menu and Task Manager take their chords.
 */
export const WINDOWS_KEYBOARD_CONVENTION: KeyboardConvention = {
  applicationModifier: "Control",
  modifierKeys: {
    ...PC_MODIFIER_KEYS,
    Meta: { glyph: "Win", spoken: "Windows" },
  } satisfies Readonly<Record<ResolvedModifierToken, ChordKeyRendering>>,
  ...PC_KEY_PRINTING,
  selectionKeys: PC_SELECTION_KEYS,
  reservedChords: [
    {
      chord: "Alt+Tab",
      reason: "Windows switches windows on this chord before any application sees it.",
    },
    {
      chord: "Alt+Escape",
      reason: "Windows switches windows on this chord before any application sees it.",
    },
    {
      chord: "$mod+Escape",
      reason: "Windows opens the Start menu on this chord before any application sees it.",
    },
    {
      chord: "$mod+Shift+Escape",
      reason: "Windows opens Task Manager on this chord before any application sees it.",
    },
  ],
  reservedModifier: {
    modifier: "Meta",
    reason: "Windows keeps every chord with the Windows key for its own shortcuts.",
  },
};
