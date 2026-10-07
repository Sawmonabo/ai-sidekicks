// The color scheme vocabulary: the schemes the app renders in and what a person can choose. The
// themes' color tables and the appearance record both build on it, so it sits below both.

import type { OklchColor } from "./color.js";

/** Every scheme the app renders in; `ColorScheme` is derived from this tuple. */
export const COLOR_SCHEMES = ["light", "dark"] as const;

/** A scheme the app renders in: a resolved answer that always paints something. */
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** The preference value that names no scheme and defers to the operating system. */
export const SYSTEM_SCHEME_PREFERENCE = "system";

/** What a person can choose: a scheme, or the operating system's. */
export type SchemePreference = ColorScheme | typeof SYSTEM_SCHEME_PREFERENCE;

/** One color in each scheme. */
export type SchemePair = Readonly<Record<ColorScheme, OklchColor>>;
