// Graphite: warm neutrals at hue 80 in light and 60 in dark with a cyan accent. Its quieter text
// steps are its text painted over its ground, made opaque; its tinted grounds are its marks washed
// into its ground the same way. Its light well, its control boundary and its light code and
// terminal colors sit at the lightness their floors admit.

import { oklch, type ThemePalette } from "./palette.js";

/** Graphite's color table, its name and its glass. */
export const GRAPHITE_PALETTE: ThemePalette = {
  name: "Graphite",
  colors: {
    ground: { light: oklch(0.978, 0.005, 80), dark: oklch(0.155, 0.008, 60) },
    surface: { light: oklch(0.955, 0.006, 80), dark: oklch(0.185, 0.008, 60) },
    "surface-raised": { light: oklch(0.92, 0.008, 80), dark: oklch(0.22, 0.008, 60) },
    // The light well is as deep as the agent wheel's step 5 still clears 3:1 on it.
    "surface-sunken": { light: oklch(0.91, 0.01, 80), dark: oklch(0.265, 0.008, 60) },
    edge: { light: oklch(0.85, 0.01, 80), dark: oklch(0.3, 0.008, 60) },
    "edge-strong": { light: oklch(0.595, 0.012, 80), dark: oklch(0.545, 0.008, 60) },
    text: { light: oklch(0.22, 0.012, 60), dark: oklch(0.95, 0.006, 80) },
    "text-muted": { light: oklch(0.338, 0.01, 62), dark: oklch(0.811, 0.006, 77) },
    "text-faint": { light: oklch(0.501, 0.008, 65), dark: oklch(0.666, 0.006, 73) },
    "amber-text": { light: oklch(0.5, 0.14, 75), dark: oklch(0.78, 0.14, 80) },
    "amber-mark": { light: oklch(0.6, 0.15, 80), dark: oklch(0.78, 0.14, 80) },
    "amber-ground": { light: oklch(0.925, 0.025, 80), dark: oklch(0.268, 0.031, 76) },
    "red-text": { light: oklch(0.485, 0.185, 27), dark: oklch(0.73, 0.17, 25) },
    "red-mark": { light: oklch(0.53, 0.18, 27), dark: oklch(0.66, 0.19, 25) },
    "red-ground": { light: oklch(0.924, 0.025, 35), dark: oklch(0.256, 0.043, 30) },
    accent: { light: oklch(0.52, 0.12, 205), dark: oklch(0.8, 0.12, 200) },
    "accent-text": { light: oklch(0.44, 0.11, 205), dark: oklch(0.8, 0.12, 200) },
    // The light accent is deep enough to carry a near-white ink; the dark one carries a dark ink.
    "accent-ink": { light: oklch(0.99, 0, 0), dark: oklch(0.16, 0.02, 200) },
    // The inks run opposite ways, so the light face deepens when pressed and the dark brightens.
    "accent-pressed": { light: oklch(0.46, 0.12, 205), dark: oklch(0.86, 0.11, 200) },
    "code-keyword": { light: oklch(0.515, 0.14, 290), dark: oklch(0.74, 0.13, 290) },
    "code-name": { light: oklch(0.485, 0.13, 230), dark: oklch(0.76, 0.12, 230) },
    "code-string": { light: oklch(0.48, 0.15, 150), dark: oklch(0.76, 0.14, 150) },
    "code-number": { light: oklch(0.51, 0.14, 65), dark: oklch(0.8, 0.13, 70) },
    "ansi-red": { light: oklch(0.48, 0.16, 25), dark: oklch(0.76, 0.14, 25) },
    "ansi-green": { light: oklch(0.48, 0.15, 150), dark: oklch(0.74, 0.15, 150) },
    "ansi-yellow": { light: oklch(0.465, 0.11, 85), dark: oklch(0.84, 0.11, 85) },
    "ansi-blue": { light: oklch(0.485, 0.13, 230), dark: oklch(0.76, 0.12, 230) },
    "ansi-magenta": { light: oklch(0.48, 0.13, 330), dark: oklch(0.79, 0.12, 330) },
    "ansi-cyan": { light: oklch(0.455, 0.09, 205), dark: oklch(0.81, 0.08, 205) },
    "ansi-bright-red": { light: oklch(0.515, 0.18, 25), dark: oklch(0.83, 0.14, 25) },
    "ansi-bright-green": { light: oklch(0.485, 0.14, 150), dark: oklch(0.87, 0.13, 150) },
    "ansi-bright-yellow": { light: oklch(0.495, 0.12, 85), dark: oklch(0.9, 0.11, 85) },
    "ansi-bright-blue": { light: oklch(0.49, 0.13, 230), dark: oklch(0.86, 0.1, 230) },
    "ansi-bright-magenta": { light: oklch(0.51, 0.15, 330), dark: oklch(0.86, 0.12, 330) },
    "ansi-bright-cyan": { light: oklch(0.485, 0.1, 205), dark: oklch(0.88, 0.08, 205) },
  },
  glassOpacityPercent: { light: 88, dark: 84 },
};
