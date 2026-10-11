// What an operating system's keyboard means for a chord: the key `$mod` stands for, how each key
// is printed and spoken, how a press is written, and which chords the system takes for itself. One
// module per system supplies it, and `./selection.ts` picks one by platform.

import type { SpelledModifierToken } from "../modifiers.js";

/**
 * One key of a chord in both forms a person can receive it: printed and spoken.
 *
 * The two are not interchangeable: a screen reader pronounces ⌘ as "place of interest sign".
 */
export interface ChordKeyRendering {
  /** What is printed on the keycap. May be a glyph. */
  readonly glyph: string;
  /** What assistive technology says. Always words. */
  readonly spoken: string;
}

/** One chord the system consumes before this application can see it, and why. */
export interface ReservedChord {
  readonly chord: string;
  readonly reason: string;
}

/** The keyboard of one operating system, as the chord printer and the keybinding audit read it. */
export interface KeyboardConvention {
  /** The modifier `$mod` stands for: the key the system's application shortcuts are held on. */
  readonly applicationModifier: "Meta" | "Control";
  /**
   * Each modifier token, `$mod` resolved first, printed and spoken; typed open because an authored
   * token may be unknown, which reads `undefined`.
   */
  readonly modifierKeys: Readonly<Record<string, ChordKeyRendering>>;
  /** Keys whose event name is not what a person reads on the keycap. */
  readonly namedKeys: Readonly<Record<string, ChordKeyRendering>>;
  /** One press as printed, from its modifiers' glyphs in print order and its key's glyph. */
  readonly printPress: (modifierGlyphs: readonly string[], keyGlyph: string) => string;
  /** The chords the system takes on a default install, each in the one spelling. */
  readonly reservedChords: readonly ReservedChord[];
  /** A modifier the system keeps for itself in every chord, with why; absent where none is. */
  readonly reservedModifier?: {
    readonly modifier: SpelledModifierToken;
    readonly reason: string;
  };
}
