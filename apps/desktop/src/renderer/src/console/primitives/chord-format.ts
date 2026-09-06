// How a keyboard chord is printed and how it is spoken.
//
// WHY THIS LIVES IN `primitives/` AND NOT IN `palette/`
//
// It was in `palette/keybindings.ts`, beside the table that installs bindings,
// and that placement inverted the console's import DAG: `ChordHint` is a
// primitive, primitives are below palette, and the primitive was reaching UP into
// palette for its vocabulary. The two concerns are genuinely separate — one
// decides which command a keystroke runs, the other decides what a chord looks
// like on a keycap — and only the second is what a renderer needs. Rendering is
// the leafier half, so it moved down rather than the table moving up.
//
// `palette/keybindings.ts` still imports one symbol from here,
// `decodeChordKeyToken`, because its conflict comparator and this file's printer
// have to agree that `k`, `K`, and `KeyK` are one keystroke. That is the correct
// direction (palette → primitives) and it is deliberate that the SHARED half is
// the decoder rather than a copy in each place: the two spellings diverging is
// exactly the defect the single table below exists to prevent.
//
// GLYPHS ARE SHOWN, WORDS ARE SPOKEN
//
// Every entry carries both forms. A screen reader pronounces ⌘ as "place of
// interest sign" and ⇧ as "upwards white arrow", so a keycap glyph read aloud is
// worse than no hint at all — and two parallel tables, one for print and one for
// speech, is how they drift apart. One table, two fields.
//
// NO MODULE READS THE HOST EXCEPT ONCE
//
// Every renderer here takes `platform` as a PARAMETER. `HOST_CHORD_PLATFORM` is
// the single reading of the real host, taken once at module load, so a fixture can
// pin a platform and the screenshot tier gets the same pixels on every runner.

/**
 * Every display convention a chord can be printed in, and the source of the union.
 *
 * A tuple rather than a bare union so a test can drive all three without repeating
 * them — and repeating them is how the second list stops matching the first.
 */
export const CHORD_PLATFORMS = ["darwin", "win32", "linux"] as const;

/**
 * The chord that opens the command palette.
 *
 * `KeyK` rather than `k` so the binding is keyboard-layout independent: on an
 * AZERTY or Dvorak layout the physical key a person reaches for is the same one,
 * and matching by `KeyboardEvent.code` is what preserves that.
 *
 * HERE RATHER THAN IN `palette/`, on this module's own precedent above. It was
 * declared beside the overlay that binds it, and three surfaces PRINT it: the
 * overlay itself, the keyboard settings page, and the whole-surface absence, which
 * is a primitive. So the primitive was reaching up into palette for a string, which
 * is the inversion the paragraph above describes and the reason chord printing
 * moved down in the first place. The binding still belongs to the overlay — it is
 * the only reader that hands this to `parseChord` — but the LITERAL is console-wide
 * vocabulary, and one home for it is what keeps three hints spelling one chord.
 */
export const COMMAND_PALETTE_OPEN_CHORD = "$mod+KeyK";

/**
 * Which display convention to render a chord in.
 *
 * Every renderer takes it as a PARAMETER rather than reading it, so a fixture can
 * pin it and the screenshot tier gets the same pixels on every runner.
 * `HOST_CHORD_PLATFORM` below is the one reading of the real host, taken once.
 */
export type ChordPlatform = (typeof CHORD_PLATFORMS)[number];

/**
 * The platform the console is actually running on, read once at module load.
 *
 * ONE detection, in the module that owns the vocabulary it feeds. The renderer is
 * untrusted and has no `process`, so this is the user agent — and getting it wrong
 * costs a wrong glyph in a hint, never a wrong binding, because `tinykeys` resolves
 * `$mod` against the host itself at listen time. The platform cannot change while a
 * window is open, so re-reading it per row of a virtualized list would be
 * measurable work for a constant.
 */
export const HOST_CHORD_PLATFORM: ChordPlatform = detectHostChordPlatform();

function detectHostChordPlatform(): ChordPlatform {
  if (typeof navigator === "undefined") {
    return "linux";
  }
  const signature = `${navigator.platform} ${navigator.userAgent}`;
  if (/mac|iphone|ipad|ipod/i.test(signature)) {
    return "darwin";
  }
  return /win/i.test(signature) ? "win32" : "linux";
}

/**
 * Split a chord into its modifier tokens and its key token, preserving `$mod`.
 *
 * Mirrors tinykeys' own press grammar (`<mod>+<mod>+<key>`, `[mod]` optional),
 * and the lookbehind matches its splitter so `$mod++` splits the way the parser
 * splits it. It exists beside `parseKeybinding` rather than instead of it because
 * `parseKeybinding` resolves `$mod` against the HOST at import time, while
 * `formatChordForPlatform` must render a chord for a platform that is not the
 * host — that is what makes a fixture screenshot reproducible on any runner.
 */
function splitChordTokens(chord: string): { modifiers: readonly string[]; key: string } {
  const parts = chord.trim().split(/(?<=\w|\])\+/);
  const key = parts.pop() ?? "";
  return { modifiers: parts, key };
}

/**
 * One key of a chord, in both of the forms a person can receive it.
 *
 * The two are NOT interchangeable and the split is the point: a screen reader
 * pronounces ⌘ as "place of interest sign" and ⇧ as "upwards white arrow", so a
 * keycap glyph read aloud is worse than no hint at all. Every table below fills in
 * both, so the printed form and the spoken form are decided in one place and cannot
 * drift apart the way two parallel tables would.
 */
export interface ChordKeyRendering {
  /** What is printed on the keycap. May be a glyph. */
  readonly glyph: string;
  /** What assistive technology says. Always words. */
  readonly spoken: string;
}

/** One press of a chord: its held modifiers, in print order, and its key. */
export interface ChordPressRendering {
  readonly modifiers: readonly ChordKeyRendering[];
  readonly key: ChordKeyRendering;
}

const DARWIN_MODIFIERS: Readonly<Record<string, ChordKeyRendering>> = {
  $mod: { glyph: "⌘", spoken: "Command" },
  Meta: { glyph: "⌘", spoken: "Command" },
  Control: { glyph: "⌃", spoken: "Control" },
  Ctrl: { glyph: "⌃", spoken: "Control" },
  Alt: { glyph: "⌥", spoken: "Option" },
  Option: { glyph: "⌥", spoken: "Option" },
  Shift: { glyph: "⇧", spoken: "Shift" },
};

const NON_DARWIN_MODIFIERS: Readonly<Record<string, ChordKeyRendering>> = {
  $mod: { glyph: "Ctrl", spoken: "Control" },
  Control: { glyph: "Ctrl", spoken: "Control" },
  Ctrl: { glyph: "Ctrl", spoken: "Control" },
  Alt: { glyph: "Alt", spoken: "Alt" },
  Option: { glyph: "Alt", spoken: "Alt" },
  Shift: { glyph: "Shift", spoken: "Shift" },
};

/** Keys whose event name is not what a person reads on a keycap. */
const DARWIN_KEYS: Readonly<Record<string, ChordKeyRendering>> = {
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
};

const NON_DARWIN_KEYS: Readonly<Record<string, ChordKeyRendering>> = {
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
};

/**
 * `KeyboardEvent.code` spellings for keys whose printed form is punctuation.
 *
 * The console authors chords in the `code` form wherever it can — `KeyK` rather
 * than `k` — because `code` is layout-independent, so a binding stays on the same
 * physical key on AZERTY and Dvorak. That correctness costs a decoding step here,
 * and it is a step the printed form cannot skip: `Slash` on a keycap is the word,
 * not the key. The spoken form deliberately keeps the WORD, because "slash" read
 * aloud is clearer than the character.
 */
const PUNCTUATION_CODES: Readonly<Record<string, ChordKeyRendering>> = {
  Comma: { glyph: ",", spoken: "Comma" },
  Period: { glyph: ".", spoken: "Period" },
  Slash: { glyph: "/", spoken: "Slash" },
  Backslash: { glyph: "\\", spoken: "Backslash" },
  Semicolon: { glyph: ";", spoken: "Semicolon" },
  Quote: { glyph: "'", spoken: "Apostrophe" },
  Backquote: { glyph: "`", spoken: "Backtick" },
  BracketLeft: { glyph: "[", spoken: "Left bracket" },
  BracketRight: { glyph: "]", spoken: "Right bracket" },
  Minus: { glyph: "-", spoken: "Minus" },
  Equal: { glyph: "=", spoken: "Equals" },
};

function modifierRendering(token: string, platform: ChordPlatform): ChordKeyRendering | undefined {
  if (platform === "darwin") {
    return DARWIN_MODIFIERS[token];
  }
  if (token === "Meta") {
    // No glyph off macOS: the key is branded differently per platform, and
    // printing "⌘" on Windows would name a key that is not on the keyboard.
    return platform === "win32"
      ? { glyph: "Win", spoken: "Windows" }
      : { glyph: "Super", spoken: "Super" };
  }
  return NON_DARWIN_MODIFIERS[token];
}

/**
 * Reduce a key token to the character or name it stands for.
 *
 * tinykeys accepts either `KeyboardEvent.key` or `KeyboardEvent.code`, so `k`,
 * `K`, and `KeyK` are three spellings of one keystroke. Both the printer and the
 * conflict comparator have to agree about that, and for different reasons: the
 * printer would otherwise put `KeyK` on a keycap, and the comparator would
 * otherwise let `$mod+k` and `$mod+KeyK` be installed as two separate bindings on
 * one chord — the exact collision the conflict check exists to refuse.
 *
 * The exact-length tests matter: `Keyboard` starts with `Key` and is a name, not a
 * code, so shaving the prefix off it would be a silent corruption.
 */
export function decodeChordKeyToken(key: string): string {
  const withoutKeyPrefix = key.startsWith("Key") && key.length === 4 ? key.slice(3) : key;
  return withoutKeyPrefix.startsWith("Digit") && withoutKeyPrefix.length === 6
    ? withoutKeyPrefix.slice(5)
    : withoutKeyPrefix;
}

function keyRendering(key: string, platform: ChordPlatform): ChordKeyRendering {
  const decoded = decodeChordKeyToken(key);
  const punctuation = PUNCTUATION_CODES[decoded];
  if (punctuation !== undefined) {
    return punctuation;
  }
  const named = (platform === "darwin" ? DARWIN_KEYS : NON_DARWIN_KEYS)[decoded];
  if (named !== undefined) {
    return named;
  }
  // A single character is a letter, a digit, or a punctuation key authored
  // literally; upper-case it so `k` and `K` — which tinykeys treats as the same
  // binding — print the same way.
  const printed = decoded.length === 1 ? decoded.toUpperCase() : decoded;
  return { glyph: printed, spoken: printed };
}

function renderSinglePress(press: string, platform: ChordPlatform): ChordPressRendering {
  const { modifiers, key } = splitChordTokens(press);
  const renderedModifiers: ChordKeyRendering[] = [];
  for (const token of modifiers) {
    // `[Shift]` — an OPTIONAL modifier — is what the chord TOLERATES, not what a
    // person must press, so it is omitted rather than printed as an instruction
    // to hold a key they do not need.
    if (token.startsWith("[") && token.endsWith("]")) {
      continue;
    }
    renderedModifiers.push(modifierRendering(token, platform) ?? { glyph: token, spoken: token });
  }
  return { modifiers: renderedModifiers, key: keyRendering(key, platform) };
}

/**
 * A chord decomposed into the keys a person presses, printed and spoken.
 *
 * This is the shared source the `ChordHint` primitive draws its keycaps from, so a
 * chord printed in a palette row and the same chord printed anywhere else cannot
 * disagree — the earlier arrangement, two parallel tables with a comment claiming
 * they were one, printed `KeyK` on a keycap for a year's worth of `code`-form
 * bindings before a screenshot caught it.
 *
 * `platform` is a PARAMETER and never read from `navigator` here, so a fixture can
 * pin it and the screenshot tier gets the same pixels on every runner.
 *
 * Multi-press sequences render as several entries even though `parseChord` refuses
 * to bind one, because this is also asked about chords the table never installed —
 * a platform accelerator, say, that main owns.
 */
export function renderChordForPlatform(
  chord: string,
  platform: ChordPlatform,
): readonly ChordPressRendering[] {
  return chord
    .trim()
    .split(" ")
    .filter((press) => press.length > 0)
    .map((press) => renderSinglePress(press, platform));
}

/** The display form of a chord — `⌘K` on macOS, `Ctrl+K` elsewhere. */
export function formatChordForPlatform(chord: string, platform: ChordPlatform): string {
  return renderChordForPlatform(chord, platform)
    .map((press) => {
      const modifiers = press.modifiers.map((modifier) => modifier.glyph);
      // macOS keycaps read as one run of glyphs with no separator, which is the
      // convention every menu bar on the platform already uses.
      return platform === "darwin"
        ? `${modifiers.join("")}${press.key.glyph}`
        : [...modifiers, press.key.glyph].join("+");
    })
    .join(" ");
}
