// The Meridian palette: the single source of truth for every app color, in both themes. The agent
// hue wheel, the two attention hues with their WCAG 2.2 AA floors, and the colors type and figures
// are painted in are realized here and nowhere else. `generate-css.ts` builds the stylesheet from
// this module, so there is no second copy to drift.
//
// Two themes, Meridian and Graphite, each in a light and a dark scheme: four renderings. Every
// color token is declared once with all four values, so the token set is the union of both themes'
// needs by construction and a token one theme lacks does not compile. A theme changes colors and
// nothing else; the scales below are shared.
//
// Authoring rules this file obeys:
//
//   • Hue answers "who" and never "how urgent". The twelve agent steps are one scheme- and
//     theme-independent set, because identity does not change when the person flips the theme. One
//     lightness (`HUE_WHEEL_LIGHTNESS`) clears 3:1 as an edge or mark against every rendering's
//     grounds, which is why it sits mid-scale.
//   • Amber means a person is needed; red means something failed; the accent is one desaturated
//     cyan on interactive affordances. Each carries a `-text` variant at the 4.5:1 floor and a
//     `-mark` variant at the 3:1 floor, because one value cannot serve both.
//   • `edge` is a decorative hairline with no contrast floor; `edge-strong` is the boundary of a
//     non-text control and carries 3:1. The non-text floor covers controls, their boundaries and
//     focus rings. A table rule or section divider is none of those, and forcing 3:1 onto every
//     hairline would make the high-contrast grid the density budget exists to avoid.
//   • Graphite is warm graphite neutrals at hue 80 in light and 60 in dark with a cyan accent. Its
//     quieter text steps, its control boundary, its code and terminal colors and its wells are
//     opaque values set at the lightness each floor admits on its own grounds, so every pair is
//     measured as it is painted rather than composited at run time.
//
// The values below are requests, not emitted values. `tokens.ts` resolves each through
// `resolveEmittedColor` (rounded to the precision the CSS carries, then chroma-fitted into sRGB),
// and `generate-css.ts` emits that record, so the color a rendering's contrast check reads off the
// running page is the color requested here.

import {
  THEME_GROUND_COLORS,
  type AppearanceTheme,
  type ColorScheme,
  type SchemePair,
} from "#shared/appearance.js";
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

/** A color token's four values: each theme's light and dark. */
export type ThemedColor = Readonly<Record<AppearanceTheme, SchemePair>>;

function oklch(lightness: number, chroma: number, hueDegrees: number): OklchColor {
  return { lightness, chroma, hueDegrees };
}

/**
 * Ground, surface, and boundary tokens.
 *
 * `ground` is the window's own field, `surface` a pane's, `surfaceRaised` an
 * overlay's, `surfaceSunken` a well (a code block, an input trough). Graphite's wells sit at the
 * lightness the agent wheel still clears 3:1 against, which pulls its ramp a little tighter than
 * Meridian's.
 */
export const GROUND_TOKENS: Readonly<Record<string, ThemedColor>> = {
  ground: THEME_GROUND_COLORS,
  surface: {
    meridian: { light: oklch(0.995, 0.001, 255), dark: oklch(0.203, 0.013, 255) },
    graphite: { light: oklch(0.955, 0.006, 80), dark: oklch(0.185, 0.008, 60) },
  },
  "surface-raised": {
    meridian: { light: oklch(1, 0, 255), dark: oklch(0.246, 0.014, 255) },
    graphite: { light: oklch(0.935, 0.008, 80), dark: oklch(0.22, 0.008, 60) },
  },
  "surface-sunken": {
    meridian: { light: oklch(0.93, 0.005, 255), dark: oklch(0.132, 0.01, 255) },
    graphite: { light: oklch(0.91, 0.01, 80), dark: oklch(0.25, 0.008, 60) },
  },
  edge: {
    meridian: { light: oklch(0.885, 0.006, 255), dark: oklch(0.3, 0.014, 255) },
    graphite: { light: oklch(0.85, 0.01, 80), dark: oklch(0.3, 0.008, 60) },
  },
  "edge-strong": {
    meridian: { light: oklch(0.61, 0.014, 255), dark: oklch(0.538, 0.016, 255) },
    graphite: { light: oklch(0.58, 0.012, 80), dark: oklch(0.56, 0.008, 60) },
  },
};

/** Text tokens. All three clear 4.5:1 on every ground token above, in every rendering. */
export const TEXT_TOKENS: Readonly<Record<string, ThemedColor>> = {
  text: {
    meridian: { light: oklch(0.24, 0.014, 255), dark: oklch(0.955, 0.004, 255) },
    graphite: { light: oklch(0.22, 0.012, 60), dark: oklch(0.95, 0.006, 80) },
  },
  "text-muted": {
    meridian: { light: oklch(0.455, 0.016, 255), dark: oklch(0.775, 0.012, 255) },
    graphite: { light: oklch(0.32, 0.012, 60), dark: oklch(0.79, 0.006, 80) },
  },
  "text-faint": {
    meridian: { light: oklch(0.515, 0.014, 255), dark: oklch(0.665, 0.014, 255) },
    graphite: { light: oklch(0.47, 0.012, 60), dark: oklch(0.66, 0.006, 80) },
  },
};

/**
 * The two attention hues plus the one accent. Nothing else in the app is colored for
 * attention; a third attention hue here breaks the rule.
 */
export const ATTENTION_TOKENS: Readonly<Record<string, ThemedColor>> = {
  "amber-text": {
    meridian: { light: oklch(0.5, 0.13, 65), dark: oklch(0.845, 0.135, 80) },
    graphite: { light: oklch(0.48, 0.13, 75), dark: oklch(0.78, 0.14, 80) },
  },
  "amber-mark": {
    meridian: { light: oklch(0.615, 0.155, 68), dark: oklch(0.76, 0.155, 72) },
    graphite: { light: oklch(0.6, 0.15, 80), dark: oklch(0.78, 0.14, 80) },
  },
  // Graphite's tinted grounds are its mark washed into its own ground.
  "amber-ground": {
    meridian: { light: oklch(0.955, 0.04, 80), dark: oklch(0.26, 0.045, 72) },
    graphite: { light: oklch(0.925, 0.025, 80), dark: oklch(0.268, 0.031, 76) },
  },
  "red-text": {
    meridian: { light: oklch(0.485, 0.19, 25), dark: oklch(0.775, 0.145, 25) },
    graphite: { light: oklch(0.485, 0.185, 27), dark: oklch(0.73, 0.17, 25) },
  },
  "red-mark": {
    meridian: { light: oklch(0.575, 0.215, 25), dark: oklch(0.66, 0.19, 25) },
    graphite: { light: oklch(0.53, 0.18, 27), dark: oklch(0.66, 0.19, 25) },
  },
  "red-ground": {
    meridian: { light: oklch(0.95, 0.03, 25), dark: oklch(0.25, 0.055, 25) },
    graphite: { light: oklch(0.924, 0.025, 35), dark: oklch(0.256, 0.043, 30) },
  },
  accent: {
    meridian: { light: oklch(0.575, 0.09, 215), dark: oklch(0.73, 0.085, 205) },
    graphite: { light: oklch(0.52, 0.12, 205), dark: oklch(0.8, 0.12, 200) },
  },
  "accent-text": {
    meridian: { light: oklch(0.475, 0.1, 215), dark: oklch(0.845, 0.075, 205) },
    graphite: { light: oklch(0.44, 0.11, 205), dark: oklch(0.8, 0.12, 200) },
  },
  // The ink for a control filled with `accent`, and nothing else. `accent-text` is for
  // accent-colored text on a neutral ground; on the accent itself it reaches 1.53:1 in Meridian
  // light and 1.48:1 in Meridian dark, so the pair needs its own token, as `-text` and `-mark` do.
  //
  // Dark in both Meridian schemes, which is forced: a light ink cannot clear 4.5:1 on Meridian's
  // light accent (the lightest thing the palette has, `surface-raised`, reaches 4.23:1, and `text`
  // 3.89:1). So the light leg sits at L 0.13 (4.75:1). The dark leg, on a lighter accent, sits at
  // L 0.22 (7.41:1), the lightness of the dark scheme's own surfaces, so a filled control reads as
  // the app's ground punched out of the accent. Both carry a little of the accent's chroma.
  // Graphite's light accent is deep enough to carry a near-white ink instead.
  "accent-ink": {
    meridian: { light: oklch(0.13, 0.03, 215), dark: oklch(0.22, 0.04, 205) },
    graphite: { light: oklch(0.99, 0, 0), dark: oklch(0.16, 0.02, 200) },
  },
  // The face of a pressed accent-filled control, a token rather than a `filter`: `brightness()`
  // scales both rendered colors, and scaling does not preserve a contrast ratio because relative
  // luminance carries a 0.05 offset. `brightness(0.94)` on Meridian's light face takes the
  // `accent-ink` pair from 4.75:1 to 4.27:1, through the 4.5:1 text floor.
  //
  // How far Meridian's light face may darken is arithmetic. The ink is dark in both schemes, so
  // contrast is monotone in the fill's luminance, and 4.5:1 against an ink of luminance L needs a
  // fill above 4.5 * (L + 0.05) - 0.05. Even a pure-black ink puts that at 0.175 and the light
  // accent's luminance is 0.198, so no ink buys a visibly darker press. The light leg takes the
  // deepest face the floor admits, L 0.565 at 4.57:1, with chroma up against the sRGB edge so it
  // reads deeper rather than dimmer; `accent-fill.css` carries the rest of the press on the
  // control's boundary. The dark leg can afford a real deepening: L 0.68 at 6.18:1. Graphite's
  // inks run the other way, so its light face deepens and its dark face brightens.
  //
  // Every leg clears the 3:1 non-text floor on its rendering's grounds and is measured there,
  // because a pressed control's face is still the boundary a person must find.
  "accent-pressed": {
    meridian: { light: oklch(0.565, 0.099, 215), dark: oklch(0.68, 0.095, 205) },
    graphite: { light: oklch(0.46, 0.12, 205), dark: oklch(0.86, 0.11, 200) },
  },
};

/**
 * The four code span classes that carry a color of their own; a comment is an alias. They live
 * here rather than in the transcript's sheet so they are fitted into the sRGB gamut and measured
 * against their ground like every other color. A separate record from `ATTENTION_TOKENS`, since
 * the two-hue rule governs what the app colors for attention and a keyword is not one.
 * As text they paint on `surface-sunken`, where the contrast check holds them to 4.5:1; three of
 * them also mark tool rows on every neutral ground through `TOOL_HUE_ALIASES`, held there to 3:1.
 */
export const CODE_TOKENS: Readonly<Record<string, ThemedColor>> = {
  "code-keyword": {
    meridian: { light: oklch(0.45, 0.12, 300), dark: oklch(0.8, 0.11, 300) },
    graphite: { light: oklch(0.47, 0.14, 290), dark: oklch(0.74, 0.13, 290) },
  },
  "code-name": {
    meridian: { light: oklch(0.44, 0.1, 250), dark: oklch(0.82, 0.09, 250) },
    graphite: { light: oklch(0.47, 0.12, 230), dark: oklch(0.76, 0.12, 230) },
  },
  "code-string": {
    meridian: { light: oklch(0.42, 0.1, 150), dark: oklch(0.83, 0.1, 150) },
    graphite: { light: oklch(0.47, 0.13, 150), dark: oklch(0.76, 0.14, 150) },
  },
  "code-number": {
    meridian: { light: oklch(0.45, 0.11, 45), dark: oklch(0.83, 0.1, 60) },
    graphite: { light: oklch(0.49, 0.13, 65), dark: oklch(0.8, 0.13, 70) },
  },
};

/**
 * The twelve hued ANSI names, as the app's own colors rather than a terminal's.
 *
 * "Bright" is not a lightness rule. On a dark scheme brighter means higher contrast, but on a
 * light scheme it spends contrast because the ground is near white. So a light bright name
 * differs by chroma first and lightness second, at the deepest lightness the 4.5:1 floor admits
 * on its theme's well with a little margin, still above its normal sibling so the names stay
 * pairs. A run whose background the stream set is outside the contrast check: which pairs a
 * stream composes is its own, and no palette can hold every one of them to a text floor.
 */
export const ANSI_TOKENS: Readonly<Record<string, ThemedColor>> = {
  "ansi-red": {
    meridian: { light: oklch(0.48, 0.16, 25), dark: oklch(0.76, 0.14, 25) },
    graphite: { light: oklch(0.48, 0.16, 25), dark: oklch(0.76, 0.14, 25) },
  },
  "ansi-green": {
    meridian: { light: oklch(0.45, 0.12, 150), dark: oklch(0.8, 0.12, 150) },
    graphite: { light: oklch(0.45, 0.13, 150), dark: oklch(0.74, 0.15, 150) },
  },
  "ansi-yellow": {
    meridian: { light: oklch(0.48, 0.11, 85), dark: oklch(0.84, 0.11, 85) },
    graphite: { light: oklch(0.465, 0.11, 85), dark: oklch(0.84, 0.11, 85) },
  },
  "ansi-blue": {
    meridian: { light: oklch(0.46, 0.11, 255), dark: oklch(0.79, 0.1, 255) },
    graphite: { light: oklch(0.46, 0.12, 230), dark: oklch(0.76, 0.12, 230) },
  },
  "ansi-magenta": {
    meridian: { light: oklch(0.47, 0.13, 330), dark: oklch(0.79, 0.12, 330) },
    graphite: { light: oklch(0.48, 0.13, 330), dark: oklch(0.79, 0.12, 330) },
  },
  "ansi-cyan": {
    meridian: { light: oklch(0.46, 0.09, 205), dark: oklch(0.81, 0.08, 205) },
    graphite: { light: oklch(0.455, 0.09, 205), dark: oklch(0.81, 0.08, 205) },
  },
  "ansi-bright-red": {
    meridian: { light: oklch(0.535, 0.18, 25), dark: oklch(0.83, 0.14, 25) },
    graphite: { light: oklch(0.515, 0.18, 25), dark: oklch(0.83, 0.14, 25) },
  },
  "ansi-bright-green": {
    meridian: { light: oklch(0.5, 0.14, 150), dark: oklch(0.87, 0.13, 150) },
    graphite: { light: oklch(0.48, 0.14, 150), dark: oklch(0.87, 0.13, 150) },
  },
  "ansi-bright-yellow": {
    meridian: { light: oklch(0.515, 0.12, 85), dark: oklch(0.9, 0.11, 85) },
    graphite: { light: oklch(0.495, 0.12, 85), dark: oklch(0.9, 0.11, 85) },
  },
  "ansi-bright-blue": {
    meridian: { light: oklch(0.515, 0.13, 255), dark: oklch(0.86, 0.1, 255) },
    graphite: { light: oklch(0.49, 0.13, 230), dark: oklch(0.86, 0.1, 230) },
  },
  "ansi-bright-magenta": {
    meridian: { light: oklch(0.53, 0.15, 330), dark: oklch(0.86, 0.12, 330) },
    graphite: { light: oklch(0.51, 0.15, 330), dark: oklch(0.86, 0.12, 330) },
  },
  "ansi-bright-cyan": {
    meridian: { light: oklch(0.505, 0.1, 205), dark: oklch(0.88, 0.08, 205) },
    graphite: { light: oklch(0.485, 0.1, 205), dark: oklch(0.88, 0.08, 205) },
  },
};

/**
 * Tokens that are a code or terminal name for an app token, not a color. A code block's plain
 * text is the app's text, and a terminal's black and white are the two ends of the reading
 * scale; a literal black on a dark scheme would render output invisible. Each is a `var()`
 * reference to its target, so it paints what the target paints in every rendering and stays in
 * the contrast check through it. Emitted once in the root block for that reason.
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

/**
 * The glyph hue of each tool verb that has one of its own, a family apart from the agent wheel:
 * each is the theme's own code or terminal color, never a color minted for it. Edit and write
 * share a hue; a verb with none takes the plug glyph at `text-muted`. A glyph is a mark, so each
 * clears 3:1 on every neutral ground. Emitted beside the other aliases.
 */
export const TOOL_HUE_ALIASES: Readonly<Record<string, string>> = {
  "tool-hue-read": "ansi-blue",
  "tool-hue-edit": "code-number",
  "tool-hue-command": "ansi-green",
  "tool-hue-thinking": "code-keyword",
  "tool-hue-search": "ansi-cyan",
  "tool-hue-workflow": "code-name",
};

/**
 * How opaque the composer card's glass is over what scrolls beneath it, in percent, per theme and
 * scheme: a share, not a size, so it does not move with the text size.
 */
export const GLASS_OPACITY_PERCENT: Readonly<
  Record<AppearanceTheme, Readonly<Record<ColorScheme, number>>>
> = {
  meridian: { light: 92, dark: 88 },
  graphite: { light: 88, dark: 84 },
};

/** Steps on the agent wheel: twelve. */
export const HUE_WHEEL_STEPS = 12;

/**
 * Fixed lightness for every agent hue, one value for all four renderings because identity color
 * does not change with the theme or the scheme. Holding the whole wheel to 3:1 leaves one narrow
 * feasible band at this chroma, roughly 0.545 to 0.585: Graphite light's worst step (5, against
 * its well) falls through 3:1 just above L 0.585, and the dark schemes' worst (step 11, against
 * their deepest-lit ground) just below L 0.545. This sits inside it, with headroom of about 3.43
 * and 3.22 in Meridian and Graphite light and 3.37 and 3.33 in their dark schemes.
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

/**
 * Corner radii, in px. Chrome is nearly square; only overlays round. A radius is drawn, like a
 * hairline or a glyph stroke, so it stays as drawn when `Text size` grows the chrome around it.
 */
export const RADIUS_SCALE_PX: Readonly<Record<string, number>> = {
  "radius-sm": 3,
  "radius-md": 6,
  "radius-lg": 10,
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
 * One step of a scale, in the scale's own unit, such as `SPACE_SCALE_REM` or `RADIUS_SCALE_PX`.
 * Throws on an unknown step so a typo cannot become `NaNrem`, which the browser discards silently.
 */
export function scaleStep(scale: Readonly<Record<string, number>>, stepName: string): number {
  const size = scale[stepName];
  if (size === undefined) {
    throw new RangeError(`unknown Meridian scale step ${stepName}`);
  }
  return size;
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
 * The sessions track's width until a person drags it, in rem: as wide as a session row's own
 * furniture reads, 300 px at the default text size.
 */
export const SESSIONS_TRACK_WIDTH_REM = 18.75;

/**
 * The inspector's width, in rem: as wide as its widest label and value pair reads, 324 px at the
 * default text size. The pair's parts have no measure of their own, so the width is that figure,
 * root-relative so it holds the same pair at every text size; a longer value truncates inside it.
 */
export const INSPECTOR_WIDTH_REM = 20.25;

/**
 * The agents pane's width, in rem: as wide as its widest agent row reads, 440 px at the default
 * text size, root-relative like the inspector's. The pane is not resizable.
 */
export const AGENTS_PANE_WIDTH_REM = 27.5;

/** The gutter either side of a transcript row's column, in rem: 36 px at the default text size. */
export const ROW_GUTTER_REM = 2.25;

/**
 * The narrowest viewport the app lays out in, in CSS px. WCAG 2.2 SC 1.4.10 (Reflow) asks
 * that vertically scrolling content be usable without two-dimensional scrolling at 320 CSS px,
 * the width a 1280 px window reaches at 400% zoom.
 *
 * A floor the frame declares, not a breakpoint: one fluid layout holds down to this width,
 * `layout/AppShell/AppFrame.css` spends it as the frame's `min-width`, and below it the document
 * scrolls horizontally. A px value because that is the criterion's unit; a rem floor would move
 * under a person who raised the root font size.
 */
export const REFLOW_MIN_WIDTH_PX = 320;
