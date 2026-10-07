import type { SettingsControl } from "../../types.js";

/** The head of the Appearance page's color-scheme choice. */
export const COLOR_SCHEME_HEADING = "Color scheme";

/** The controls the Appearance page draws that search finds, in the order the page draws them. */
export const APPEARANCE_CONTROLS: Readonly<
  Record<"followSystem" | "light" | "dark", SettingsControl>
> = {
  followSystem: {
    id: "color-scheme-system",
    label: "Follow this machine",
    heading: COLOR_SCHEME_HEADING,
    hint:
      "Paints whichever scheme the operating system is in, and keeps following it when that " +
      "changes.",
  },
  light: {
    id: "color-scheme-light",
    label: "Light",
    heading: COLOR_SCHEME_HEADING,
    hint: "Holds the light scheme whatever the operating system is doing.",
  },
  dark: {
    id: "color-scheme-dark",
    label: "Dark",
    heading: COLOR_SCHEME_HEADING,
    hint: "Holds the dark scheme whatever the operating system is doing.",
  },
};
