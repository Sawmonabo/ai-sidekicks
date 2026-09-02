// Generator for `meridian.css`.
//
// The committed stylesheet is a build artifact of `palette.ts`, not a second
// source of truth: the console's assets tier (`Spec-023 §Console Test Tiers`,
// the assets row — "generated tokens and schema artifacts byte-identical to
// their sources") byte-diffs the committed file against this function's output,
// so a color edited in CSS alone turns the build red rather than quietly
// diverging from what the contrast test measures.
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
import {
  ATTRIBUTION_EDGE_WIDTH_PX,
  FONT_STACKS,
  MOTION_DURATIONS_MS,
  MOTION_EASE_SETTLE,
  RADIUS_SCALE_REM,
  SPACE_SCALE_REM,
  TYPE_SCALE_REM,
} from "./palette.js";
import type { ConsoleScheme } from "./tokens.js";
import {
  PARTICIPANT_HUES,
  SCHEME_COLOR_TOKENS,
  participantHueTokenName,
  tokenVariableName,
} from "./tokens.js";

/** The DOM attribute an explicit scheme choice is stamped on. */
export const SCHEME_ATTRIBUTE = "data-console-scheme";

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

  lines.push("");
  lines.push("  /* Motion — settles, never bounces. */");
  for (const [tokenName, durationMs] of Object.entries(MOTION_DURATIONS_MS)) {
    lines.push(declaration(tokenName, `${durationMs}ms`));
  }
  lines.push(declaration("ease-settle", MOTION_EASE_SETTLE));

  return lines.join("\n");
}

/**
 * The complete text of `meridian.css`. Deterministic: same inputs, same bytes,
 * including the trailing newline the assets tier compares.
 */
export function generateMeridianCss(): string {
  const header = [
    "/*",
    " * GENERATED AT RUNTIME — there is no committed copy of this sheet.",
    " *",
    " * `console/tokens/generate-css.ts` builds this text and",
    " * `console/tokens/install.ts` writes it into the document head before first",
    " * paint. A committed copy would be a second record of the palette, and the",
    " * only defence against the two drifting would be a byte-diff test whose",
    " * failure mode is a forgotten regeneration command.",
    " *",
    " * Source of truth: `console/tokens/palette.ts`.",
    " *",
    " * `Spec-023 §Console Design (Meridian)` rules 2-5 and 7 live in the palette's",
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
    "  line-height: 1.5;",
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
