// The typed TS mirror of the Meridian token set. `palette.ts` authors the values; this module
// resolves them (gamut fit, then rounding to the precision the CSS carries) and names them.
// `generate-css.ts` emits the stylesheet from exactly these records, and the contrast check reads
// what the running page paints in each of the four renderings, so a token that passes it is the
// token the browser paints.
//
// Component code writes `var(--meridian-text-muted)` and lets the cascade resolve the theme and
// the scheme. The records exist so a check can hold the cascade to them, and so the agent-hue
// allocator can hand out a wheel step by number.

import {
  COLOR_SCHEMES,
  SYSTEM_SCHEME_PREFERENCE,
  type SchemePair,
  type SchemePreference,
} from "#shared/appearance.js";
import type { OklchColor } from "#shared/color.js";
import { resolveEmittedColor } from "#shared/color.js";
import { tokenVariableName } from "#shared/token-variable.js";
import type { ThemedColor } from "./palette.js";
import {
  ANSI_TOKENS,
  ATTENTION_TOKENS,
  CODE_TOKENS,
  HUE_WHEEL_CHROMA,
  HUE_WHEEL_LIGHTNESS,
  HUE_WHEEL_STEPS,
  GROUND_TOKENS,
  TEXT_TOKENS,
  TOOL_HUE_ALIASES,
  computeHueWheelAngle,
} from "./palette.js";

// The scheme vocabulary is declared in `#shared/appearance.ts`, which main and the renderer both
// read, and every app reader takes it from here.
export {
  COLOR_SCHEMES,
  SYSTEM_SCHEME_PREFERENCE,
  type ColorScheme,
  type SchemePreference,
} from "#shared/appearance.js";

/**
 * Every preference value, derived from the scheme list, so a scheme added there is one a page can
 * offer and read back.
 */
export const SCHEME_PREFERENCES: readonly SchemePreference[] = [
  ...COLOR_SCHEMES,
  SYSTEM_SCHEME_PREFERENCE,
];

/**
 * True when an untrusted value is a scheme preference: a control's value or the scheme attribute
 * read off the document root.
 */
export function isSchemePreference(value: unknown): value is SchemePreference {
  return typeof value === "string" && (SCHEME_PREFERENCES as readonly string[]).includes(value);
}

/**
 * The preference after this one when a person cycles the scheme: following the system,
 * then dark, then light, then back.
 */
export function nextSchemePreference(current: SchemePreference): SchemePreference {
  return NEXT_SCHEME_PREFERENCE[current];
}

/** Each preference's successor in the cycle. Total, so a new preference must take a place. */
const NEXT_SCHEME_PREFERENCE: Readonly<Record<SchemePreference, SchemePreference>> = {
  [SYSTEM_SCHEME_PREFERENCE]: "dark",
  dark: "light",
  light: SYSTEM_SCHEME_PREFERENCE,
};

/** A `var()` reference to a token, for a style object or a template. */
export function tokenReference(tokenName: string): string {
  return `var(${tokenVariableName(tokenName)})`;
}

/**
 * Every color token that varies with the theme or the scheme, resolved, as entries: grounds, then
 * text, then attention, then the code and terminal vocabularies, the order the stylesheet emits.
 *
 * Data and not an exported `Map` (banned in `eslint.restricted-syntax.mjs`): a shared `Map` is
 * one object every importer can write into, and `ReadonlyMap` hides the mutators from nothing at
 * runtime.
 */
export const THEMED_COLOR_TOKENS: readonly (readonly [string, ThemedColor])[] = [
  GROUND_TOKENS,
  TEXT_TOKENS,
  ATTENTION_TOKENS,
  CODE_TOKENS,
  ANSI_TOKENS,
].flatMap((record) =>
  Object.entries(record).map(
    ([tokenName, color]) => [tokenName, resolveThemedColor(color)] as const,
  ),
);

/** The token name of an agent wheel step. */
export function formatHueWheelTokenName(step: number): string {
  return `hue-${String(step).padStart(2, "0")}`;
}

/**
 * The twelve agent hues, resolved and scheme-independent. Index is the wheel step;
 * `AgentHueAllocator` alone decides which step an agent gets.
 */
export const HUE_WHEEL: readonly OklchColor[] = Array.from(
  { length: HUE_WHEEL_STEPS },
  (_unused, step) =>
    resolveEmittedColor({
      lightness: HUE_WHEEL_LIGHTNESS,
      chroma: HUE_WHEEL_CHROMA,
      hueDegrees: computeHueWheelAngle(step),
    }),
);

/** The resolved color of a wheel step. Throws on a step outside the wheel. */
export function readHueWheelColor(step: number): OklchColor {
  const color = HUE_WHEEL[step];
  if (color === undefined) {
    throw new RangeError(`agent hue step ${step} is outside the ${HUE_WHEEL_STEPS}-step wheel`);
  }
  return color;
}

/**
 * The grounds a foreground token can legitimately sit on. The contrast check measures every
 * foreground against every one of these in all four renderings, so a new ground added here
 * widens the assertion rather than escaping it.
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
 * Foreground tokens that carry the 3:1 non-text floor — controls, their boundaries, and marks,
 * the tool verbs' glyph hues among them. `edge` is deliberately absent: it is a decorative
 * hairline, not a control boundary (see `palette.ts`).
 */
export const NON_TEXT_FLOOR_TOKEN_NAMES: readonly string[] = [
  "edge-strong",
  "amber-mark",
  "red-mark",
  "accent",
  "accent-pressed",
  ...Object.keys(TOOL_HUE_ALIASES),
];

/**
 * Tinted grounds paired with the text token that must stay legible on them: an amber banner's
 * copy sits on `amber-ground`, not `surface`, so the pair needs its own floor.
 */
export const TINTED_GROUND_PAIRS: readonly (readonly [string, string])[] = [
  ["amber-text", "amber-ground"],
  ["red-text", "red-ground"],
];

/**
 * Ink paired with the fill it is painted on: a control whose whole face is the accent. Its own
 * list, not a third entry of `TINTED_GROUND_PAIRS`, because a tinted ground is a wash that can
 * carry other text while an accent fill admits exactly one ink. Every face the control wears is a
 * row, so `accent-pressed` is paired as the resting face is. `accent-ink` is absent from
 * `TEXT_FLOOR_TOKEN_NAMES` because that list is measured on the four neutral grounds, where a
 * dark ink would rightly fail.
 */
export const ACCENT_FILL_PAIRS: readonly (readonly [string, string])[] = [
  ["accent-ink", "accent"],
  ["accent-ink", "accent-pressed"],
];

/**
 * The one ground a code block or command-output body is painted on. Named rather than folded
 * into `GROUND_TOKEN_NAMES`, since measuring these vocabularies on the four neutral grounds
 * would hold them to a floor on grounds they are never painted over.
 */
export const SUNKEN_WELL_GROUND_TOKEN_NAME = "surface-sunken";

/**
 * The foregrounds painted on that well: the code-token kinds and the ANSI names. Derived from
 * the two palette records so a token added there is measured on the same commit.
 */
export const SUNKEN_WELL_TEXT_TOKEN_NAMES: readonly string[] = [
  ...Object.keys(CODE_TOKENS),
  ...Object.keys(ANSI_TOKENS),
];

/** The WCAG 2.2 AA floor for body and UI text. */
export const TEXT_CONTRAST_FLOOR = 4.5;

/** The WCAG 2.2 AA floor for non-text controls, boundaries, and marks. */
export const NON_TEXT_CONTRAST_FLOOR = 3;

function resolveThemedColor(color: ThemedColor): ThemedColor {
  return {
    meridian: resolveSchemePair(color.meridian),
    graphite: resolveSchemePair(color.graphite),
  };
}

function resolveSchemePair(pair: SchemePair): SchemePair {
  return { light: resolveEmittedColor(pair.light), dark: resolveEmittedColor(pair.dark) };
}
