// How a keyboard chord is printed and spoken. It lives in `lib/` because `ChordHint` is a shared
// component below the registries; `registries/keybindings/keybinding-chord.ts` imports
// `decodeChordKeyToken` so its conflict comparator and the printer agree that `k`, `K` and `KeyK`
// are one keystroke.
//
// Each entry carries a glyph to show and words to speak in one table, since a screen reader
// mispronounces glyphs such as ⌘. Every renderer takes `platform` as a parameter, and
// `HOST_CHORD_PLATFORM` is the only reading of the host, so a fixture can pin one.

/** Every display convention a chord can be printed in; the source of {@link ChordPlatform}. */
export const CHORD_PLATFORMS = ["darwin", "win32", "linux"] as const;

/**
 * The chord that opens the command palette.
 *
 * `KeyP` rather than `p` so the binding follows the physical key on any keyboard layout. It
 * lives here because the palette, the keyboard settings page and a shared notice component all
 * print it, and one literal keeps their hints identical.
 */
export const COMMAND_PALETTE_OPEN_CHORD = "$mod+Shift+KeyP";

/** Which display convention to render a chord in. */
export type ChordPlatform = (typeof CHORD_PLATFORMS)[number];

/**
 * The platform the console is running on, read once at module load from the user agent (the
 * renderer has no `process`). A wrong guess costs a wrong glyph in a hint, never a wrong
 * binding, because `tinykeys` resolves `$mod` against the host itself.
 */
export const HOST_CHORD_PLATFORM: ChordPlatform = detectHostChordPlatform();

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

/** One press of a chord: its held modifiers, in print order, and its key. */
export interface ChordPressRendering {
  readonly modifiers: readonly ChordKeyRendering[];
  readonly key: ChordKeyRendering;
}

/**
 * Split a chord into its modifier tokens and its key token, preserving `$mod`.
 *
 * Follows tinykeys' press grammar (`<mod>+<mod>+<key>`, `[mod]` optional; the lookbehind makes
 * `$mod++` split as the parser does). It exists beside `parseKeybinding` because that resolves
 * `$mod` against the host, while rendering must work for any platform.
 */
export function splitChordTokens(chord: string): { modifiers: readonly string[]; key: string } {
  const parts = chord.trim().split(/(?<=\w|\])\+/);
  const key = parts.pop() ?? "";
  return { modifiers: parts, key };
}

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
 * Every token an authored chord may name as a modifier. The two rendering tables below are
 * checked total over it, so a new token does not compile until both platforms print and speak it.
 * The preview handback also reads it to decide whether a chord holds a modifier.
 */
export const CHORD_MODIFIER_TOKENS = [
  "$mod",
  "Meta",
  "Control",
  "Ctrl",
  "Alt",
  "Option",
  "Shift",
] as const;

/** One modifier token an authored chord names. */
export type ChordModifierToken = (typeof CHORD_MODIFIER_TOKENS)[number];

/**
 * Which modifier `$mod` stands for on each platform: meta on macOS, control elsewhere.
 *
 * The one resolution for the printer and the preview handback; tinykeys resolves against the
 * host only, so code working for another platform reads this.
 */
export const PLATFORM_MODIFIER_TOKEN: Readonly<Record<ChordPlatform, "Meta" | "Control">> = {
  darwin: "Meta",
  win32: "Control",
  linux: "Control",
};

/** The token an authored chord uses for the platform's own application modifier. */
export const PLATFORM_MODIFIER_CHORD_TOKEN = "$mod";

/** Every token but `$mod`, which is resolved into one of these before a lookup. */
type ResolvedModifierToken = Exclude<ChordModifierToken, "$mod">;

// Typed open because an authored token may be unknown (it must read `undefined`), and checked
// total by `satisfies`.
const DARWIN_MODIFIERS: Readonly<Record<string, ChordKeyRendering>> = {
  Meta: { glyph: "⌘", spoken: "Command" },
  Control: { glyph: "⌃", spoken: "Control" },
  Ctrl: { glyph: "⌃", spoken: "Control" },
  Alt: { glyph: "⌥", spoken: "Option" },
  Option: { glyph: "⌥", spoken: "Option" },
  Shift: { glyph: "⇧", spoken: "Shift" },
} satisfies Readonly<Record<ResolvedModifierToken, ChordKeyRendering>>;

// `Meta` is absent: off macOS the key is branded per platform and `modifierRendering` answers.
const NON_DARWIN_MODIFIERS: Readonly<Record<string, ChordKeyRendering>> = {
  Control: { glyph: "Ctrl", spoken: "Control" },
  Ctrl: { glyph: "Ctrl", spoken: "Control" },
  Alt: { glyph: "Alt", spoken: "Alt" },
  Option: { glyph: "Alt", spoken: "Alt" },
  Shift: { glyph: "Shift", spoken: "Shift" },
} satisfies Readonly<Record<Exclude<ResolvedModifierToken, "Meta">, ChordKeyRendering>>;

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
 * Chords are authored in the layout-independent `code` form, so the printed form must decode
 * `Slash` to `/`. The spoken form keeps the word.
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

/**
 * Reduce a key token to the character or name it stands for.
 *
 * tinykeys accepts `KeyboardEvent.key` or `.code`, so `k`, `K` and `KeyK` are one keystroke; the
 * printer and the conflict comparator both decode through this. The exact-length tests keep a
 * name such as `Keyboard` from losing its `Key` prefix.
 */
export function decodeChordKeyToken(key: string): string {
  const withoutKeyPrefix = key.startsWith("Key") && key.length === 4 ? key.slice(3) : key;
  return withoutKeyPrefix.startsWith("Digit") && withoutKeyPrefix.length === 6
    ? withoutKeyPrefix.slice(5)
    : withoutKeyPrefix;
}

/**
 * A chord decomposed into the keys a person presses, printed and spoken; the source `ChordHint`
 * draws its keycaps from.
 *
 * A multi-press sequence renders as several entries, because this also renders chords that
 * `parseChord` never binds.
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
      // macOS prints glyphs as one run with no separator, as its menu bars do.
      return platform === "darwin"
        ? `${modifiers.join("")}${press.key.glyph}`
        : [...modifiers, press.key.glyph].join("+");
    })
    .join(" ");
}

function modifierRendering(token: string, platform: ChordPlatform): ChordKeyRendering | undefined {
  // `$mod` is resolved first, so neither table needs a row for it.
  const resolved: string =
    token === PLATFORM_MODIFIER_CHORD_TOKEN ? PLATFORM_MODIFIER_TOKEN[platform] : token;
  if (platform === "darwin") {
    return DARWIN_MODIFIERS[resolved];
  }
  if (resolved === "Meta") {
    // The key is branded per platform; "⌘" on Windows would name a key that is not there.
    return platform === "win32"
      ? { glyph: "Win", spoken: "Windows" }
      : { glyph: "Super", spoken: "Super" };
  }
  return NON_DARWIN_MODIFIERS[resolved];
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
  // Upper-case a single character so `k` and `K`, one binding in tinykeys, print alike.
  const printed = decoded.length === 1 ? decoded.toUpperCase() : decoded;
  return { glyph: printed, spoken: printed };
}

function renderSinglePress(press: string, platform: ChordPlatform): ChordPressRendering {
  const { modifiers, key } = splitChordTokens(press);
  const renderedModifiers: ChordKeyRendering[] = [];
  for (const token of modifiers) {
    // An optional modifier (`[Shift]`) is tolerated, not required, so it is not printed.
    if (token.startsWith("[") && token.endsWith("]")) {
      continue;
    }
    renderedModifiers.push(modifierRendering(token, platform) ?? { glyph: token, spoken: token });
  }
  return { modifiers: renderedModifiers, key: keyRendering(key, platform) };
}
