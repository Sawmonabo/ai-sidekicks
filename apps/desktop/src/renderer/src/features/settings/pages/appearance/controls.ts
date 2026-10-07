import type { SettingsControl } from "../../types.js";

/** The head of the Appearance page's color-scheme choice. */
export const COLOR_SCHEME_HEADING = "Color scheme";

/** The one line drawn under the color-scheme choice, which every option sits in. */
export const COLOR_SCHEME_HINT =
  "System is the default. It follows whatever this Mac is set to, and each theme ships both.";

/** The controls the Appearance page draws that search finds, in the order the page draws them. */
export const APPEARANCE_CONTROLS: Readonly<Record<"system" | "light" | "dark", SettingsControl>> = {
  system: {
    id: "color-scheme-system",
    label: "System",
    heading: COLOR_SCHEME_HEADING,
    hint: COLOR_SCHEME_HINT,
  },
  light: {
    id: "color-scheme-light",
    label: "Light",
    heading: COLOR_SCHEME_HEADING,
    hint: COLOR_SCHEME_HINT,
  },
  dark: {
    id: "color-scheme-dark",
    label: "Dark",
    heading: COLOR_SCHEME_HEADING,
    hint: COLOR_SCHEME_HINT,
  },
};
