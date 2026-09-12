// Generator for `meridian.css`.
//
// The committed stylesheet is a build artifact of `palette.ts`, not a second source of
// truth: the console's assets tier — generated tokens and schema artifacts
// byte-identical to their sources — byte-diffs the committed file against this
// function's output, so a color edited in CSS alone turns the build red rather than
// quietly diverging from what the contrast test measures.
//
// Why generate rather than hand-write: rule 3's floors are asserted against the
// TypeScript records, and an assertion about one table proves nothing about a
// second table a human maintains beside it.
//
// The emitted cascade has three layers, in this order:
//   1. `:root` carries the LIGHT values, so a document with no scheme signal at
//      all still paints a complete palette (nothing is defined only inside a
//      media query — the failure mode where a color exists in one branch only).
//   2. `@media (prefers-color-scheme: dark)` guarded by
//      `:root:not([data-console-scheme="light"])` redefines the varying tokens,
//      so the system preference wins when the operator has expressed none.
//   3. `[data-console-scheme="light"]` and `[data-console-scheme="dark"]` — the
//      explicit-choice layer, which beats the system in both directions. The
//      attribute is stamped on the document element, so both selectors match
//      `:root` and win on source order at equal specificity.
//
// `color-scheme` is part of that third layer rather than a single root
// declaration, and that is the difference between theming the document and
// theming the browser. Custom properties reach nothing the browser paints itself —
// scrollbars, form controls, spinners, the canvas behind the document — so a root
// that said `light dark` unconditionally would give an operator who chose light on
// a dark OS a light document inside dark scrollbars, and the mirror mismatch for an
// explicit dark choice on a light OS. `light dark` therefore stays on `:root`,
// where it means "no one has chosen, follow the system", and each explicit arm
// pins the single scheme it stands for.

import { formatOklch } from "./color.js";
import { CHROME_SETTLE_EASING, MOTION_DURATIONS_MS } from "./motion.js";
import {
  ATTRIBUTION_EDGE_WIDTH_PX,
  BOUNDED_ENUMERATION_HEIGHT_REM,
  RADIUS_SCALE_REM,
  REFLOW_MIN_WIDTH_PX,
  SPACE_SCALE_REM,
  TOKEN_ALIASES,
} from "./palette.js";
import { BODY_LINE_HEIGHT, FONT_STACKS, TYPE_SCALE_REM } from "./typography.js";
import type { ConsoleScheme } from "./tokens.js";
import {
  PARTICIPANT_HUES,
  SCHEME_COLOR_TOKENS,
  participantHueTokenName,
  tokenReference,
  tokenVariableName,
} from "./tokens.js";

/** The DOM attribute an explicit scheme choice is stamped on. */
export const SCHEME_ATTRIBUTE = "data-console-scheme";

/**
 * The complete text of `meridian.css`. Deterministic: same inputs, same bytes,
 * including the trailing newline the assets tier compares.
 */
export function generateMeridianCss(): string {
  // The emitted banner deliberately names no document: this text is written into the
  // live stylesheet, and a reference like that belongs in source comments rather than
  // in shipped output. The rules it alludes to are design-language rules 2-5 and 7.
  const header = [
    "/*",
    " * GENERATED AT RUNTIME — there is no committed copy of this sheet.",
    " *",
    " * `console/tokens/generate-css.ts` builds this text and",
    " * `console/frame/bindings/token-installation.ts` writes it into the document head",
    " * before first paint. A committed copy would be a second record of the",
    " * palette, and the only defence against the two drifting would be a byte-diff",
    " * test whose failure mode is a forgotten regeneration command.",
    " *",
    " * Sources of truth: `console/tokens/palette.ts` for the colour ramps and the",
    " * spacing and radius scales, `console/tokens/motion.ts` for the motion scale and",
    " * its easing, and `console/tokens/typography.ts` for the type scale, the line",
    " * height, and the font stacks.",
    " *",
    " * The design language's colour, type, and spacing rules live in those two files'",
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
    schemeColorBlock("light", ""),
    invariantBlock(),
    "}",
  ].join("\n");

  const systemDarkBlock = [
    "@media (prefers-color-scheme: dark) {",
    "  /* System preference wins only where the operator has expressed none. */",
    '  :root:not([data-console-scheme="light"]) {',
    schemeColorBlock("dark", "  "),
    "  }",
    "}",
  ].join("\n");

  // The explicit-choice layer. It carries no palette for light — `:root` already
  // holds those values and the media block excludes itself on this attribute — so
  // the light arm exists for `color-scheme` alone. See the header for why that
  // declaration rides each arm rather than the root.
  const explicitLightBlock = [
    "/* An explicit choice beats the system preference in both directions, for the",
    "   browser's own controls as well as for the palette. */",
    '[data-console-scheme="light"] {',
    "  color-scheme: light;",
    "}",
  ].join("\n");

  const explicitDarkBlock = [
    '[data-console-scheme="dark"] {',
    "  color-scheme: dark;",
    "",
    schemeColorBlock("dark", ""),
    "}",
  ].join("\n");

  const baseBlock = [
    "/* The console's own ground. The host paints its own field behind the",
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
    // No `font-feature-settings` here, deliberately. Rule 4's slashed zero is the
    // MONO signature, and this property inherits — declaring it on the root put the
    // slash on every participant name, repo path, and branch in the console, and
    // then prevented any descendant from scoping the feature back. It rides the mono
    // `@font-face` descriptors in `frame/bindings/typeface.ts` instead.
    "  -webkit-font-smoothing: antialiased;",
    "}",
    "",
    "/* Rule 5: `prefers-reduced-motion` collapses everything to opacity. */",
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

function schemeColorBlock(scheme: ConsoleScheme, indent: string): string {
  const lines: string[] = [];
  for (const [tokenName, pair] of SCHEME_COLOR_TOKENS) {
    lines.push(`${indent}${declaration(tokenName, formatOklch(pair[scheme]))}`);
  }
  return lines.join("\n");
}

function invariantBlock(): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("  /* Participant wheel — identity, never attention, never theme. */");
  PARTICIPANT_HUES.forEach((color, step) => {
    lines.push(declaration(participantHueTokenName(step), formatOklch(color)));
  });

  lines.push("");
  lines.push("  /* Vocabulary aliases — a family's own name for a console token.");
  lines.push("     Emitted here rather than in each scheme layer because the token");
  lines.push("     each one defers to already swaps. */");
  for (const [tokenName, targetTokenName] of Object.entries(TOKEN_ALIASES)) {
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

  lines.push("");
  lines.push("  /* Space and radius. */");
  for (const [tokenName, sizeRem] of Object.entries(SPACE_SCALE_REM)) {
    lines.push(declaration(tokenName, `${sizeRem}rem`));
  }
  for (const [tokenName, sizeRem] of Object.entries(RADIUS_SCALE_REM)) {
    lines.push(declaration(tokenName, `${sizeRem}rem`));
  }
  lines.push(declaration("attribution-edge", `${ATTRIBUTION_EDGE_WIDTH_PX}px`));
  lines.push(declaration("enumeration-max-height", `${BOUNDED_ENUMERATION_HEIGHT_REM}rem`));
  // The reflow floor. Emitted rather than written into `frame.css` as a literal
  // because it is the palette's number and the frame is only the first thing to
  // spend it — a surface that has to declare the same floor reads the property
  // instead of copying the figure. It cannot be a media-query condition (custom
  // properties do not reach one), and it is not meant to be: the console holds this
  // width with one fluid layout rather than with a breakpoint.
  lines.push(declaration("reflow-min-width", `${REFLOW_MIN_WIDTH_PX}px`));

  lines.push("");
  lines.push("  /* Motion — settles, never bounces. */");
  for (const [tokenName, durationMs] of Object.entries(MOTION_DURATIONS_MS)) {
    lines.push(declaration(tokenName, `${durationMs}ms`));
  }
  // ONE settle easing, and it is the spring the console's motion rules ask for —
  // sampled at BUILD time rather than here, because both of the sampler's inputs are
  // constants and a pure function of constants is one: `motion.ts` carries the emitted
  // `linear()` and `motion.test.ts` holds it to the sampler, which no longer ships. So
  // nothing computes a spring while anything is on screen, and the compositor runs the
  // emitted curve under the platform's own timing. It is emitted under the name every
  // stylesheet already reads: a second token holding the sampled curve left the
  // hand-written cubic answering `var(--meridian-ease-settle)` everywhere while the
  // spring the rule asks for was declared under a name no sheet spent.
  lines.push(declaration("ease-settle", CHROME_SETTLE_EASING));

  return lines.join("\n");
}
