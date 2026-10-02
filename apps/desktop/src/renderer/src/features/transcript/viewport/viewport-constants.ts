// The transcript viewport's named figures: the window's row ceiling and the measures the viewport
// and the scroll chokepoint spend. The reveal engine's figures are in `../reveal/reveal-caps.ts`.

/**
 * Top-level rows the transcript window retains before the oldest are pruned.
 *
 * A ceiling: Chromium places no element taller than 33,554,431 px, so an uncapped log
 * eventually renders rows the browser cannot place. Four hundred rows is several screens of
 * scrollback, as far back as a person reads before reaching for find.
 */
export const TRANSCRIPT_WINDOW_ROW_CAP = 400;

/**
 * Rows rendered beyond each edge of the viewport.
 *
 * Two more than the tallest burst one frame's reveal drain can push into view, so a fast scroll
 * meets measured rows rather than a blank band, while the rendered set stays a fraction of the
 * window cap.
 */
export const TRANSCRIPT_OVERSCAN_ROWS = 6;

/**
 * The height a row is assumed to have before it is measured, in pixels: near a line with a
 * gutter, a kind label and two lines of body. It only has to keep the first paint's scrollbar
 * from looking wrong, since every mounted row replaces it with a measurement.
 */
export const TRANSCRIPT_ROW_HEIGHT_ESTIMATE_PX = 96;

/**
 * Tolerance, in pixels, within which the viewport counts as sitting at the tail.
 *
 * An exact test flickers between following and reading on every frame of a stream, because of
 * sub-pixel scroll positions and fractional row heights. One line's leading is the smallest band
 * rounding cannot cross.
 */
export const TRANSCRIPT_TAIL_TOLERANCE_PX = 24;

/**
 * The epsilon every geometry comparison uses, in pixels: below anything a display can show and
 * above the error a device-pixel-ratio division introduces.
 */
export const TRANSCRIPT_GEOMETRY_EPSILON_PX = 0.5;

/**
 * Agreeing witnesses before the controller believes this display quantizes programmatic
 * `scrollTop` writes to whole pixels. Two, because a single readback can be explained by a
 * concurrent user scroll landing between the write and the read.
 */
export const SCROLL_QUANTIZATION_SAMPLE_COUNT = 2;

/**
 * How long the transcript must have been still for the next activity to trim first, in
 * milliseconds.
 *
 * Compared against the clock, never armed: `idle-trim.ts` runs on the first activity after the
 * gap because an idle frame arms no timer. Two minutes is longer than every pause inside ordinary
 * reading (scrolling back, a long tool result, checking another window) and short enough that
 * the pause after a working session returns what it accumulated.
 */
export const TRANSCRIPT_IDLE_TRIM_DWELL_MS = 120_000;
