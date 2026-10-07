// The app's color rules beyond a theme's own table: the agent hue wheel, the aliases a code or
// terminal name takes for a themed color, and the scales and frame widths every theme shares. Each
// theme's colors are its table in `#shared/theme/`, which the stylesheet reads beside these, so
// there is no second copy to drift.
//
//   • Hue answers "who" and never "how urgent". The twelve agent steps are one scheme- and
//     theme-independent set, because identity does not change when the person flips the theme. One
//     lightness (`HUE_WHEEL_LIGHTNESS`) clears 3:1 as an edge or mark against every rendering's
//     grounds, which is why it sits mid-scale.

import { type SchemePair } from "#shared/color-scheme.js";
import { type AppearanceTheme } from "#shared/theme/registry.js";
// The enumeration row height and the transcript's row gap are products of the type scale and line
// heights from `typography.ts`, a leaf that imports nothing local, and the spacing scale here.
import { BODY_LINE_HEIGHT, READING_LINE_HEIGHT, TYPE_SCALE_REM } from "./typography.js";

/** A color token's values: every theme's light and dark. */
export type ThemedColor = Readonly<Record<AppearanceTheme, SchemePair>>;

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

/** Steps on the agent wheel: twelve. */
export const HUE_WHEEL_STEPS = 12;

/**
 * Fixed lightness for every agent hue, one value for every rendering because identity color
 * does not change with the theme or the scheme. Holding the whole wheel to 3:1 leaves one narrow
 * feasible band at this chroma, roughly 0.556 to 0.587: Graphite light's worst step (5, against
 * its well) falls through 3:1 just above L 0.587, and Graphite dark's worst (step 11, against its
 * well, its most lit ground) just below L 0.556. This sits inside it, with headroom of about 3.43
 * and 3.22 in Meridian and Graphite light and 3.37 and 3.19 in their dark schemes.
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
 * The shortest window the header, the flow and the composer still stack in, in rem: the window's
 * height floor, 640 px at the default text size. Root-relative, so the floor grows with the text.
 */
export const WINDOW_HEIGHT_FLOOR_REM = 40;

/**
 * Rows a bounded enumeration shows before it scrolls. A ceiling, not a preference: the most whole
 * rows whose height stays within a third of the window's height floor, since an enumeration taking
 * more leaves nothing else on screen.
 */
export const BOUNDED_ENUMERATION_MAX_ROWS: number = Math.floor(
  WINDOW_HEIGHT_FLOOR_REM / 3 / ENUMERATION_ROW_HEIGHT_REM,
);

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

/**
 * The narrowest the conversation column is squeezed to, in rem: the width its header must hold
 * (the title, the pull-request word, the Review chip with its counts, Preview, Terminal and More),
 * 420 px at the default text size. Root-relative, so the header holds at every text size.
 */
export const CONVERSATION_FLOOR_REM = 26.25;

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
