// Keystroke vocabulary for the handback: a DOM-free descriptor, the predicates that read one,
// the chord projection a main-process mirror is built from, and the close-tab chord.
// Shift never makes a chord claimable, because a shift-only combination is a capital letter.
// Modifier tokens, `$mod` and the press splitter come from `lib/chord-format.ts`, not a copy.

import {
  CHORD_MODIFIER_TOKENS,
  PLATFORM_MODIFIER_TOKEN,
  foldChordKeyToken,
  splitChordTokens,
  type ChordModifierToken,
  type ChordPlatform,
} from "#renderer/lib/chord-format.js";

/** The key token the platform close-tab chord carries, in its layout-independent form. */
const CLOSE_TAB_KEY_TOKEN = "W";

/**
 * One keystroke, in the fields both halves of the handback read. A plain descriptor rather
 * than a `KeyboardEvent`, so the claim can be decided where there is no DOM (the main process).
 */
export interface ChordDescriptor {
  /** `KeyboardEvent.key` — layout-dependent, so it is the fallback and not the key. */
  readonly key: string;
  /** `KeyboardEvent.code` — layout-independent, which is what the console binds on. */
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}

/** Read a descriptor off a real event. The one place the DOM shape is depended on. */
export function describeChordEvent(event: KeyboardEvent): ChordDescriptor {
  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    isComposing: event.isComposing,
  };
}

/**
 * Whether a keystroke carries control, meta or alt, the first claim rule.
 * Shift is not tested: a shift-only combination is a capital letter.
 */
export function carriesApplicationModifier(descriptor: ChordDescriptor): boolean {
  return descriptor.ctrlKey || descriptor.metaKey || descriptor.altKey;
}

/**
 * The modifier tokens that make an authored chord claimable: every chord modifier except Shift.
 * `$mod` stays because it resolves to meta on macOS and control elsewhere. A presence test, not
 * a parser; the chord parser is `registries/keybindings/chord.ts`.
 */
export const CLAIMABLE_MODIFIER_TOKENS: readonly ChordModifierToken[] =
  CHORD_MODIFIER_TOKENS.filter((token) => token !== "Shift");

/** Whether an authored chord names a modifier that makes it claimable at all. */
export function chordCarriesApplicationModifier(chord: string): boolean {
  const authored = chord.trim();
  // A sequence is refused here because `parseChord` refuses it: tinykeys spells one with a
  // space, and a sequence in the mirror would be taken from the page yet never matched.
  if (/\s/u.test(authored)) {
    return false;
  }
  // `$mod++` is a real chord that a split on `+` misreads, so use the printer's splitter.
  const { modifiers } = splitChordTokens(authored);
  const named = new Set(modifiers.map((token) => token.trim().replace(/^\[|\]$/gu, "")));
  return CLAIMABLE_MODIFIER_TOKENS.some((modifier) => named.has(modifier));
}

/**
 * The mirror as a projection of the chords it was handed. Filtering here keeps the main
 * process from ever holding a chord it must not claim: a bare `KeyS` never reaches the mirror.
 */
export function projectClaimableChords(chords: readonly string[]): readonly string[] {
  return [...new Set(chords.filter((chord) => chordCarriesApplicationModifier(chord)))].sort();
}

/**
 * Whether a keystroke is the platform close-tab chord. The platform modifier must be held
 * with the other absent (on macOS control-W is a page chord, meta-W the application's);
 * composition, alt and shift are rejected.
 */
export function isCloseTabChord(descriptor: ChordDescriptor, platform: ChordPlatform): boolean {
  if (descriptor.isComposing || descriptor.altKey || descriptor.shiftKey) {
    return false;
  }
  const platformModifierIsMeta = PLATFORM_MODIFIER_TOKEN[platform] === "Meta";
  const platformModifierHeld = platformModifierIsMeta ? descriptor.metaKey : descriptor.ctrlKey;
  const otherModifierHeld = platformModifierIsMeta ? descriptor.ctrlKey : descriptor.metaKey;
  if (!platformModifierHeld || otherModifierHeld) {
    return false;
  }
  return foldChordKeyToken(descriptorKeyToken(descriptor)) === CLOSE_TAB_KEY_TOKEN;
}

/** The key token of a chord, `code` first because it is layout-independent. */
function descriptorKeyToken(descriptor: ChordDescriptor): string {
  return descriptor.code === "" ? descriptor.key : descriptor.code;
}

/** The close-tab chord in the console's own authoring grammar, for a hint. */
export const CLOSE_TAB_CHORD = "$mod+KeyW";
