// A terminal's colors as the app's own: its default text and ground and the four ANSI names that
// are ends of the reading scale take an app color role, and the twelve hued names are roles of
// their own. The stylesheet's aliases and the colors main reports to the background service both
// read this table, so a shell answers a program with the colors the pane paints.

import type { TerminalColors } from "@ai-sidekicks/contracts/pty";

import { formatPaintedHex } from "../color.js";
import type { ColorScheme } from "../color-scheme.js";
import type { ColorRole } from "./palette.js";
import { THEME_PALETTES, type AppearanceTheme } from "./registry.js";

type TerminalRoleAlias =
  | "ansi-default-foreground"
  | "ansi-default-background"
  | "ansi-black"
  | "ansi-white"
  | "ansi-bright-black"
  | "ansi-bright-white";

/**
 * Each terminal name's app color role. A terminal's black and white are the two ends of the
 * reading scale; a literal black on a dark scheme would render output invisible.
 */
export const TERMINAL_ROLE_ALIASES: Readonly<Record<TerminalRoleAlias, ColorRole>> = {
  "ansi-default-foreground": "text",
  "ansi-default-background": "surface-sunken",
  "ansi-black": "text-faint",
  "ansi-white": "text-muted",
  "ansi-bright-black": "text-muted",
  "ansi-bright-white": "text",
};

// The sixteen colors' roles in the order a program numbers them, black first and bright white last.
const TERMINAL_PALETTE_ROLES: readonly ColorRole[] = [
  TERMINAL_ROLE_ALIASES["ansi-black"],
  "ansi-red",
  "ansi-green",
  "ansi-yellow",
  "ansi-blue",
  "ansi-magenta",
  "ansi-cyan",
  TERMINAL_ROLE_ALIASES["ansi-white"],
  TERMINAL_ROLE_ALIASES["ansi-bright-black"],
  "ansi-bright-red",
  "ansi-bright-green",
  "ansi-bright-yellow",
  "ansi-bright-blue",
  "ansi-bright-magenta",
  "ansi-bright-cyan",
  TERMINAL_ROLE_ALIASES["ansi-bright-white"],
];

/**
 * A terminal's colors in `theme` and `scheme`, each as the stylesheet paints it. The cursor is the
 * text color, as a terminal draws it by default.
 */
export function composeTerminalColors(theme: AppearanceTheme, scheme: ColorScheme): TerminalColors {
  const colors = THEME_PALETTES[theme].colors;
  const paint = (role: ColorRole): string => formatPaintedHex(colors[role][scheme]);
  const foreground = paint(TERMINAL_ROLE_ALIASES["ansi-default-foreground"]);
  return {
    foreground,
    background: paint(TERMINAL_ROLE_ALIASES["ansi-default-background"]),
    cursor: foreground,
    palette: TERMINAL_PALETTE_ROLES.map(paint),
  };
}
