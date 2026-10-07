// How a keyboard chord is spelled, printed and spoken. It lives in `lib/` because `ChordHint` is a
// shared component below the registries; the conflict comparator, the reserved-chord lookup and
// the preview handback fold a key through `foldChordKeyToken`, so they and the printer agree that
// `k`, `K` and `KeyK` are one keystroke.
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
 * The platform the app is running on, read once at module load (the renderer has no `process`).
 * macOS is told by the test tinykeys resolves `$mod` with, so `$mod` names the same key here as
 * in its matcher; Windows is told from Linux by the user agent.
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
  if (typeof navigator !== "object") {
    return "linux";
  }
  if (/Mac|iPod|iPhone|iPad/.test(navigator.platform)) {
    return "darwin";
  }
  return /win/i.test(`${navigator.platform} ${navigator.userAgent}`) ? "win32" : "linux";
}

/**
 * The modifier tokens a chord is held in, in the order the app spells them: `$mod`, then the
 * names tinykeys hands to `getModifierState`. A chord naming any other modifier never fires.
 */
export const SPELLED_MODIFIER_TOKENS = [
  "$mod",
  "Meta",
  "Control",
  "Alt",
  "AltGraph",
  "Shift",
] as const;

/** One modifier token of a chord in the one spelling. */
export type SpelledModifierToken = (typeof SPELLED_MODIFIER_TOKENS)[number];

/**
 * Every token an authored chord may name as a modifier, in spelling order: the spelled tokens,
 * then `Ctrl` and `Option`, which reading a stored chord turns into `Control` and `Alt`. The two
 * rendering tables below are checked total over it, so a new token does not compile until both
 * platforms print and speak it. The preview handback also reads it to decide whether a chord
 * holds a modifier.
 */
export const CHORD_MODIFIER_TOKENS: readonly [...typeof SPELLED_MODIFIER_TOKENS, "Ctrl", "Option"] =
  [...SPELLED_MODIFIER_TOKENS, "Ctrl", "Option"];

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

/**
 * A stored chord in the one spelling the app holds: each modifier named as tinykeys reads it
 * (`Ctrl` is `Control`, `Option` is `Alt`, case ignored), the platform's own modifier as `$mod`,
 * a modifier named twice kept once, the modifiers in spelling order and the key as written. An
 * unknown modifier name is kept as written, for the chord parser to refuse.
 */
export function normalizeChord(chord: string, platform: ChordPlatform): string {
  return chord
    .trim()
    .split(" ")
    .filter((press) => press.length > 0)
    .map((press) => normalizePress(press, platform))
    .join(" ");
}

/** Every token but `$mod`, which is resolved into one of these before a lookup. */
type ResolvedModifierToken = Exclude<ChordModifierToken, "$mod">;

// Typed open because an authored token may be unknown (it must read `undefined`), and checked
// total by `satisfies`.
const DARWIN_MODIFIERS: Readonly<Record<string, ChordKeyRendering>> = {
  Meta: { glyph: "⌘", spoken: "Command" },
  Control: { glyph: "⌃", spoken: "Control" },
  Ctrl: { glyph: "⌃", spoken: "Control" },
  Alt: { glyph: "⌥", spoken: "Option" },
  AltGraph: { glyph: "⌥", spoken: "Option" },
  Option: { glyph: "⌥", spoken: "Option" },
  Shift: { glyph: "⇧", spoken: "Shift" },
} satisfies Readonly<Record<ResolvedModifierToken, ChordKeyRendering>>;

// `Meta` is absent: off macOS the key is branded per platform and `modifierRendering` answers.
const NON_DARWIN_MODIFIERS: Readonly<Record<string, ChordKeyRendering>> = {
  Control: { glyph: "Ctrl", spoken: "Control" },
  Ctrl: { glyph: "Ctrl", spoken: "Control" },
  Alt: { glyph: "Alt", spoken: "Alt" },
  AltGraph: { glyph: "AltGr", spoken: "Alt Graph" },
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
 * A key token folded the way tinykeys compares a key, so `k`, `K` and `KeyK` are one keystroke.
 */
export function foldChordKeyToken(key: string): string {
  return decodeChordKeyToken(key).toUpperCase();
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

// A key token reduced to the character or name it stands for; the printer and the key fold both
// read it. The exact-length tests keep a name such as `Keyboard` from losing its `Key` prefix.
function decodeChordKeyToken(key: string): string {
  const withoutKeyPrefix = key.startsWith("Key") && key.length === 4 ? key.slice(3) : key;
  return withoutKeyPrefix.startsWith("Digit") && withoutKeyPrefix.length === 6
    ? withoutKeyPrefix.slice(5)
    : withoutKeyPrefix;
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

function normalizePress(press: string, platform: ChordPlatform): string {
  const { modifiers, key } = splitChordTokens(press);
  const spelled = [...new Set(modifiers.map((token) => spellModifierToken(token, platform)))];
  return [...spelled.sort((left, right) => rankModifier(left) - rankModifier(right)), key].join(
    "+",
  );
}

// An optional modifier (`[Shift]`) keeps its brackets; an unknown name is kept as written.
function spellModifierToken(token: string, platform: ChordPlatform): string {
  const isOptional = token.startsWith("[") && token.endsWith("]");
  const name = isOptional ? token.slice(1, -1) : token;
  const known = CHORD_MODIFIER_TOKENS.find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  const resolved = known === undefined ? name : (MODIFIER_TOKEN_ALIASES[known] ?? known);
  const spelled =
    resolved === PLATFORM_MODIFIER_TOKEN[platform] ? PLATFORM_MODIFIER_CHORD_TOKEN : resolved;
  return isOptional ? `[${spelled}]` : spelled;
}

/** The tokens tinykeys does not read, each with the modifier a stored chord means by it. */
const MODIFIER_TOKEN_ALIASES: Readonly<Record<string, SpelledModifierToken>> = {
  Ctrl: "Control",
  Option: "Alt",
} satisfies Readonly<
  Record<Exclude<ChordModifierToken, SpelledModifierToken>, SpelledModifierToken>
>;

// Spelling order, an optional modifier just after its held form, unknown names last.
function rankModifier(token: string): number {
  const isOptional = token.startsWith("[");
  const name = isOptional ? token.slice(1, -1) : token;
  const index = SPELLED_MODIFIER_TOKENS.findIndex((spelled) => spelled === name);
  return (index === -1 ? SPELLED_MODIFIER_TOKENS.length : index) * 2 + (isOptional ? 1 : 0);
}
