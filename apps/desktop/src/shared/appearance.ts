// The appearance record's vocabulary: the theme, the color scheme, the text size and the
// transcript width.
//
// Main keeps the record in its own file and stamps it on every console document before the
// first paint; a window changes it through the bridge and hears it back through the bridge.
// Main and the renderer both read these values, so they are declared here once.

/** The two themes, and no third. */
export const APPEARANCE_THEMES = ["meridian", "graphite"] as const;

/** One theme. */
export type AppearanceTheme = (typeof APPEARANCE_THEMES)[number];

/**
 * Every scheme the console renders in. The tuple is the declaration and `ColorScheme`
 * follows from it, so a walk over the list and a switch over the union cannot disagree.
 */
export const COLOR_SCHEMES = ["light", "dark"] as const;

/** A scheme the console renders in: a resolved answer that always paints something. */
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** The preference value that names no scheme and defers to the operating system. */
export const SYSTEM_SCHEME_PREFERENCE = "system";

/** What a person can choose: a scheme, or the operating system's. */
export type SchemePreference = ColorScheme | typeof SYSTEM_SCHEME_PREFERENCE;

/** The appearance record: every value an enum or a number. */
export interface AppearanceRecord {
  readonly theme: AppearanceTheme;
  readonly scheme: SchemePreference;
  /** The root font size, in CSS pixels. */
  readonly textSize: number;
  /** The transcript column's width, in root-relative units. */
  readonly transcriptWidth: number;
}

/**
 * The current theme's two grounds, as CSS colors. Both are sent, because under `system`
 * main cannot know which one the first frame after an operating-system change needs.
 */
export interface AppearanceGrounds {
  readonly light: string;
  readonly dark: string;
}
