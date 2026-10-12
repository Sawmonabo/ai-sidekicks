// The macOS keyboard.

import type { ResolvedModifierToken } from "../modifiers.js";
import type { ChordKeyRendering, KeyboardConvention } from "./contract.js";

/**
 * macOS: `$mod` is Command, keys print as the glyphs its menus show, a press prints as one run
 * with no separator, and Spotlight, the app switcher and Emoji & Symbols take their chords.
 */
export const MAC_KEYBOARD_CONVENTION: KeyboardConvention = {
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
  // AppKit's standard key bindings, and the browser's page step there, which leaves a strip of the
  // page in view. Select All is Command-A, and Home and End take a scroll view to its start and end
  // (`scrollToBeginningOfDocument:`, `scrollToEndOfDocument:`), as do Command-Up and Command-Down,
  // which AppKit binds to the document's start and end.
  selectionKeys: {
    bindings: {
      ArrowLeft: { none: "character", alt: "word", meta: "lineboundary", ctrl: "lineboundary" },
      ArrowRight: { none: "character", alt: "word", meta: "lineboundary", ctrl: "lineboundary" },
      ArrowUp: { none: "line", alt: "paragraph", meta: "documentboundary" },
      ArrowDown: { none: "line", alt: "paragraph", meta: "documentboundary" },
      Home: { none: "documentboundary" },
      End: { none: "documentboundary" },
      PageUp: { none: "page" },
      PageDown: { none: "page" },
    },
    pageOverlapPx: 40,
    selectAll: [{ key: "a", modifier: "meta" }],
    jumps: {
      start: [
        { key: "Home", modifier: "none" },
        { key: "ArrowUp", modifier: "meta" },
      ],
      end: [
        { key: "End", modifier: "none" },
        { key: "ArrowDown", modifier: "meta" },
      ],
    },
  },
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
