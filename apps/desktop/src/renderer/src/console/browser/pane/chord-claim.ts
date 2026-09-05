// What a keystroke IS, and which chords the console is allowed to claim from a page.
//
// `Spec-023 §Console Design (Meridian)` 12.4 and 12.2. The half of the handback that
// is a vocabulary rather than a machine: a keystroke as a DOM-free descriptor, the
// predicates that read one, the projection a main-process mirror is built from, and
// the close-tab chord of 12.2. `keyboard-handback.ts` beside it owns the decision and
// the replay, and imports this; nothing here imports it back.
//
// TWO PREDICATES, ONE SUBTRACTION. `carriesApplicationModifier` reads a keystroke and
// `chordCarriesApplicationModifier` reads an authored chord, and both leave shift out
// for the same reason: a shift-only combination is a capital letter, and a page that
// lost `S` to a "save" binding would be unusable.
//
// THE MIRROR IS FILTERED HERE, NOT AT THE CLAIM SITE. That is what keeps the main
// process from ever holding a chord it must not claim: a bare `KeyS` binding never
// reaches the mirror, so no amount of main-process logic can take `S` away from a page.
//
// AND ONE CHORD VOCABULARY. The modifier token set, the resolution of `$mod`, and the
// splitter that separates a press into its modifiers and its key all come from
// `primitives/chord-format.ts` — the console's chord printer, which needs those same
// three facts to render a chord for a platform that is not the host. All three were
// copies in this family, one of them with a comment admitting it, and the splitter copy
// was a `chord.split("+")` that answers differently from the parser on exactly the
// chords the grammar exists for.
//
// The close-tab chord of 12.2 lives here and not beside the tab strip, because it is
// the same question — is this keystroke the application's? — and a second modifier
// comparison written next to the strip is how the two answers start to disagree.
//
// WHAT IS BUILT AHEAD OF ITS WIRE, AND WHY IT SAYS SO. The close-tab half already has a
// caller: `BrowserPane.tsx` reads a descriptor off a real event and asks this module
// whether it is the chord. The projection does not, and cannot until the browser bridge
// namespace exists to carry a mirror between the main process and the renderer — so
// `projectClaimableChords`, `chordCarriesApplicationModifier`, and the token set they
// share carry a one-line claim naming the growth slate row that owns that wire. The
// claim is the difference between a symbol waiting for a named consumer and one nothing
// will ever import.

import {
  CHORD_MODIFIER_TOKENS,
  PLATFORM_MODIFIER_TOKEN,
  decodeChordKeyToken,
  splitChordTokens,
  type ChordModifierToken,
  type ChordPlatform,
} from "../../primitives/index.js";

/** The key token the platform close-tab chord carries, in its layout-independent form. */
const CLOSE_TAB_KEY_TOKEN = "W";

/**
 * One keystroke, in the fields both halves of the handback read.
 *
 * A descriptor rather than a `KeyboardEvent` because the claim decision has to be
 * makeable where there is no DOM — the mirror it feeds is consulted in the main
 * process — and because a predicate over seven booleans and two strings is one a test
 * can drive exhaustively.
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
 * 12.4's first rule, as a predicate. Shift is deliberately absent from the test: a
 * shift-only combination is a capital letter.
 */
export function carriesApplicationModifier(descriptor: ChordDescriptor): boolean {
  return descriptor.ctrlKey || descriptor.metaKey || descriptor.altKey;
}

/**
 * The modifier tokens that make an authored chord claimable at all.
 *
 * DERIVED from the console's one chord vocabulary rather than restated beside it, so a
 * modifier added there cannot go unconsidered here. Shift is the one subtraction, and
 * it is the same subtraction `carriesApplicationModifier` makes above: a shift-only
 * combination is a capital letter. `$mod` stays, because it resolves to meta on macOS
 * and control elsewhere, so it counts on every platform.
 *
 * This is a PRESENCE test and not a chord parser — it resolves no key and decides no
 * optional modifier, and the console's one chord parser stays
 * `palette/keybinding-chord.ts`.
 */
// Consumed by growth slate row `browser-pane-namespace`
export const CLAIMABLE_MODIFIER_TOKENS: readonly ChordModifierToken[] =
  CHORD_MODIFIER_TOKENS.filter((token) => token !== "Shift");

/** Whether an authored chord names a modifier that makes it claimable at all. */
// Consumed by growth slate row `browser-pane-namespace`
export function chordCarriesApplicationModifier(chord: string): boolean {
  const authored = chord.trim();
  // A SEQUENCE IS NOT CLAIMABLE, and it has to be refused here rather than left to the
  // parser. tinykeys spells a multi-press binding with a space (`$mod+KeyK $mod+KeyB`)
  // and `parseChord` refuses one, so a sequence that reached the mirror would be a
  // chord the main process takes from the page and the renderer can never match: the
  // operator gets a not-claimable refusal for a keystroke that should simply have
  // reached the page. A `chord.split("+")` could not see this at all — it yields
  // `"KeyK $mod"` as one token and finds `$mod` inside it.
  if (/\s/u.test(authored)) {
    return false;
  }
  // The printer's splitter, not a split on `+`: tinykeys' grammar makes `$mod++` a real
  // chord, and a naive split reads its key as an empty token and its modifier set as
  // one member too many.
  const { modifiers } = splitChordTokens(authored);
  const named = new Set(modifiers.map((token) => token.trim().replace(/^\[|\]$/gu, "")));
  return CLAIMABLE_MODIFIER_TOKENS.some((modifier) => named.has(modifier));
}

/**
 * The mirror, as a projection of the chords it was handed.
 *
 * Filtering here rather than at the claim site is what keeps the main process from
 * ever holding a chord it must not claim: a bare `KeyS` binding never reaches the
 * mirror, so no amount of main-process logic can take `S` away from a page.
 */
// Consumed by growth slate row `browser-pane-namespace`
export function projectClaimableChords(chords: readonly string[]): readonly string[] {
  return [...new Set(chords.filter((chord) => chordCarriesApplicationModifier(chord)))].sort();
}

/**
 * The platform close-tab chord of 12.2, as one predicate.
 *
 * "The handler rejects an in-progress composition, rejects alt and shift, and requires
 * the platform's own modifier with the other absent, so the chord closes a tab and
 * never the window." The exclusivity is the part worth stating: on macOS, control-W
 * is a page chord and meta-W is the application's, and a test for "either modifier"
 * would take both.
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
  return closeTabKeyToken(descriptor) === CLOSE_TAB_KEY_TOKEN;
}

/**
 * The chord's key token. `code` first, because it is layout-independent and a
 * `key`-only test binds the chord to whichever letter the operator's layout puts there.
 */
function descriptorKeyToken(descriptor: ChordDescriptor): string {
  return descriptor.code === "" ? descriptor.key : descriptor.code;
}

/**
 * The chord's key, normalised through the console's one decoder so `KeyW`, `w`, and
 * `W` are one keystroke.
 */
function closeTabKeyToken(descriptor: ChordDescriptor): string {
  return decodeChordKeyToken(descriptorKeyToken(descriptor)).toUpperCase();
}

/** The close-tab chord in the console's own authoring grammar, for a hint. */
export const CLOSE_TAB_CHORD = "$mod+KeyW";
