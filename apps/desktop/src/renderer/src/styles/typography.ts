// The console's type system: the faces the console asks for, the line height, and the size scale
// every line is set on. Separate from `palette.ts`, which answers "what color is this?" through
// contrast measurements, while this file answers "how is text set?".
//
// `generate-css.ts` composes this and the palette into the emitted sheet, and `palette.ts` reads
// the line height and type scale for `ENUMERATION_ROW_HEIGHT_REM`. This file is a leaf that
// imports nothing local, so that dependency cannot become a cycle.
//
// The OpenType features are not declared here. The slashed zero belongs to the mono face and is a
// descriptor inside its `@font-face` rules in `typeface.ts`; on `body` it would inherit onto every
// user name, repo path and branch, and CSS Fonts 4 gives `font-feature-settings` precedence over
// `font-variant-*`, so no descendant could scope it back. Tabular figures need no feature:
// neither family carries `tnum` or `pnum` in `GSUB` or `GPOS`, and every digit measures 600/1000
// em, so the digits are tabular by construction. The sheets that set
// `font-variant-numeric: tabular-nums` do so for the platform fallback faces, which offer both.

/**
 * The line height every body line box occupies, as a multiple of its size. Named rather than
 * written into the generator's `body` rule because the console's row rhythm is derived from it.
 */
export const BODY_LINE_HEIGHT = 1.5;

/**
 * Type scale, in rem, shared by the sans and mono faces so a figure and its label sit on the
 * same baseline.
 */
export const TYPE_SCALE_REM: Readonly<Record<string, number>> = {
  "text-xs": 0.6875,
  "text-sm": 0.8125,
  "text-md": 0.875,
  "text-lg": 1,
  "text-xl": 1.25,
};

/**
 * The font stacks. IBM Plex Sans (UI text) and IBM Plex Mono (wire-true figures) are the ratified
 * faces, self-hosted as variable builds: `typeface.ts` declares the `@font-face` rules over
 * `@ibm/plex-sans-variable` and `@ibm/plex-mono-variable`. Those packages are build-time-only
 * `devDependencies`, since the bundler resolves the `?url` imports and nothing resolves them at
 * runtime. The platform fallbacks stay because each face carries a `unicode-range`, so a
 * codepoint outside Latin-1 falls through to them instead of rendering a notdef box.
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
