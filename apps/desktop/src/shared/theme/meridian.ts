// Meridian, the default theme: cool neutrals at hue 255 with a desaturated cyan accent.

import { oklch, type ThemePalette } from "./palette.js";

/** Meridian's color table, its name and its glass. */
export const MERIDIAN_PALETTE: ThemePalette = {
  name: "Meridian",
  colors: {
    ground: { light: oklch(0.965, 0.003, 255), dark: oklch(0.165, 0.011, 255) },
    surface: { light: oklch(0.995, 0.001, 255), dark: oklch(0.203, 0.013, 255) },
    "surface-raised": { light: oklch(1, 0, 255), dark: oklch(0.246, 0.014, 255) },
    "surface-sunken": { light: oklch(0.93, 0.005, 255), dark: oklch(0.132, 0.01, 255) },
    edge: { light: oklch(0.885, 0.006, 255), dark: oklch(0.3, 0.014, 255) },
    "edge-strong": { light: oklch(0.61, 0.014, 255), dark: oklch(0.538, 0.016, 255) },
    text: { light: oklch(0.24, 0.014, 255), dark: oklch(0.955, 0.004, 255) },
    "text-muted": { light: oklch(0.455, 0.016, 255), dark: oklch(0.775, 0.012, 255) },
    "text-faint": { light: oklch(0.515, 0.014, 255), dark: oklch(0.665, 0.014, 255) },
    "amber-text": { light: oklch(0.5, 0.13, 65), dark: oklch(0.845, 0.135, 80) },
    "amber-mark": { light: oklch(0.615, 0.155, 68), dark: oklch(0.76, 0.155, 72) },
    "amber-ground": { light: oklch(0.955, 0.04, 80), dark: oklch(0.26, 0.045, 72) },
    // The figure on the attention pip, painted on `amber-mark`. Dark in both schemes, as
    // `accent-ink` is: the scheme's light ground on the light amber stays under 3:1.
    "red-text": { light: oklch(0.485, 0.19, 25), dark: oklch(0.775, 0.145, 25) },
    "red-mark": { light: oklch(0.575, 0.215, 25), dark: oklch(0.66, 0.19, 25) },
    "red-ground": { light: oklch(0.95, 0.03, 25), dark: oklch(0.25, 0.055, 25) },
    accent: { light: oklch(0.575, 0.09, 215), dark: oklch(0.73, 0.085, 205) },
    "accent-text": { light: oklch(0.475, 0.1, 215), dark: oklch(0.845, 0.075, 205) },
    // The ink for a control filled with `accent`, and nothing else. `accent-text` is for
    // accent-colored text on a neutral ground; on the accent itself it reaches 1.53:1 in light
    // and 1.48:1 in dark, so the pair needs its own role, as `-text` and `-mark` do.
    //
    // Dark in both schemes, which is forced: a light ink cannot clear 4.5:1 on the light accent
    // (the lightest thing the table has, `surface-raised`, reaches 4.23:1, and `text` 3.89:1).
    // So the light leg sits at L 0.13 (4.75:1). The dark leg, on a lighter accent, sits at L 0.22
    // (7.41:1), the lightness of the dark scheme's own surfaces, so a filled control reads as the
    // app's ground punched out of the accent. Both carry a little of the accent's chroma.
    "accent-ink": { light: oklch(0.13, 0.03, 215), dark: oklch(0.22, 0.04, 205) },
    // The face of a pressed accent-filled control, a role rather than a `filter`: `brightness()`
    // scales both rendered colors, and scaling does not preserve a contrast ratio because
    // relative luminance carries a 0.05 offset. `brightness(0.94)` on the light face takes the
    // `accent-ink` pair from 4.75:1 to 4.27:1, through the 4.5:1 text floor.
    //
    // How far the light face may darken is arithmetic. The ink is dark in both schemes, so
    // contrast is monotone in the fill's luminance, and 4.5:1 against an ink of luminance L needs
    // a fill above 4.5 * (L + 0.05) - 0.05. Even a pure-black ink puts that at 0.175 and the
    // light accent's luminance is 0.198, so no ink buys a visibly darker press. The light leg
    // takes the deepest face the floor admits, L 0.565 at 4.57:1, with chroma up against the
    // sRGB edge so it reads deeper rather than dimmer; `accent-fill.css` carries the rest of the
    // press on the control's boundary. The dark leg can afford a real deepening: L 0.68 at
    // 6.18:1. Both legs clear 3:1 on the grounds, because a pressed face is still the boundary a
    // person must find.
    "accent-pressed": { light: oklch(0.565, 0.099, 215), dark: oklch(0.68, 0.095, 205) },
    "code-keyword": { light: oklch(0.45, 0.12, 300), dark: oklch(0.8, 0.11, 300) },
    "code-name": { light: oklch(0.44, 0.1, 250), dark: oklch(0.82, 0.09, 250) },
    "code-string": { light: oklch(0.42, 0.1, 150), dark: oklch(0.83, 0.1, 150) },
    "code-number": { light: oklch(0.45, 0.11, 45), dark: oklch(0.83, 0.1, 60) },
    "ansi-red": { light: oklch(0.48, 0.16, 25), dark: oklch(0.76, 0.14, 25) },
    "ansi-green": { light: oklch(0.45, 0.12, 150), dark: oklch(0.8, 0.12, 150) },
    "ansi-yellow": { light: oklch(0.48, 0.11, 85), dark: oklch(0.84, 0.11, 85) },
    "ansi-blue": { light: oklch(0.46, 0.11, 255), dark: oklch(0.79, 0.1, 255) },
    "ansi-magenta": { light: oklch(0.47, 0.13, 330), dark: oklch(0.79, 0.12, 330) },
    "ansi-cyan": { light: oklch(0.46, 0.09, 205), dark: oklch(0.81, 0.08, 205) },
    "ansi-bright-red": { light: oklch(0.535, 0.18, 25), dark: oklch(0.83, 0.14, 25) },
    "ansi-bright-green": { light: oklch(0.5, 0.14, 150), dark: oklch(0.87, 0.13, 150) },
    "ansi-bright-yellow": { light: oklch(0.515, 0.12, 85), dark: oklch(0.9, 0.11, 85) },
    "ansi-bright-blue": { light: oklch(0.515, 0.13, 255), dark: oklch(0.86, 0.1, 255) },
    "ansi-bright-magenta": { light: oklch(0.53, 0.15, 330), dark: oklch(0.86, 0.12, 330) },
    "ansi-bright-cyan": { light: oklch(0.505, 0.1, 205), dark: oklch(0.88, 0.08, 205) },
  },
  glassOpacityPercent: { light: 92, dark: 88 },
};
