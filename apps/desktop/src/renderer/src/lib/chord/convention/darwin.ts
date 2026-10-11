// The macOS keyboard.

import type { ResolvedModifierToken } from "../modifiers.js";
import type { ChordKeyRendering, KeyboardConvention } from "./contract.js";

/**
 * macOS: `$mod` is Command, keys print as the glyphs its menus show, a press prints as one run
 * with no separator, and Spotlight, the app switcher and Emoji & Symbols take their chords.
 */
export const DARWIN_KEYBOARD_CONVENTION: KeyboardConvention = {
  applicationModifier: "Meta",
  modifierKeys: {
    Meta: { glyph: "⌘", spoken: "Command" },
    Control: { glyph: "⌃", spoken: "Control" },
    Ctrl: { glyph: "⌃", spoken: "Control" },
    Alt: { glyph: "⌥", spoken: "Option" },
    AltGraph: { glyph: "⌥", spoken: "Option" },
    Option: { glyph: "⌥", spoken: "Option" },
    Shift: { glyph: "⇧", spoken: "Shift" },
  } satisfies Readonly<Record<ResolvedModifierToken, ChordKeyRendering>>,
  namedKeys: {
    Enter: { glyph: "↩", spoken: "Return" },
    Escape: { glyph: "⎋", spoken: "Escape" },
    Backspace: { glyph: "⌫", spoken: "Backspace" },
    Delete: { glyph: "⌦", spoken: "Delete" },
    Tab: { glyph: "⇥", spoken: "Tab" },
    Space: { glyph: "Space", spoken: "Space" },
    ArrowUp: { glyph: "↑", spoken: "Up arrow" },
    ArrowDown: { glyph: "↓", spoken: "Down arrow" },
    ArrowLeft: { glyph: "←", spoken: "Left arrow" },
    ArrowRight: { glyph: "→", spoken: "Right arrow" },
  },
  printPress: (modifierGlyphs, keyGlyph) => `${modifierGlyphs.join("")}${keyGlyph}`,
  reservedChords: [
    {
      chord: "$mod+Space",
      reason: "macOS opens Spotlight on this chord before any application sees it.",
    },
    {
      chord: "$mod+Tab",
      reason: "macOS switches applications on this chord before any application sees it.",
    },
    {
      chord: "$mod+Control+Space",
      reason: "macOS opens Emoji & Symbols on this chord before any application sees it.",
    },
  ],
};
