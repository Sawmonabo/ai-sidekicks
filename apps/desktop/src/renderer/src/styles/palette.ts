// The Meridian palette: the single source of truth for every app color. The agent hue wheel,
// the two attention hues with their WCAG 2.2 AA floors, and the colors type and figures are
// painted in are realized here and nowhere else. `generate-css.ts` builds the stylesheet from
// this module, so there is no second copy to drift.
//
// Authoring rules this file obeys:
//
//   • Hue answers "who" and never "how urgent". The twelve agent steps are one scheme-independent
//     set, because identity does not change when the person flips the theme. One lightness
//     (`HUE_WHEEL_LIGHTNESS`) clears 3:1 as an edge or mark against both schemes' grounds, which
//     is why it sits mid-scale.
//   • Amber means a person is needed; red means something failed; the accent is one desaturated
//     cyan on interactive affordances. Each carries a `-text` variant at the 4.5:1 floor and a
//     `-mark` variant at the 3:1 floor, because one value cannot serve both.
//   • `edge` is a decorative hairline with no contrast floor; `edge-strong` is the boundary of a
//     non-text control and carries 3:1. The non-text floor covers controls, their boundaries and
//     focus rings. A table rule or section divider is none of those, and forcing 3:1 onto every
//     hairline would make the high-contrast grid the density budget exists to avoid.
//
// The values below are requests, not emitted values. `tokens.ts` resolves each through
// `resolveEmittedColor` (rounded to the precision the CSS carries, then chroma-fitted into sRGB),
// and both `generate-css.ts` and `contrast.test.ts` read that record, so the number measured is
// the number painted.

import { MERIDIAN_GROUND_COLORS } from "#shared/appearance.js";
import type { OklchColor } from "#shared/color.js";
// The enumeration row height and the transcript's row gap are products of the type scale and line
// heights from `typography.ts`, a leaf that imports nothing local, and the spacing scale here.
import { BODY_LINE_HEIGHT, READING_LINE_HEIGHT, TYPE_SCALE_REM } from "./typography.js";

/**
 * Rows a bounded enumeration shows before it scrolls. A ceiling, not a preference: the shortest
 * window the app ships is 720 px tall, 45 rem at the 16 px root, and an enumeration taking more
 * than a third of it leaves nothing else on screen. Six rows is 13.875 rem and clears that third;
 * seven is 16.1875 rem and does not.
 */
export const BOUNDED_ENUMERATION_MAX_ROWS = 6;

/** A token whose value differs between the light and dark schemes. */
export interface SchemePair {
  readonly light: OklchColor;
  readonly dark: OklchColor;
}

function oklch(lightness: number, chroma: number, hueDegrees: number): OklchColor {
  return { lightness, chroma, hueDegrees };
}

/**
 * Ground, surface, and boundary tokens.
 *
 * `ground` is the window's own field, `surface` a pane's, `surfaceRaised` an
 * overlay's, `surfaceSunken` a well (a code block, an input trough).
 */
export const GROUND_TOKENS: Readonly<Record<string, SchemePair>> = {
  ground: MERIDIAN_GROUND_COLORS,
  surface: { light: oklch(0.995, 0.001, 255), dark: oklch(0.203, 0.013, 255) },
  "surface-raised": { light: oklch(1, 0, 255), dark: oklch(0.246, 0.014, 255) },
  "surface-sunken": { light: oklch(0.93, 0.005, 255), dark: oklch(0.132, 0.01, 255) },
  edge: { light: oklch(0.885, 0.006, 255), dark: oklch(0.3, 0.014, 255) },
  "edge-strong": { light: oklch(0.61, 0.014, 255), dark: oklch(0.538, 0.016, 255) },
};

/** Text tokens. All three clear 4.5:1 on every ground token above. */
export const TEXT_TOKENS: Readonly<Record<string, SchemePair>> = {
  text: { light: oklch(0.24, 0.014, 255), dark: oklch(0.955, 0.004, 255) },
  "text-muted": { light: oklch(0.455, 0.016, 255), dark: oklch(0.775, 0.012, 255) },
  "text-faint": { light: oklch(0.515, 0.014, 255), dark: oklch(0.665, 0.014, 255) },
};

/**
 * The two attention hues plus the one accent. Nothing else in the app is colored for
 * attention; a third attention hue here breaks the rule.
 */
export const ATTENTION_TOKENS: Readonly<Record<string, SchemePair>> = {
  "amber-text": { light: oklch(0.5, 0.13, 65), dark: oklch(0.845, 0.135, 80) },
  "amber-mark": { light: oklch(0.615, 0.155, 68), dark: oklch(0.76, 0.155, 72) },
  "amber-ground": { light: oklch(0.955, 0.04, 80), dark: oklch(0.26, 0.045, 72) },
  "red-text": { light: oklch(0.485, 0.19, 25), dark: oklch(0.775, 0.145, 25) },
  "red-mark": { light: oklch(0.575, 0.215, 25), dark: oklch(0.66, 0.19, 25) },
  "red-ground": { light: oklch(0.95, 0.03, 25), dark: oklch(0.25, 0.055, 25) },
  accent: { light: oklch(0.575, 0.09, 215), dark: oklch(0.73, 0.085, 205) },
  "accent-text": { light: oklch(0.475, 0.1, 215), dark: oklch(0.845, 0.075, 205) },
  // The ink for a control filled with `accent`, and nothing else. `accent-text` is for
  // accent-colored text on a neutral ground; on the accent itself it reaches 1.53:1 in light and
  // 1.48:1 in dark, so the pair needs its own token, as `-text` and `-mark` do.
  //
  // Dark in both schemes, which is forced: a light ink cannot clear 4.5:1 on the light accent
  // (the lightest thing the palette has, `surface-raised`, reaches 4.23:1, and `text` 3.89:1).
  // So the light leg sits at L 0.13 (4.75:1). The dark leg, on a lighter accent, sits at L 0.22
  // (7.41:1), the lightness of the dark scheme's own surfaces, so a filled control reads as the
  // app's ground punched out of the accent. Both carry a little of the accent's chroma.
  "accent-ink": { light: oklch(0.13, 0.03, 215), dark: oklch(0.22, 0.04, 205) },
  // The face of a pressed accent-filled control, a token rather than a `filter`: `brightness()`
  // scales both rendered colors, and scaling does not preserve a contrast ratio because relative
  // luminance carries a 0.05 offset. `brightness(0.94)` on the light face takes the `accent-ink`
  // pair from 4.75:1 to 4.27:1, through the 4.5:1 text floor.
  //
  // How far the light face may darken is arithmetic. The ink is dark in both schemes, so
  // contrast is monotone in the fill's luminance, and 4.5:1 against an ink of luminance L needs a
  // fill above 4.5 * (L + 0.05) - 0.05. Even a pure-black ink puts that at 0.175 and the light
  // accent's luminance is 0.198, so no ink buys a visibly darker press. The light leg takes the
  // deepest face the floor admits, L 0.565 at 4.57:1, with chroma up against the sRGB edge so it
  // reads deeper rather than dimmer; `accent-fill.css` carries the rest of the press on the
  // control's boundary. The dark leg can afford a real deepening: L 0.68 at 6.18:1.
  //
  // Both legs clear the 3:1 non-text floor on all four grounds (3.58 light, 5.83 dark) and are
  // measured there, because a pressed control's face is still the boundary a person must find.
  "accent-pressed": { light: oklch(0.565, 0.099, 215), dark: oklch(0.68, 0.095, 205) },
};

/**
 * The four code span classes that carry a color of their own; a comment is an alias. They live
 * here rather than in the transcript's sheet so they are fitted into the sRGB gamut and measured
 * against their ground like every other color. A separate record from `ATTENTION_TOKENS`, since
 * the two-hue rule governs what the app colors for attention and a keyword is not one.
 * Painted on `surface-sunken` alone, the ground the contrast census measures them against.
 */
export const CODE_TOKENS: Readonly<Record<string, SchemePair>> = {
  "code-keyword": { light: oklch(0.45, 0.12, 300), dark: oklch(0.8, 0.11, 300) },
  "code-name": { light: oklch(0.44, 0.1, 250), dark: oklch(0.82, 0.09, 250) },
  "code-string": { light: oklch(0.42, 0.1, 150), dark: oklch(0.83, 0.1, 150) },
  "code-number": { light: oklch(0.45, 0.11, 45), dark: oklch(0.83, 0.1, 60) },
};

/**
 * The twelve hued ANSI names, as the app's own colors rather than a terminal's.
 *
 * "Bright" is not a lightness rule. On the dark scheme brighter means higher contrast, but on
 * the light scheme it spends contrast because the ground is near white. So a light bright name
 * differs by chroma first and lightness second, at the deepest lightness the 4.5:1 floor admits
 * with a little margin, still above its normal sibling so the names stay pairs. A run whose
 * background the stream set is outside the census: which pairs a stream composes is its own, and
 * no palette can hold every one of them to a text floor.
 */
export const ANSI_TOKENS: Readonly<Record<string, SchemePair>> = {
  "ansi-red": { light: oklch(0.48, 0.16, 25), dark: oklch(0.76, 0.14, 25) },
  "ansi-green": { light: oklch(0.45, 0.12, 150), dark: oklch(0.8, 0.12, 150) },
  "ansi-yellow": { light: oklch(0.48, 0.11, 85), dark: oklch(0.84, 0.11, 85) },
  "ansi-blue": { light: oklch(0.46, 0.11, 255), dark: oklch(0.79, 0.1, 255) },
  "ansi-magenta": { light: oklch(0.47, 0.13, 330), dark: oklch(0.79, 0.12, 330) },
  "ansi-cyan": { light: oklch(0.46, 0.09, 205), dark: oklch(0.81, 0.08, 205) },
  "ansi-bright-red": { light: oklch(0.535, 0.18, 25), dark: oklch(0.83, 0.14, 25) },
  "ansi-bright-green": { light: oklch(0.5, 0.14, 150), dark: oklch(0.87, 0.13, 150) },
  "ansi-bright-yellow": { light: oklch(0.515, 0.12, 85), dark: oklch(0.9, 0.11, 85) },
  "ansi-bright-blue": { light: oklch(0.515, 0.13, 255), dark: oklch(0.86, 0.1, 255) },
  "ansi-bright-magenta": { light: oklch(0.53, 0.15, 330), dark: oklch(0.86, 0.12, 330) },
  "ansi-bright-cyan": { light: oklch(0.505, 0.1, 205), dark: oklch(0.88, 0.08, 205) },
};

/**
 * Tokens that are a code or terminal name for an app token, not a color. A code block's plain
 * text is the app's text, and a terminal's black and white are the two ends of the reading
 * scale; a literal black on a dark scheme would render output invisible. Each is a `var()`
 * reference to its target, so it paints what the target paints and stays in the contrast census
 * through it. Scheme-independent for that reason, so it is emitted once in the root block.
 */
export const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  "code-plain": "text",
  "code-comment": "text-faint",
  "ansi-default-foreground": "text",
  "ansi-default-background": "surface-sunken",
  "ansi-black": "text-faint",
  "ansi-white": "text-muted",
  "ansi-bright-black": "text-muted",
  "ansi-bright-white": "text",
};

/** Steps on the agent wheel: twelve. */
export const HUE_WHEEL_STEPS = 12;

/**
 * Fixed lightness for every agent hue, one value for both schemes because identity color does not
 * change with the theme. Holding the whole wheel to 3:1 leaves one narrow feasible band at this
 * chroma, roughly 0.545 to 0.600: the light scheme's worst step (5, against `surface-sunken`)
 * falls through 3:1 just above L 0.600, and the dark scheme's worst (step 11, against
 * `surface-raised`) just below L 0.545. This sits near the middle, with headroom of about 3.43
 * light and 3.37 dark.
 */
export const HUE_WHEEL_LIGHTNESS = 0.57;

/**
 * Requested chroma for every agent hue. Green and cyan cannot hold it in sRGB at this lightness,
 * so those steps are chroma-fitted down; lightness stays even, which carries the "one set"
 * reading.
 */
export const HUE_WHEEL_CHROMA = 0.135;

/**
 * Hue angle of step 0, offset from 0° so no agent lands on the pure red that the failed-state
 * token owns.
 */
export const HUE_WHEEL_ORIGIN_DEGREES = 20;

/** Degrees between adjacent wheel steps. */
export const HUE_WHEEL_STEP_DEGREES: number = 360 / HUE_WHEEL_STEPS;

/** The hue angle of a wheel step, in degrees. */
export function computeHueWheelAngle(step: number): number {
  return (HUE_WHEEL_ORIGIN_DEGREES + step * HUE_WHEEL_STEP_DEGREES + 360) % 360;
}

/** Spacing scale, in rem, on a 4 px base at the 16 px root. */
export const SPACE_SCALE_REM: Readonly<Record<string, number>> = {
  "space-1": 0.25,
  "space-2": 0.5,
  "space-3": 0.75,
  "space-4": 1,
  "space-5": 1.5,
  "space-6": 2,
  "space-8": 3,
};

/** Corner radii, in rem. Chrome is nearly square; only overlays round. */
export const RADIUS_SCALE_REM: Readonly<Record<string, number>> = {
  "radius-sm": 0.1875,
  "radius-md": 0.375,
  "radius-lg": 0.625,
};

/**
 * The leading edge's width, in px: wide enough to carry a hue at a glance, narrow enough
 * that a screen of rows reads as a log rather than a striped table.
 */
export const LEADING_EDGE_WIDTH_PX = 2;

/** The navigation rail's square button, in rem: its hit target. */
export const RAIL_BUTTON_SIZE_REM = 2.25;

/**
 * The navigation rail's width, in rem: its button with one `space-2` margin either side, 52 px at
 * the default text size. Root-relative like every chrome width, so it grows with the text size.
 */
export const RAIL_WIDTH_REM: number =
  RAIL_BUTTON_SIZE_REM + 2 * scaleStep(SPACE_SCALE_REM, "space-2");

/**
 * One step of a rem scale, such as `SPACE_SCALE_REM` or `TYPE_SCALE_REM`. Throws on an unknown
 * step so a typo cannot become `NaNrem`, which the browser discards silently.
 */
export function scaleStep(scale: Readonly<Record<string, number>>, stepName: string): number {
  const sizeRem = scale[stepName];
  if (sizeRem === undefined) {
    throw new RangeError(`unknown Meridian scale step ${stepName}`);
  }
  return sizeRem;
}

/**
 * The height one row of an enumeration occupies, in rem: one `text-md` line box at the body line
 * height plus a `space-2` above and below. Derived so a bounded list is capped in rows, and a
 * change to the type or space scale moves every cap.
 */
export const ENUMERATION_ROW_HEIGHT_REM: number =
  scaleStep(TYPE_SCALE_REM, "text-md") * BODY_LINE_HEIGHT +
  2 * scaleStep(SPACE_SCALE_REM, "space-2");

/**
 * The height a bounded enumeration scrolls past, in rem: {@link BOUNDED_ENUMERATION_MAX_ROWS}
 * times the row height, computed where the two meet so a stylesheet writes
 * `max-height: var(--meridian-enumeration-max-height)` and never multiplies.
 */
export const BOUNDED_ENUMERATION_HEIGHT_REM: number =
  BOUNDED_ENUMERATION_MAX_ROWS * ENUMERATION_ROW_HEIGHT_REM;

/**
 * The one gap between any two consecutive transcript rows, in rem: half the reply's reading line,
 * a `text-sm` line box at the reading line height, so it moves with the text size.
 */
export const TRANSCRIPT_ROW_GAP_REM: number =
  (scaleStep(TYPE_SCALE_REM, "text-sm") * READING_LINE_HEIGHT) / 2;

/**
 * The narrowest viewport the app lays out in, in CSS px. WCAG 2.2 SC 1.4.10 (Reflow) asks
 * that vertically scrolling content be usable without two-dimensional scrolling at 320 CSS px,
 * the width a 1280 px window reaches at 400% zoom.
 *
 * A floor the frame declares, not a breakpoint: one fluid layout holds down to this width,
 * `layout/AppShell/app-frame.css` spends it as the frame's `min-width`, and below it the document
 * scrolls horizontally. A px value because that is the criterion's unit; a rem floor would move
 * under a person who raised the root font size.
 */
export const REFLOW_MIN_WIDTH_PX = 320;
