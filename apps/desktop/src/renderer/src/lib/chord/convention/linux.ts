// The Linux keyboard.

import type { ResolvedModifierToken } from "../modifiers.js";
import type { ChordKeyRendering, KeyboardConvention } from "./contract.js";
import { PC_KEY_PRINTING, PC_MODIFIER_KEYS } from "./pc-keycaps.js";

/**
 * Linux: `$mod` is Control, the Meta key is Super, and the desktop environment's window switcher
 * and GNOME's own Escape chords are taken.
 */
export const LINUX_KEYBOARD_CONVENTION: KeyboardConvention = {
  applicationModifier: "Control",
  modifierKeys: {
    ...PC_MODIFIER_KEYS,
    Meta: { glyph: "Super", spoken: "Super" },
  } satisfies Readonly<Record<ResolvedModifierToken, ChordKeyRendering>>,
  ...PC_KEY_PRINTING,
  reservedChords: [
    {
      chord: "Alt+Tab",
      reason:
        "The desktop environment usually switches windows " +
        "on this chord before any application sees it.",
    },
    // GNOME's own Escape chords, spelled in the order the recorder writes a press's modifiers.
    {
      chord: "Alt+Escape",
      reason: "GNOME switches windows on this chord before any application sees it.",
    },
    {
      chord: "Alt+Shift+Escape",
      reason: "GNOME switches windows on this chord before any application sees it.",
    },
    {
      chord: "$mod+Alt+Escape",
      reason: "GNOME switches system controls on this chord before any application sees it.",
    },
    {
      chord: "$mod+Alt+Shift+Escape",
      reason: "GNOME switches system controls on this chord before any application sees it.",
    },
    {
      chord: "Meta+Escape",
      reason: "GNOME restores its own shortcuts on this chord before any application sees it.",
    },
  ],
};
