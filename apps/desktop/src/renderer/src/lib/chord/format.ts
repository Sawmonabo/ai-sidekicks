// How a keyboard chord is spelled, printed and spoken. It lives in `lib/` because `ChordHint` is a
// shared component below the registries; the conflict comparator, the reserved-chord lookup and
// the preview handback fold a key through `foldChordKeyToken`, so they and the printer agree that
// `k`, `K` and `KeyK` are one keystroke.
//
// Each key carries a glyph to show and words to speak, since a screen reader mispronounces glyphs
// such as ⌘; each operating system's keyboard supplies them (`./convention/`). Every renderer takes
// `platform` as a parameter, and `HOST_CHORD_PLATFORM` is the only reading of the host, so a
// fixture can pin one.

import type { SupportedPlatform } from "#shared/app-facts.js";
import type { ChordKeyRendering } from "./convention/contract.js";
import { keyboardConventionOf } from "./convention/selection.js";
import {
  CHORD_MODIFIER_TOKENS,
  PLATFORM_MODIFIER_CHORD_TOKEN,
  SPELLED_MODIFIER_TOKENS,
  type ChordModifierToken,
  type SpelledModifierToken,
} from "./modifiers.js";

/**
 * The chord that opens the command palette.
 *
 * `KeyP` rather than `p` so the binding follows the physical key on any keyboard layout. It
 * lives here because the palette, the keyboard settings page and a shared notice component all
 * print it, and one literal keeps their hints identical.
 */
export const COMMAND_PALETTE_OPEN_CHORD = "$mod+Shift+KeyP";

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

/**
 * A stored chord in the one spelling the app holds: each modifier named as tinykeys reads it
 * (`Ctrl` is `Control`, `Option` is `Alt`, case ignored), the platform's own modifier as `$mod`,
 * a modifier named twice kept once, the modifiers in spelling order and the key as written. An
 * unknown modifier name is kept as written, for the chord parser to refuse.
 */
export function normalizeChord(chord: string, platform: SupportedPlatform): string {
  return chord
    .trim()
    .split(" ")
    .filter((press) => press.length > 0)
    .map((press) => normalizePress(press, platform))
    .join(" ");
}

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
  platform: SupportedPlatform,
): readonly ChordPressRendering[] {
  return chord
    .trim()
    .split(" ")
    .filter((press) => press.length > 0)
    .map((press) => renderSinglePress(press, platform));
}

/** The display form of a chord, each press as `platform` prints one (`⌘K`, `Ctrl+K`). */
export function formatChordForPlatform(chord: string, platform: SupportedPlatform): string {
  const { printPress } = keyboardConventionOf(platform);
  return renderChordForPlatform(chord, platform)
    .map((press) =>
      printPress(
        press.modifiers.map((modifier) => modifier.glyph),
        press.key.glyph,
      ),
    )
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

function modifierRendering(
  token: string,
  platform: SupportedPlatform,
): ChordKeyRendering | undefined {
  const { applicationModifier, modifierKeys } = keyboardConventionOf(platform);
  // `$mod` is resolved first, so no keycap table needs a row for it.
  return modifierKeys[token === PLATFORM_MODIFIER_CHORD_TOKEN ? applicationModifier : token];
}

function keyRendering(key: string, platform: SupportedPlatform): ChordKeyRendering {
  const decoded = decodeChordKeyToken(key);
  const punctuation = PUNCTUATION_CODES[decoded];
  if (punctuation !== undefined) {
    return punctuation;
  }
  const named = keyboardConventionOf(platform).namedKeys[decoded];
  if (named !== undefined) {
    return named;
  }
  // Upper-case a single character so `k` and `K`, one binding in tinykeys, print alike.
  const printed = decoded.length === 1 ? decoded.toUpperCase() : decoded;
  return { glyph: printed, spoken: printed };
}

function renderSinglePress(press: string, platform: SupportedPlatform): ChordPressRendering {
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

function normalizePress(press: string, platform: SupportedPlatform): string {
  const { modifiers, key } = splitChordTokens(press);
  const spelled = [...new Set(modifiers.map((token) => spellModifierToken(token, platform)))];
  return [...spelled.sort((left, right) => rankModifier(left) - rankModifier(right)), key].join(
    "+",
  );
}

// An optional modifier (`[Shift]`) keeps its brackets; an unknown name is kept as written.
function spellModifierToken(token: string, platform: SupportedPlatform): string {
  const isOptional = token.startsWith("[") && token.endsWith("]");
  const name = isOptional ? token.slice(1, -1) : token;
  const known = CHORD_MODIFIER_TOKENS.find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  const resolved = known === undefined ? name : (MODIFIER_TOKEN_ALIASES[known] ?? known);
  const spelled =
    resolved === keyboardConventionOf(platform).applicationModifier
      ? PLATFORM_MODIFIER_CHORD_TOKEN
      : resolved;
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
