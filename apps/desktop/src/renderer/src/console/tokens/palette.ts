// The Meridian palette — the single source of truth for every console color.
//
// `Spec-023 §Console Design (Meridian)` rule 2 (the participant hue system),
// rule 3 (the two-hue rule and its WCAG 2.2 AA contrast floors) and rule 4
// (type and figures) are realised here and nowhere else: `meridian.css` is
// GENERATED from this module by `generate-css.ts` and byte-diffed against it by
// the console's assets tier, so a color edited in CSS alone fails the build.
//
// Authoring rules this file obeys, each of them a rule the spec states:
//
//   • Hue answers "who" and never "how urgent". The twelve participant steps
//     below are one scheme-independent set, because a person's identity does not
//     change when the operator flips the theme. One lightness (`PARTICIPANT_HUE_
//     LIGHTNESS`) clears 3:1 as an edge, ring, or mark against BOTH schemes'
//     grounds — which is exactly what rule 3 asks for and why the lightness sits
//     mid-scale rather than at either extreme.
//   • Amber means a person is needed; red means something failed; the accent is
//     one desaturated cyan on interactive affordances. Each carries a `-text`
//     variant at the 4.5:1 floor and a `-mark` variant at the 3:1 floor, because
//     one value cannot serve both without failing one of them.
//   • `edge` is a decorative hairline and carries NO contrast floor; `edgeStrong`
//     is the boundary of a non-text control and carries the 3:1 floor. Rule 3
//     scopes its non-text floor to "non-text controls, their boundaries, and
//     every focus ring" — a table rule or a section divider is neither, and
//     forcing 3:1 onto every hairline would produce the high-contrast grid the
//     density budget exists to avoid. The split is the reading, stated so a
//     reviewer can disagree with it in one place.
//
// The values below are REQUESTS, not emitted values. `tokens.ts` resolves each
// one through `resolveEmittedColor` — rounded to the precision the CSS carries,
// then chroma-fitted into sRGB if the request does not fit there — and both
// `generate-css.ts` and `contrast.test.ts` read that resolved record. So the
// number measured is the number painted, and a request whose chroma sRGB cannot
// hold at its lightness is served at the chroma it can (see `color.ts`).

import type { OklchColor } from "./color.js";

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
export const SURFACE_TOKENS: Readonly<Record<string, SchemePair>> = {
  ground: { light: oklch(0.965, 0.003, 255), dark: oklch(0.165, 0.011, 255) },
  surface: { light: oklch(0.995, 0.001, 255), dark: oklch(0.203, 0.013, 255) },
  "surface-raised": { light: oklch(1, 0, 255), dark: oklch(0.246, 0.014, 255) },
  "surface-sunken": { light: oklch(0.93, 0.005, 255), dark: oklch(0.132, 0.01, 255) },
  edge: { light: oklch(0.885, 0.006, 255), dark: oklch(0.3, 0.014, 255) },
  "edge-strong": { light: oklch(0.61, 0.014, 255), dark: oklch(0.538, 0.016, 255) },
};

/** Text tokens. All three clear 4.5:1 on every surface token above. */
export const TEXT_TOKENS: Readonly<Record<string, SchemePair>> = {
  text: { light: oklch(0.24, 0.014, 255), dark: oklch(0.955, 0.004, 255) },
  "text-muted": { light: oklch(0.455, 0.016, 255), dark: oklch(0.775, 0.012, 255) },
  "text-faint": { light: oklch(0.515, 0.014, 255), dark: oklch(0.665, 0.014, 255) },
};

/**
 * The two-hue rule plus the one accent. Nothing else in the console is colored
 * for attention; adding a third attention hue here is the rule's failure mode.
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
  "focus-ring": { light: oklch(0.55, 0.11, 215), dark: oklch(0.8, 0.09, 205) },
};

/** Steps on the participant wheel. Twelve, per `Spec-023 §Console Design (Meridian)` rule 2. */
export const PARTICIPANT_HUE_STEPS = 12;

/**
 * Fixed lightness for every participant hue — one value for both schemes, because
 * a person's identity colour does not change when the operator flips the theme.
 *
 * It is not a taste choice. Holding the whole wheel to 3:1 leaves exactly one
 * feasible band at this chroma, and the band is narrow: the LIGHT scheme's worst
 * step (the yellow-green at step 5, measured against `surface-sunken`) falls
 * through 3:1 just above L 0.600, and the DARK scheme's worst (the same step
 * against `surface-raised`) falls through it just below L 0.545. Anything outside
 * [0.545, 0.600] fails one scheme or the other. This sits near the middle of that
 * band, which is why both schemes clear the floor with comparable headroom
 * (~3.43 light, ~3.37 dark) rather than one of them scraping past.
 */
export const PARTICIPANT_HUE_LIGHTNESS = 0.57;

/**
 * Requested chroma for every participant hue. Green and cyan cannot hold it in
 * sRGB at this lightness, so those steps are chroma-fitted down; the wheel stays
 * perceptually even in lightness, which is what carries the "one family" reading.
 */
export const PARTICIPANT_HUE_CHROMA = 0.135;

/**
 * Hue angle of step 0. Offset off 0° so no participant lands on the pure red
 * that the failed-state token owns, which would make identity read as failure at
 * a glance.
 */
export const PARTICIPANT_HUE_ORIGIN_DEGREES = 20;

/** Degrees between adjacent wheel steps. */
export const PARTICIPANT_HUE_STEP_DEGREES: number = 360 / PARTICIPANT_HUE_STEPS;

/** The hue angle of a wheel step, in degrees. */
export function participantHueAngle(step: number): number {
  return (PARTICIPANT_HUE_ORIGIN_DEGREES + step * PARTICIPANT_HUE_STEP_DEGREES + 360) % 360;
}

/**
 * Motion durations, in milliseconds. `Spec-023 §Console Design (Meridian)`
 * rule 5: settles, never bounces — 120-180 ms ease-out for chrome, 240 ms for an
 * attribution thread drawing itself.
 */
export const MOTION_DURATIONS_MS: Readonly<Record<string, number>> = {
  "motion-quick": 120,
  "motion-settle": 180,
  "motion-thread": 240,
};

/**
 * The one easing curve chrome uses. A settle has no overshoot, so the curve's
 * control points stay inside the unit square — a spring sampler emitting
 * `linear()` is the escape hatch for the few surfaces that need one, and it is
 * not on the render path.
 */
export const MOTION_EASE_SETTLE = "cubic-bezier(0.22, 0.61, 0.36, 1)";

/**
 * The line height every body line box occupies, as a multiple of its own size.
 *
 * Named rather than written into the generator's `body` rule, because it is not
 * only a paint instruction: a row of any list is a line box plus its padding, so
 * the console's row rhythm is derived from this number and would silently stop
 * matching what the sheet paints if the two were written separately.
 */
export const BODY_LINE_HEIGHT = 1.5;

/**
 * Type scale, in rem. Rule 4 sets UI text in a humanist grotesque and every
 * wire-true figure in mono; the scale is shared so a figure and its label sit on
 * the same baseline.
 */
export const TYPE_SCALE_REM: Readonly<Record<string, number>> = {
  "text-xs": 0.6875,
  "text-sm": 0.8125,
  "text-md": 0.875,
  "text-lg": 1,
  "text-xl": 1.25,
};

/**
 * The font stacks. IBM Plex Sans and IBM Plex Mono are the ratified faces
 * (`Spec-023 §Console Libraries`, the motion/fonts/icons row); the console does
 * not yet self-host them, so each stack names the family first and falls through
 * to the platform UI face. Self-hosting is gated on one amendment: the foundry
 * packages are OFL-1.1, which sits outside the MIT / Apache-2.0 / BSD / ISC norm
 * ADR-020's Decision Log assumes for a DISTRIBUTED dependency (its 2026-09-01
 * axe-core row admits a never-distributed test dependency and says in terms that
 * a bundled outside-norm use needs its own entry), and at their npm pins those
 * packages ship static instances rather than the variable builds the Console
 * Libraries row describes. When that amendment lands, the faces arrive as one
 * `@font-face` block and these two constants do not move.
 */
export const FONT_STACKS: Readonly<Record<string, string>> = {
  "font-sans":
    '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  "font-mono":
    '"IBM Plex Mono", ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", monospace',
};

/**
 * Spacing scale, in rem, on a 4 px base at the 16 px root. Named rather than
 * numeric so a density-budget change is one edit here.
 */
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
 * The attribution edge's width, in px. Rule 1 fixes it at 2 px: wide enough to
 * carry a hue at a glance, narrow enough that a screen of rows reads as a log
 * rather than as a striped table.
 */
export const ATTRIBUTION_EDGE_WIDTH_PX = 2;

/**
 * One step of a rem scale, by name. Throws rather than resolving `undefined`.
 *
 * The scales are open records keyed by token name, so a step read by name is
 * `number | undefined` and a typo would otherwise propagate into an emitted
 * length as `NaNrem` — a declaration the browser discards in silence. Same stance
 * as `tokens.ts`'s `schemeColor`, which throws on an unknown colour token for the
 * same reason.
 */
function scaleStep(scale: Readonly<Record<string, number>>, stepName: string): number {
  const sizeRem = scale[stepName];
  if (sizeRem === undefined) {
    throw new RangeError(`unknown Meridian scale step ${stepName}`);
  }
  return sizeRem;
}

/**
 * The height one row of an enumeration occupies, in rem.
 *
 * DERIVED, never measured off a screen: one `text-md` line box at the body's line
 * height, plus a `space-2` above and below it — which is exactly the rhythm the
 * console's one shipped enumeration, the palette's result list, already sets on
 * `.console-palette__item`. Stating it here rather than in each list's stylesheet
 * is what lets a bounded list be capped in ROWS, which is the unit the cap is
 * actually about, and it means a change to the type scale, the spacing scale, or
 * the body line height moves every such cap with it.
 */
export const ENUMERATION_ROW_HEIGHT_REM: number =
  scaleStep(TYPE_SCALE_REM, "text-md") * BODY_LINE_HEIGHT +
  2 * scaleStep(SPACE_SCALE_REM, "space-2");

/**
 * Rows a bounded enumeration shows before it scrolls.
 *
 * Six, and the number is a ceiling rather than a preference. The shortest window
 * the console ships is 720 px tall (the agent-console auxiliary geometry), which
 * is 45 rem at the 16 px root; an enumeration allowed to take more than a third of
 * that would leave the surface holding it with nothing else on screen. Six rows is
 * 13.875 rem and clears that third; seven is 16.1875 rem and does not.
 */
export const BOUNDED_ENUMERATION_MAX_ROWS = 6;

/**
 * The height a bounded enumeration scrolls past, in rem.
 *
 * A named multiple of the row height rather than a literal length, so a stylesheet
 * writes `max-height: var(--meridian-enumeration-max-height)` and never multiplies.
 * A list that grows past this scrolls inside its own box instead of pushing the
 * rest of its surface off screen.
 */
export const BOUNDED_ENUMERATION_MAX_HEIGHT_REM: number =
  BOUNDED_ENUMERATION_MAX_ROWS * ENUMERATION_ROW_HEIGHT_REM;
