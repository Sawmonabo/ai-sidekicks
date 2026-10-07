// The themes the app ships, and each one's table. Everything that varies by theme reads this list:
// the kept record's schema, the stylesheet's layers, the grounds main paints a window's first frame
// with, the contrast check's renderings and the Appearance page's choice. A new theme is its table
// beside the others, its id here and its entry in `THEME_PALETTES`; the compiler names anything
// else a table leaves out.

import { GRAPHITE_PALETTE } from "./graphite.js";
import { MERIDIAN_PALETTE } from "./meridian.js";
import type { ThemePalette } from "./palette.js";

/** Every theme the app ships, the default first. */
export const APPEARANCE_THEMES = ["meridian", "graphite"] as const;

/** One theme. */
export type AppearanceTheme = (typeof APPEARANCE_THEMES)[number];

/** Each theme's table. Total over the theme list, so a theme with no table does not compile. */
export const THEME_PALETTES: Readonly<Record<AppearanceTheme, ThemePalette>> = {
  meridian: MERIDIAN_PALETTE,
  graphite: GRAPHITE_PALETTE,
};

/** One value per theme, read from each in the list's order. */
export function mapEveryTheme<Value>(
  read: (theme: AppearanceTheme) => Value,
): Readonly<Record<AppearanceTheme, Value>> {
  return Object.fromEntries(APPEARANCE_THEMES.map((theme) => [theme, read(theme)])) as Record<
    AppearanceTheme,
    Value
  >;
}
