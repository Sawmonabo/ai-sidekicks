// The typed TS mirror of the Meridian token set.
//
// `palette.ts` authors the values; this module resolves them (gamut fit, then
// rounding to the precision the CSS carries) and names them. Two consumers:
// `generate-css.ts`, which emits `meridian.css` from exactly these records, and
// `contrast.test.ts`, which measures exactly these records against the WCAG 2.2
// AA floors `Spec-023 §Console Design (Meridian)` rule 3 states. Because both
// read the same resolved values, a token that passes the contrast test is the
// token the browser paints — there is no second table to drift.
//
// Component code never reaches into these records for a color. It writes
// `var(--meridian-text-muted)` and lets the cascade resolve the scheme; the
// records exist so a TEST can measure what the cascade will resolve to, and so
// the participant-hue allocator can hand a caller a wheel step by number.

import type { OklchColor } from "./color.js";
import { resolveEmittedColor } from "./color.js";
import type { SchemePair } from "./palette.js";
import {
  ATTENTION_TOKENS,
  PARTICIPANT_HUE_CHROMA,
  PARTICIPANT_HUE_LIGHTNESS,
  PARTICIPANT_HUE_STEPS,
  SURFACE_TOKENS,
  TEXT_TOKENS,
  participantHueAngle,
} from "./palette.js";

/**
 * Every console scheme, in the order the gallery and the screenshot tier walk them.
 *
 * The tuple is the declaration and `ConsoleScheme` follows from it, for the reason
 * `SCHEME_PREFERENCES` states below at one remove: a scheme list and a scheme union
 * written separately agree until one is widened, and every walk in the console
 * iterates the list while every switch checks the union.
 */
export const CONSOLE_SCHEMES = ["light", "dark"] as const;

/** The color schemes the console renders in, derived from the tuple above. */
export type ConsoleScheme = (typeof CONSOLE_SCHEMES)[number];

/**
 * The preference value that names no scheme and defers to the operating system.
 *
 * A constant rather than the literal at each site because it is the one member of
 * the preference vocabulary that is NOT a scheme, and every place that has to tell
 * the two apart reads better naming it than testing a string.
 */
export const SYSTEM_SCHEME_PREFERENCE = "system";

/**
 * What a person can CHOOSE, as opposed to what the console renders in.
 *
 * The distinction is load-bearing: `ConsoleScheme` is a resolved answer and always
 * paints something, while a preference may decline to answer and hand the question
 * to the OS. Nothing renders a `SchemePreference`; the frame resolves it first.
 */
export type SchemePreference = ConsoleScheme | typeof SYSTEM_SCHEME_PREFERENCE;

/**
 * Every preference value, DERIVED from the scheme list rather than re-listed.
 *
 * This vocabulary had three hand-written copies — one in the store, one in the
 * persistence value classes, one here — and the way that fails is silent: a third
 * scheme would be renderable, refused on write, and accepted on read, each by a
 * different list. Deriving it means adding a scheme widens all three at once.
 */
export const SCHEME_PREFERENCES: readonly SchemePreference[] = [
  ...CONSOLE_SCHEMES,
  SYSTEM_SCHEME_PREFERENCE,
];

/**
 * True when an untrusted value is still a scheme preference.
 *
 * The single guard, used by the persistence chokepoint on the way in and by the
 * frame's hydration on the way back. Two guards is how a record written by an
 * older build gets accepted on read after being refused on write.
 */
export function isSchemePreference(value: unknown): value is SchemePreference {
  return typeof value === "string" && (SCHEME_PREFERENCES as readonly string[]).includes(value);
}

/** The CSS custom-property prefix every Meridian token carries. */
export const TOKEN_PREFIX = "--meridian-";

/** The CSS custom-property name for a token. */
export function tokenVariableName(tokenName: string): string {
  return `${TOKEN_PREFIX}${tokenName}`;
}

/** A `var()` reference to a token, for a style object or a template. */
export function tokenReference(tokenName: string): string {
  return `var(${tokenVariableName(tokenName)})`;
}

function resolve(color: OklchColor): OklchColor {
  return resolveEmittedColor(color);
}

function resolvePairs(source: Readonly<Record<string, SchemePair>>): Map<string, SchemePair> {
  const resolved = new Map<string, SchemePair>();
  for (const [tokenName, pair] of Object.entries(source)) {
    resolved.set(tokenName, { light: resolve(pair.light), dark: resolve(pair.dark) });
  }
  return resolved;
}

/**
 * Every scheme-varying color token, resolved. Insertion order is surfaces, then
 * text, then attention — the order `meridian.css` emits, so the generated file
 * reads top-down from ground to signal.
 */
export const SCHEME_COLOR_TOKENS: ReadonlyMap<string, SchemePair> = new Map([
  ...resolvePairs(SURFACE_TOKENS),
  ...resolvePairs(TEXT_TOKENS),
  ...resolvePairs(ATTENTION_TOKENS),
]);

/** The token name of a participant wheel step. */
export function participantHueTokenName(step: number): string {
  return `hue-${String(step).padStart(2, "0")}`;
}

/**
 * The twelve participant hues, resolved and scheme-independent. Index is the
 * wheel step; `ParticipantHueAllocator` is the only thing that decides WHICH
 * step a participant gets.
 */
export const PARTICIPANT_HUES: readonly OklchColor[] = Array.from(
  { length: PARTICIPANT_HUE_STEPS },
  (_unused, step) =>
    resolve({
      lightness: PARTICIPANT_HUE_LIGHTNESS,
      chroma: PARTICIPANT_HUE_CHROMA,
      hueDegrees: participantHueAngle(step),
    }),
);

/** The resolved color of a wheel step. Throws on a step outside the wheel. */
export function participantHue(step: number): OklchColor {
  const color = PARTICIPANT_HUES[step];
  if (color === undefined) {
    throw new RangeError(
      `participant hue step ${step} is outside the ${PARTICIPANT_HUE_STEPS}-step wheel`,
    );
  }
  return color;
}

/**
 * The grounds a foreground token can legitimately sit on. The contrast test
 * measures every foreground against every one of these in both schemes, so a new
 * ground added here widens the assertion rather than escaping it.
 */
export const GROUND_TOKEN_NAMES: readonly string[] = [
  "ground",
  "surface",
  "surface-raised",
  "surface-sunken",
];

/** Foreground tokens that carry the 4.5:1 body-and-UI-text floor. */
export const TEXT_FLOOR_TOKEN_NAMES: readonly string[] = [
  "text",
  "text-muted",
  "text-faint",
  "amber-text",
  "red-text",
  "accent-text",
];

/**
 * Foreground tokens that carry the 3:1 non-text floor — controls, their
 * boundaries, marks, and focus rings. `edge` is deliberately absent: it is a
 * decorative hairline, not a control boundary (see `palette.ts`).
 */
export const NON_TEXT_FLOOR_TOKEN_NAMES: readonly string[] = [
  "edge-strong",
  "amber-mark",
  "red-mark",
  "accent",
  "focus-ring",
];

/**
 * Tinted grounds paired with the text token that must remain legible on them —
 * an amber banner's copy sits on `amber-ground`, not on `surface`, so the pair
 * needs its own floor.
 */
export const TINTED_GROUND_PAIRS: readonly (readonly [string, string])[] = [
  ["amber-text", "amber-ground"],
  ["red-text", "red-ground"],
];

/**
 * Ink paired with the FILL it is painted on — a control whose whole face is the
 * accent, not a tinted ground with text on it.
 *
 * Its own list on `TINTED_GROUND_PAIRS`' shape rather than a third entry in that
 * one, because the two describe different things and the difference is what
 * decides the value: a tinted ground is a wash a surface can also carry other text
 * on, while an accent fill is a control's face and admits exactly one ink. Folding
 * them together would put `accent-ink` in a list named for grounds and invite the
 * next reader to paint it on `amber-ground`.
 *
 * `accent-ink` is deliberately absent from `TEXT_FLOOR_TOKEN_NAMES`: that list is
 * measured against the four neutral grounds, and this ink is never painted on one.
 * A token measured where it is never used would be held to a floor that has
 * nothing to do with it — and would fail, since a dark ink on a dark ground is
 * exactly what it should be.
 */
export const ACCENT_FILL_PAIRS: readonly (readonly [string, string])[] = [["accent-ink", "accent"]];

/** The WCAG 2.2 AA floor for body and UI text. */
export const TEXT_CONTRAST_FLOOR = 4.5;

/** The WCAG 2.2 AA floor for non-text controls, boundaries, marks, and focus rings. */
export const NON_TEXT_CONTRAST_FLOOR = 3;

/** Resolve a scheme-varying color token for one scheme. Throws on an unknown name. */
export function schemeColor(tokenName: string, scheme: ConsoleScheme): OklchColor {
  const pair = SCHEME_COLOR_TOKENS.get(tokenName);
  if (pair === undefined) {
    throw new RangeError(`unknown Meridian color token ${tokenName}`);
  }
  return pair[scheme];
}
