// The appearance record's vocabulary: the theme, the color scheme, the text size, the transcript
// width and the current theme's two grounds, and the root element main stamps them on and the
// renderer keeps current. Main and the renderer both read these values, so they are declared here
// once.

import { formatSrgbHex, oklchToSrgb, resolveEmittedColor, type OklchColor } from "./color.js";
import { tokenVariableName } from "./token-variable.js";

/** The two themes, and no third. */
export const APPEARANCE_THEMES = ["meridian", "graphite"] as const;

/** One theme. */
export type AppearanceTheme = (typeof APPEARANCE_THEMES)[number];

/** Every scheme the app renders in; `ColorScheme` is derived from this tuple. */
export const COLOR_SCHEMES = ["light", "dark"] as const;

/** A scheme the app renders in: a resolved answer that always paints something. */
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

/** The preference value that names no scheme and defers to the operating system. */
export const SYSTEM_SCHEME_PREFERENCE = "system";

/** What a person can choose: a scheme, or the operating system's. */
export type SchemePreference = ColorScheme | typeof SYSTEM_SCHEME_PREFERENCE;

/**
 * The current theme's two grounds, as `#rrggbb` colors, the form the platform paints a window's
 * first frame in. Both are sent because under `system` main cannot know which one the first
 * frame after an operating-system change needs.
 */
export interface AppearanceGrounds {
  readonly light: string;
  readonly dark: string;
}

/** The four text sizes, `Small · Default · Large · Larger`, as root font sizes in CSS pixels. */
export const TEXT_SIZES = [15, 16, 18, 20] as const;

/** One text size. */
export type TextSize = (typeof TEXT_SIZES)[number];

/**
 * The narrowest transcript width, in root font sizes: a tool row still fits its verb, its path
 * and its timing on one line.
 */
export const TRANSCRIPT_WIDTH_FLOOR = 35.5;

/** The widest transcript width, in root font sizes: prose still reads at the largest text size. */
export const TRANSCRIPT_WIDTH_CEILING = 74.5;

/** The appearance record main keeps in `appearance.json`: enums, numbers and colors. */
export interface AppearanceRecord {
  readonly theme: AppearanceTheme;
  readonly scheme: SchemePreference;
  /** The root font size, in CSS pixels. */
  readonly textSize: TextSize;
  /** The transcript column's width, in root-relative units. */
  readonly transcriptWidth: number;
  readonly grounds: AppearanceGrounds;
}

/** One color in each scheme. */
export interface SchemePair {
  readonly light: OklchColor;
  readonly dark: OklchColor;
}

/**
 * Each theme's ground, the window's own field, in each scheme: the palette's `ground` token. Here
 * rather than in the palette because main paints a window's first frame from it.
 */
export const THEME_GROUND_COLORS: Readonly<Record<AppearanceTheme, SchemePair>> = {
  meridian: {
    light: { lightness: 0.965, chroma: 0.003, hueDegrees: 255 },
    dark: { lightness: 0.165, chroma: 0.011, hueDegrees: 255 },
  },
  graphite: {
    light: { lightness: 0.978, chroma: 0.005, hueDegrees: 80 },
    dark: { lightness: 0.155, chroma: 0.008, hueDegrees: 60 },
  },
};

/**
 * Each theme's two grounds as the stylesheet paints them, in `#rrggbb`: the grounds a choice of
 * that theme hands main, which paints a window's first frame with them before any page loads.
 */
export const THEME_GROUNDS: Readonly<Record<AppearanceTheme, AppearanceGrounds>> = {
  meridian: paintedGrounds(THEME_GROUND_COLORS.meridian),
  graphite: paintedGrounds(THEME_GROUND_COLORS.graphite),
};

/**
 * The appearance a missing or broken record reads as: Meridian, following the system's scheme, at
 * the 16 px root, with the transcript at its reading measure of 57.5 root font sizes.
 */
export const DEFAULT_APPEARANCE_RECORD: AppearanceRecord = {
  theme: "meridian",
  scheme: SYSTEM_SCHEME_PREFERENCE,
  textSize: 16,
  transcriptWidth: 57.5,
  grounds: THEME_GROUNDS.meridian,
};

/** The part of the record a person chooses; the grounds come from the theme. */
export type AppearanceChoice = Pick<
  AppearanceRecord,
  "theme" | "scheme" | "textSize" | "transcriptWidth"
>;

/**
 * The root-element attribute an explicit scheme choice is stamped on. Absent under `system`, so
 * the stylesheet's `prefers-color-scheme` layer keeps deciding.
 */
export const SCHEME_ATTRIBUTE = "data-color-scheme";

/**
 * The root-element attribute carrying the scheme the page is drawn in, `light` or `dark`, under
 * `system` too, so code that reads the scheme, rather than styling by it, needs no media query.
 */
export const RESOLVED_SCHEME_ATTRIBUTE = "data-resolved-color-scheme";

/** The root-element attribute carrying the theme. */
export const THEME_ATTRIBUTE = "data-theme";

/** The root custom property every session's transcript reads its column width from. */
const TRANSCRIPT_WIDTH_PROPERTY = tokenVariableName("transcript-width");

/**
 * What the document's root element carries for one record: its attributes, one left off where
 * it is `undefined`, and its inline style properties. Main stamps it on the console document it
 * serves and the renderer applies it on every change, so the two write the same root.
 */
export interface RootAppearance {
  readonly attributes: Readonly<Record<string, string | undefined>>;
  readonly styleProperties: Readonly<Record<string, string>>;
}

/**
 * The root for `record`: the theme, the explicit scheme (none under `system`, so the
 * stylesheet's `prefers-color-scheme` layer keeps deciding), the scheme resolved to light or dark,
 * `platformScheme` under `system`, the root font size and the transcript width.
 */
export function composeRootAppearance(
  record: AppearanceRecord,
  platformScheme: ColorScheme,
): RootAppearance {
  const isSystem = record.scheme === SYSTEM_SCHEME_PREFERENCE;
  return {
    attributes: {
      [THEME_ATTRIBUTE]: record.theme,
      [SCHEME_ATTRIBUTE]: isSystem ? undefined : record.scheme,
      [RESOLVED_SCHEME_ATTRIBUTE]: isSystem ? platformScheme : record.scheme,
    },
    styleProperties: {
      "font-size": `${String(record.textSize)}px`,
      [TRANSCRIPT_WIDTH_PROPERTY]: `${String(record.transcriptWidth)}rem`,
    },
  };
}

function paintedGrounds(grounds: SchemePair): AppearanceGrounds {
  return {
    light: formatSrgbHex(oklchToSrgb(resolveEmittedColor(grounds.light))),
    dark: formatSrgbHex(oklchToSrgb(resolveEmittedColor(grounds.dark))),
  };
}
