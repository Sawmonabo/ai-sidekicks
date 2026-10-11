// What the Windows and Linux keyboards share: keycaps printed in words, and a press printed with
// `+` between its keys. The Meta key is absent: each system brands it its own way.

import type { ResolvedModifierToken } from "../modifiers.js";
import type { ChordKeyRendering, KeyboardConvention } from "./contract.js";

/** The modifier keycaps of a PC keyboard, all but the Meta key. */
export const PC_MODIFIER_KEYS: Readonly<
  Record<Exclude<ResolvedModifierToken, "Meta">, ChordKeyRendering>
> = {
  Control: { glyph: "Ctrl", spoken: "Control" },
  Ctrl: { glyph: "Ctrl", spoken: "Control" },
  Alt: { glyph: "Alt", spoken: "Alt" },
  AltGraph: { glyph: "AltGr", spoken: "Alt Graph" },
  Option: { glyph: "Alt", spoken: "Alt" },
  Shift: { glyph: "Shift", spoken: "Shift" },
};

/** The named keys and press printing of a PC keyboard. */
export const PC_KEY_PRINTING: Pick<KeyboardConvention, "namedKeys" | "printPress"> = {
  namedKeys: {
    Enter: { glyph: "Enter", spoken: "Enter" },
    Escape: { glyph: "Esc", spoken: "Escape" },
    Backspace: { glyph: "Backspace", spoken: "Backspace" },
    Delete: { glyph: "Del", spoken: "Delete" },
    Tab: { glyph: "Tab", spoken: "Tab" },
    Space: { glyph: "Space", spoken: "Space" },
    ArrowUp: { glyph: "↑", spoken: "Up arrow" },
    ArrowDown: { glyph: "↓", spoken: "Down arrow" },
    ArrowLeft: { glyph: "←", spoken: "Left arrow" },
    ArrowRight: { glyph: "→", spoken: "Right arrow" },
  },
  printPress: (modifierGlyphs, keyGlyph) => [...modifierGlyphs, keyGlyph].join("+"),
};
