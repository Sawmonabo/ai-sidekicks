// Generator for the token stylesheet. `app/token-installation.ts` writes its output into the
// document head before first paint. There is no committed copy, so the palette has one record, and
// the contrast check reads what the page paints from this sheet in every theme in both schemes.
//
// The cascade has three layers, in this order, each declaring the default theme's palette and then
// every other theme's under its own `[data-theme]`:
//   1. `:root` carries the light values, so a document with no scheme signal still paints a
//      complete palette (nothing is defined only inside a media query).
//   2. `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-color-scheme="light"])`
//      redefines the varying tokens, so the system preference wins when the person chose none.
//   3. `[data-color-scheme="light"]` and `[data-color-scheme="dark"]` are the explicit-choice
//      layer, which beats the system in both directions.
// Every attribute is stamped on the document element. Within a layer another theme's selector
// carries one attribute more than the default's, so it wins wherever its theme is stamped, and only
// one theme is stamped at a time; across layers a later layer ties or beats an earlier one, so it
// wins on source order.
//
// `color-scheme` rides the third layer, not a single root declaration. Custom properties do not
// reach what the browser paints itself (scrollbars, form controls, the canvas), so an
// unconditional `light dark` on the root would put an explicit choice against the OS scheme
// inside mismatched scrollbars. `light dark` stays on `:root` to mean "follow the system", and
// each explicit arm pins its own scheme.

import {
  DEFAULT_APPEARANCE_RECORD,
  SCHEME_ATTRIBUTE,
  THEME_ATTRIBUTE,
} from "#shared/appearance.js";
import { APPEARANCE_THEMES, THEME_PALETTES, type AppearanceTheme } from "#shared/theme/registry.js";
import { formatOklch } from "#shared/color.js";
import { tokenVariableName } from "#shared/token-variable.js";
import { CHROME_SETTLE_EASING, MOTION_DURATIONS_MS } from "./motion.js";
import {
  LEADING_EDGE_WIDTH_PX,
  BOUNDED_ENUMERATION_HEIGHT_REM,
  RADIUS_SCALE_PX,
  RAIL_BUTTON_SIZE_REM,
  RAIL_WIDTH_REM,
  REFLOW_MIN_WIDTH_PX,
  ROW_GUTTER_REM,
  SESSIONS_TRACK_WIDTH_REM,
  INSPECTOR_WIDTH_REM,
  AGENTS_PANE_WIDTH_REM,
  CONVERSATION_FLOOR_REM,
  SPACE_SCALE_REM,
  TOKEN_ALIASES,
  TOOL_HUE_ALIASES,
  TRANSCRIPT_ROW_GAP_REM,
  WINDOW_HEIGHT_FLOOR_REM,
} from "./palette.js";
import {
  BODY_LINE_HEIGHT,
  FONT_STACKS,
  LETTER_SPACING_EM,
  READING_LINE_HEIGHT,
  TYPE_SCALE_REM,
  WIRE_FIGURE_SIZE_EM,
} from "./typography.js";
import type { ColorScheme } from "./tokens.js";
import {
  HUE_WHEEL,
  THEMED_COLOR_TOKENS,
  formatHueWheelTokenName,
  tokenReference,
} from "./tokens.js";

/** The complete text of the token stylesheet. Deterministic: same inputs, same bytes. */
export function generateMeridianCss(): string {
  // The emitted banner names no document: it is written into the live stylesheet, and such a
  // reference belongs in source comments.
  const header = [
    "/*",
    " * GENERATED AT RUNTIME — there is no committed copy of this sheet.",
    " *",
    " * `styles/generate-css.ts` builds this text and",
    " * `app/token-installation.ts` writes it into the document head",
    " * before first paint. A committed copy would be a second record of the",
    " * palette, and the only defense against the two drifting would be a byte-diff",
    " * test whose failure mode is a forgotten regeneration command.",
    " *",
    " * Sources of truth: `styles/palette.ts` for the color ramps and the",
    " * spacing and radius scales, `styles/motion.ts` for the motion scale and",
    " * its easing, and `styles/typography.ts` for the type scale, the letter",
    " * spacing, the line height, the wire figure's size, and the font stacks.",
    " *",
    " * The design language's color, type, and spacing rules live in those files'",
    " * comments; this file carries only their values.",
    " */",
    "",
  ].join("\n");

  const rootBlock = [
    ":root {",
    "  color-scheme: light dark;",
    "",
    "  /* Light scheme — the complete palette, defined unconditionally so no",
    "     token has its only definition inside a media query. */",
    themeColorBlock(DEFAULT_THEME, "light", ""),
    invariantBlock(),
    "}",
    "",
    ...THEMES_BESIDE_DEFAULT.map((theme) =>
      [`${themeSelector(theme, "")} {`, themeColorBlock(theme, "light", ""), "}"].join("\n"),
    ),
  ].join("\n");

  const systemNotLight = `:not([${SCHEME_ATTRIBUTE}="light"])`;
  const systemDarkBlock = [
    "@media (prefers-color-scheme: dark) {",
    "  /* System preference wins only where the person has expressed none. */",
    ...APPEARANCE_THEMES.map((theme) =>
      [
        `  ${themeSelector(theme, systemNotLight)} {`,
        themeColorBlock(theme, "dark", "  "),
        "  }",
      ].join("\n"),
    ),
    "}",
  ].join("\n");

  // The explicit-choice layer. `:root` already holds the light palette and the media block
  // excludes itself on this attribute, so the light arm exists for `color-scheme` alone.
  const explicitLightBlock = [
    "/* An explicit choice beats the system preference in both directions, for the",
    "   browser's own controls as well as for the palette. */",
    `:root[${SCHEME_ATTRIBUTE}="light"] {`,
    "  color-scheme: light;",
    "}",
  ].join("\n");

  const explicitDark = `[${SCHEME_ATTRIBUTE}="dark"]`;
  const explicitDarkBlock = [
    `${themeSelector(DEFAULT_THEME, explicitDark)} {`,
    "  color-scheme: dark;",
    "",
    themeColorBlock(DEFAULT_THEME, "dark", ""),
    "}",
    ...THEMES_BESIDE_DEFAULT.map((theme) =>
      [`${themeSelector(theme, explicitDark)} {`, themeColorBlock(theme, "dark", ""), "}"].join(
        "\n",
      ),
    ),
  ].join("\n");

  const baseBlock = [
    "/* The app's own ground. The host paints its own field behind the",
    "   document, so the body's background is stated rather than inherited. */",
    "html,",
    "body,",
    "#root {",
    "  height: 100%;",
    "}",
    "",
    "body {",
    "  margin: 0;",
    "  background: var(--meridian-ground);",
    "  color: var(--meridian-text);",
    "  font-family: var(--meridian-font-sans);",
    "  font-size: var(--meridian-text-md);",
    `  line-height: ${BODY_LINE_HEIGHT};`,
    "  -webkit-font-smoothing: antialiased;",
    "}",
    "",
    "/* Reduced motion: `prefers-reduced-motion` collapses everything to opacity. */",
    "@media (prefers-reduced-motion: reduce) {",
    "  *,",
    "  *::before,",
    "  *::after {",
    "    animation-duration: 1ms !important;",
    "    animation-iteration-count: 1 !important;",
    "    transition-duration: 1ms !important;",
    "    scroll-behavior: auto !important;",
    "  }",
    "}",
  ].join("\n");

  return [
    header,
    rootBlock,
    "",
    systemDarkBlock,
    "",
    explicitLightBlock,
    "",
    explicitDarkBlock,
    "",
    baseBlock,
    "",
  ].join("\n");
}

function declaration(tokenName: string, value: string): string {
  return `  ${tokenVariableName(tokenName)}: ${value};`;
}

/** The theme the bare `:root` rules paint: the one a missing record reads as. */
const DEFAULT_THEME: AppearanceTheme = DEFAULT_APPEARANCE_RECORD.theme;

/** The themes that override the default's palette under their own attribute. */
const THEMES_BESIDE_DEFAULT: readonly AppearanceTheme[] = APPEARANCE_THEMES.filter(
  (theme) => theme !== DEFAULT_THEME,
);

/** The root selector for one theme under a scheme condition; the default theme needs no attribute. */
function themeSelector(theme: AppearanceTheme, schemeCondition: string): string {
  const themeCondition = theme === DEFAULT_THEME ? "" : `[${THEME_ATTRIBUTE}="${theme}"]`;
  return `:root${themeCondition}${schemeCondition}`;
}

function themeColorBlock(theme: AppearanceTheme, scheme: ColorScheme, indent: string): string {
  const lines: string[] = [];
  for (const [tokenName, color] of THEMED_COLOR_TOKENS) {
    lines.push(`${indent}${declaration(tokenName, formatOklch(color[theme][scheme]))}`);
  }
  lines.push(
    `${indent}${declaration("glass", `${String(THEME_PALETTES[theme].glassOpacityPercent[scheme])}%`)}`,
  );
  return lines.join("\n");
}

function invariantBlock(): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("  /* Agent wheel — identity, never attention, never theme. */");
  HUE_WHEEL.forEach((color, step) => {
    lines.push(declaration(formatHueWheelTokenName(step), formatOklch(color)));
  });

  lines.push("");
  lines.push("  /* Vocabulary aliases — a code or terminal name for an app token.");
  lines.push("     Emitted here rather than in each scheme layer because the token");
  lines.push("     each one defers to already swaps. */");
  for (const [tokenName, targetTokenName] of Object.entries({
    ...TOKEN_ALIASES,
    ...TOOL_HUE_ALIASES,
  })) {
    lines.push(declaration(tokenName, tokenReference(targetTokenName)));
  }

  lines.push("");
  lines.push("  /* Type. */");
  for (const [tokenName, stack] of Object.entries(FONT_STACKS)) {
    lines.push(declaration(tokenName, stack));
  }
  for (const [tokenName, sizeRem] of Object.entries(TYPE_SCALE_REM)) {
    lines.push(declaration(tokenName, `${sizeRem}rem`));
  }
  for (const [tokenName, spacingEm] of Object.entries(LETTER_SPACING_EM)) {
    lines.push(declaration(tokenName, `${spacingEm}em`));
  }
  lines.push(declaration("figure-wire-size-default", `${WIRE_FIGURE_SIZE_EM}em`));
  lines.push(declaration("reading-line-height", String(READING_LINE_HEIGHT)));

  lines.push("");
  lines.push("  /* Space and radius. */");
  for (const [tokenName, sizeRem] of Object.entries(SPACE_SCALE_REM)) {
    lines.push(declaration(tokenName, `${sizeRem}rem`));
  }
  for (const [tokenName, sizePx] of Object.entries(RADIUS_SCALE_PX)) {
    lines.push(declaration(tokenName, `${sizePx}px`));
  }
  lines.push(declaration("leading-edge", `${LEADING_EDGE_WIDTH_PX}px`));
  lines.push(declaration("rail-button-size", `${RAIL_BUTTON_SIZE_REM}rem`));
  lines.push(declaration("rail-width", `${RAIL_WIDTH_REM}rem`));
  lines.push(declaration("sessions-track-width", `${SESSIONS_TRACK_WIDTH_REM}rem`));
  lines.push(declaration("inspector-width", `${INSPECTOR_WIDTH_REM}rem`));
  lines.push(declaration("agents-pane-width", `${AGENTS_PANE_WIDTH_REM}rem`));
  lines.push(declaration("conversation-floor", `${CONVERSATION_FLOOR_REM}rem`));
  lines.push(declaration("window-height-floor", `${WINDOW_HEIGHT_FLOOR_REM}rem`));
  // The terminal opens on a third of its pane block's height; the percentage resolves against the
  // block that reads the token, which must have a definite height.
  lines.push(declaration("terminal-height", "calc(100% / 3)"));
  lines.push(declaration("row-gutter", `${ROW_GUTTER_REM}rem`));
  lines.push(declaration("enumeration-max-height", `${BOUNDED_ENUMERATION_HEIGHT_REM}rem`));
  lines.push(declaration("transcript-row-gap", `${TRANSCRIPT_ROW_GAP_REM}rem`));
  // The reflow floor is emitted so a stylesheet reads the property instead of copying the
  // palette's number. It cannot be a media-query condition (custom properties do not reach one);
  // the app holds this width with one fluid layout, not a breakpoint.
  lines.push(declaration("reflow-min-width", `${REFLOW_MIN_WIDTH_PX}px`));

  lines.push("");
  lines.push("  /* Motion — settles, never bounces. */");
  for (const [tokenName, durationMs] of Object.entries(MOTION_DURATIONS_MS)) {
    lines.push(declaration(tokenName, `${durationMs}ms`));
  }
  // One settle easing, the spring the motion rules ask for: `motion.ts` carries it written out as
  // a `linear()`, so nothing computes a spring at runtime. It is emitted under the name every
  // stylesheet reads.
  lines.push(declaration("ease-settle", CHROME_SETTLE_EASING));

  return lines.join("\n");
}
