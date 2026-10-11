// The modifier tokens a chord is written in: the ones tinykeys reads, the two an authored chord may
// also name, and `$mod`, which stands for the operating system's own application modifier.

/** The token an authored chord uses for the platform's own application modifier. */
export const PLATFORM_MODIFIER_CHORD_TOKEN = "$mod";

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
 * then `Ctrl` and `Option`, which reading a stored chord turns into `Control` and `Alt`. Each
 * operating system's keycap table is checked total over it, so a new token does not compile until
 * every system prints and speaks it. The preview handback also reads it to decide whether a chord
 * holds a modifier.
 */
export const CHORD_MODIFIER_TOKENS: readonly [...typeof SPELLED_MODIFIER_TOKENS, "Ctrl", "Option"] =
  [...SPELLED_MODIFIER_TOKENS, "Ctrl", "Option"];

/** One modifier token an authored chord names. */
export type ChordModifierToken = (typeof CHORD_MODIFIER_TOKENS)[number];

/** Every token but `$mod`, which is resolved into one of these before a keycap is looked up. */
export type ResolvedModifierToken = Exclude<
  ChordModifierToken,
  typeof PLATFORM_MODIFIER_CHORD_TOKEN
>;
