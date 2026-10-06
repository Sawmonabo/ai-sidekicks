// The app's type system: the faces the app asks for, the line height, the size scale every
// line is set on, and the letter spacing scale every sheet sets spacing from. Separate from
// `palette.ts`, which answers "what color is this?" through contrast measurements, while this
// file answers "how is text set?".
//
// `generate-css.ts` composes this and the palette into the emitted sheet, and `palette.ts` reads
// the line height and type scale for `ENUMERATION_ROW_HEIGHT_REM`. This file is a leaf that
// imports nothing local, so that dependency cannot become a cycle.
//
// No OpenType feature is declared. Tabular figures need none: every digit in both families
// measures 600/1000 em, so the digits are tabular by construction. The sheets that set
// `font-variant-numeric: tabular-nums` do so for the platform fallback faces.

/**
 * The line height every body line box occupies, as a multiple of its size. Named rather than
 * written into the generator's `body` rule because the app's row rhythm is derived from it.
 */
export const BODY_LINE_HEIGHT = 1.5;

/**
 * Type scale, in rem, shared by the sans and mono faces so a figure and its label sit on the
 * same baseline.
 */
export const TYPE_SCALE_REM: Readonly<Record<string, number>> = {
  /** The smallest step, 10px at the default root size: the uppercase field label's size. */
  "text-2xs": 0.625,
  "text-xs": 0.6875,
  "text-sm": 0.8125,
  "text-md": 0.875,
  "text-lg": 1,
  "text-xl": 1.25,
};

/**
 * Every glyph's advance in the mono face, in em: IBM Plex Mono sets each printable ASCII
 * character 600/1000 em wide at every weight, so a mono figure's width is its length times this
 * and needs no measurement.
 */
export const MONO_ADVANCE_EM = 0.6;

/**
 * A wire figure's size, in em of the text around it. Mono runs optically larger than sans at the
 * same size; a hair under 1em balances them.
 */
export const WIRE_FIGURE_SIZE_EM = 0.93;

/**
 * Letter spacing, in em so it scales with the size it is set at. Uppercase text needs more room
 * between letters than mixed case to read at a small size, and a heading over a group sits one
 * step wider than the labels inside it so the two never read as the same rank. Every sheet sets
 * letter spacing from one of these steps.
 */
export const LETTER_SPACING_EM: Readonly<Record<string, number>> = {
  /** An uppercase section or group heading's spacing: one step wider than a field label's. */
  "tracking-heading": 0.14,
  /** The uppercase field label's spacing, wide enough that capitals at its size stay apart. */
  "tracking-label": 0.12,
  /**
   * Small uppercase words that are neither a field label nor a group heading: a category over a
   * run of rows, a row's kind, the word before a value.
   */
  "tracking-caps": 0.06,
  /** Mixed-case words set a touch open, such as a block title or a figure's caption. */
  "tracking-mixed": 0.02,
};

/**
 * The font stacks. IBM Plex Sans (UI text) and IBM Plex Mono (wire-true figures) are the ratified
 * faces, self-hosted as variable builds: `typeface.ts` declares the `@font-face` rules over
 * `@ibm/plex-sans-variable` and `@ibm/plex-mono-variable`. Those packages are build-time-only
 * `devDependencies`, since the bundler resolves the `?url` imports and nothing resolves them at
 * runtime. The platform fallbacks stay because the faces hold only the Latin-1 split, so a
 * codepoint outside it falls through to them, one character at a time, instead of rendering a
 * notdef box.
 *
 * The stack names the family a rule asks for; which bytes answer is `typeface.ts`'s. The files
 * carry a continuous `wght 100–700` axis, so the 400, 500 and 600 the stylesheets ask for and the
 * 640 that `layout/CommandPalette/command-palette.css` asks for are each a real instance. The
 * sans builds also carry `wdth 85–100`, which nothing asks for.
 */
export const FONT_STACKS: Readonly<Record<string, string>> = {
  "font-sans":
    '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  "font-mono":
    '"IBM Plex Mono", ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", monospace',
};
