// What a theme is: one color table filling every color role in both schemes, a name a person reads
// and the composer glass's opacity. A theme changes colors and nothing else, so the roles are one
// closed set every table fills; a table missing a role does not compile.
//
// Authoring rules every table obeys:
//
//   • Amber means a person is needed; red means something failed; the accent is one desaturated
//     cyan on interactive affordances. Each carries a `-text` role at the 4.5:1 floor and a
//     `-mark` role at the 3:1 floor, because one value cannot serve both.
//   • `edge` is a decorative hairline with no contrast floor; `edge-strong` is the boundary of a
//     non-text control and carries 3:1. A table rule or section divider is neither, and forcing
//     3:1 onto every hairline would make the high-contrast grid the density budget exists to avoid.
//   • Every value is opaque, so each pair is measured as it is painted rather than composited at
//     run time: a quieter step of a color is the step itself, never the color at part opacity.
//
// Every value is a request, not an emitted value: the renderer's token module resolves each
// (rounded to the precision the CSS carries, then chroma-fitted into sRGB) and the stylesheet
// emits that, so the color a rendering's contrast check reads off the running page is the color
// requested.

import type { OklchColor } from "../color.js";
import type { ColorScheme, SchemePair } from "../color-scheme.js";

/**
 * Ground, surface and boundary roles: `ground` is the window's own field, `surface` a pane's,
 * `surface-raised` an overlay's, `surface-sunken` a well (a code block, an input trough).
 */
export const GROUND_ROLES = [
  "ground",
  "surface",
  "surface-raised",
  "surface-sunken",
  "edge",
  "edge-strong",
] as const;

/** Text roles. Each clears 4.5:1 on every neutral ground of its theme, in both schemes. */
export const TEXT_ROLES = ["text", "text-muted", "text-faint"] as const;

/**
 * The two attention hues plus the one accent. Nothing else in the app is colored for attention;
 * a third attention hue breaks the rule.
 */
export const ATTENTION_ROLES = [
  "amber-text",
  "amber-mark",
  "amber-ground",
  "red-text",
  "red-mark",
  "red-ground",
  "accent",
  "accent-text",
  "accent-ink",
  "accent-pressed",
] as const;

/**
 * The four code span classes that carry a color of their own; a comment is an alias. A family
 * apart from the attention roles, since the two-hue rule governs what the app colors for
 * attention and a keyword is not one.
 */
export const CODE_ROLES = ["code-keyword", "code-name", "code-string", "code-number"] as const;

/**
 * The twelve hued ANSI names, as the app's own colors rather than a terminal's. "Bright" is not a
 * lightness rule: on a light scheme a brighter name would spend contrast against a ground near
 * white, so a light bright name differs from its normal sibling by chroma first and lightness
 * second, still above it so the names stay pairs.
 */
export const ANSI_ROLES = [
  "ansi-red",
  "ansi-green",
  "ansi-yellow",
  "ansi-blue",
  "ansi-magenta",
  "ansi-cyan",
  "ansi-bright-red",
  "ansi-bright-green",
  "ansi-bright-yellow",
  "ansi-bright-blue",
  "ansi-bright-magenta",
  "ansi-bright-cyan",
] as const;

/**
 * The `+` and `−` a flow diff draws on its added and removed lines: the green and red of those
 * lines' washes, each at the step of its hue that reaches 4.5:1 on its own wash.
 */
export const DIFF_SIGN_ROLES = ["diff-insert-sign", "diff-delete-sign"] as const;

/** One color role a theme fills. */
export type ColorRole =
  | (typeof GROUND_ROLES)[number]
  | (typeof TEXT_ROLES)[number]
  | (typeof ATTENTION_ROLES)[number]
  | (typeof CODE_ROLES)[number]
  | (typeof ANSI_ROLES)[number]
  | (typeof DIFF_SIGN_ROLES)[number];

/** Every color role, in the order the stylesheet emits them. */
export const COLOR_ROLES: readonly ColorRole[] = [
  ...GROUND_ROLES,
  ...TEXT_ROLES,
  ...ATTENTION_ROLES,
  ...CODE_ROLES,
  ...ANSI_ROLES,
  ...DIFF_SIGN_ROLES,
];

/** One theme: its name as a person reads it, its color table and its glass. */
export interface ThemePalette {
  /** The theme's name on screen, in the Appearance page's theme choice. */
  readonly name: string;
  readonly colors: Readonly<Record<ColorRole, SchemePair>>;
  /**
   * How opaque the composer card's glass is over what scrolls beneath it, in percent: a share,
   * not a size, so it does not move with the text size.
   */
  readonly glassOpacityPercent: Readonly<Record<ColorScheme, number>>;
}

/** An OKLCH color written in the order CSS's `oklch()` takes it: lightness, chroma, hue. */
export function oklch(lightness: number, chroma: number, hueDegrees: number): OklchColor {
  return { lightness, chroma, hueDegrees };
}
