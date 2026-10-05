// Meridian color math: OKLCH authoring, sRGB rendering, WCAG 2.2 measurement. One conversion path
// serves the contrast floors a test must measure, the twelve hues drawn from an OKLCH wheel, and
// the `#rrggbb` grounds main paints a window's first frame in, so both processes read it. OKLCH is
// perceptually uniform in lightness, sRGB is what a display emits, and WCAG relative luminance is
// what the floors are stated in.
//
// Colors are pre-fitted into gamut here rather than left to the browser: CSS Color 4 gamut-maps an
// out-of-gamut `oklch()` by a binary search against a deltaE bound, and a test modeling that would
// measure its own guess. Every color is chroma-fitted at authoring time (`fitChromaIntoSrgbGamut`),
// so the browser maps nothing and `oklchToSrgb` is exact.
//
// The matrices are Björn Ottosson's OKLab constants, the same ones CSS Color 4 carries.

/** A color authored in OKLCH. `hueDegrees` is the CSS hue angle. */
export interface OklchColor {
  /** Perceptual lightness, 0 (black) to 1 (white). */
  readonly lightness: number;
  /** Chroma. 0 is achromatic; sRGB tops out near 0.37 at the most saturated hues. */
  readonly chroma: number;
  /** Hue angle in degrees, 0-360. */
  readonly hueDegrees: number;
}

/** A color in gamma-encoded sRGB, each channel 0-1. */
export interface SrgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

const SRGB_GAMMA_THRESHOLD = 0.0031308;
const SRGB_INVERSE_GAMMA_THRESHOLD = 0.04045;

function encodeSrgbChannel(linearChannel: number): number {
  return linearChannel <= SRGB_GAMMA_THRESHOLD
    ? 12.92 * linearChannel
    : 1.055 * Math.pow(linearChannel, 1 / 2.4) - 0.055;
}

function decodeSrgbChannel(encodedChannel: number): number {
  return encodedChannel <= SRGB_INVERSE_GAMMA_THRESHOLD
    ? encodedChannel / 12.92
    : Math.pow((encodedChannel + 0.055) / 1.055, 2.4);
}

interface LinearSrgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

function oklchToLinearSrgb(color: OklchColor): LinearSrgbColor {
  const hueRadians = (color.hueDegrees * Math.PI) / 180;
  const opponentA = color.chroma * Math.cos(hueRadians);
  const opponentB = color.chroma * Math.sin(hueRadians);

  const longRoot = color.lightness + 0.3963377774 * opponentA + 0.2158037573 * opponentB;
  const mediumRoot = color.lightness - 0.1055613458 * opponentA - 0.0638541728 * opponentB;
  const shortRoot = color.lightness - 0.0894841775 * opponentA - 1.291485548 * opponentB;

  const long = longRoot * longRoot * longRoot;
  const medium = mediumRoot * mediumRoot * mediumRoot;
  const short = shortRoot * shortRoot * shortRoot;

  return {
    red: 4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    green: -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    blue: -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  };
}

const GAMUT_EPSILON = 1e-6;

/** True when the color as authored renders inside sRGB with no gamut mapping. */
export function isOklchInsideSrgbGamut(color: OklchColor): boolean {
  return isInsideSrgbGamut(oklchToLinearSrgb(color));
}

function isInsideSrgbGamut(linear: LinearSrgbColor): boolean {
  return (
    linear.red >= -GAMUT_EPSILON &&
    linear.red <= 1 + GAMUT_EPSILON &&
    linear.green >= -GAMUT_EPSILON &&
    linear.green <= 1 + GAMUT_EPSILON &&
    linear.blue >= -GAMUT_EPSILON &&
    linear.blue <= 1 + GAMUT_EPSILON
  );
}

/**
 * The number of bisection steps `fitChromaIntoSrgbGamut` takes. Twenty halvings of a 0.4-wide
 * chroma interval settle below 4e-7, finer than the decimals the emitted CSS carries.
 */
export const GAMUT_FIT_BISECTION_STEPS = 20;

/**
 * Reduce chroma at fixed lightness and hue until the color is inside sRGB.
 * Returns the color unchanged when it already is.
 */
export function fitChromaIntoSrgbGamut(color: OklchColor): OklchColor {
  if (isOklchInsideSrgbGamut(color)) {
    return color;
  }
  let feasibleChroma = 0;
  let infeasibleChroma = color.chroma;
  for (let step = 0; step < GAMUT_FIT_BISECTION_STEPS; step += 1) {
    const candidateChroma = (feasibleChroma + infeasibleChroma) / 2;
    if (isOklchInsideSrgbGamut({ ...color, chroma: candidateChroma })) {
      feasibleChroma = candidateChroma;
    } else {
      infeasibleChroma = candidateChroma;
    }
  }
  return { ...color, chroma: feasibleChroma };
}

/** Convert to gamma-encoded sRGB, clamping each channel into 0-1. */
export function oklchToSrgb(color: OklchColor): SrgbColor {
  const linear = oklchToLinearSrgb(color);
  const clamp = (channel: number): number => Math.min(1, Math.max(0, encodeSrgbChannel(channel)));
  return {
    red: clamp(linear.red),
    green: clamp(linear.green),
    blue: clamp(linear.blue),
  };
}

/** `#rrggbb`, each channel rounded to the nearest of the 256 steps a display shows. */
export function formatSrgbHex(color: SrgbColor): string {
  const channels = [color.red, color.green, color.blue];
  return `#${channels
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * WCAG 2.2 contrast ratio between two colors already in sRGB; 1 (identical) to 21 (black on
 * white). A CSS `filter` works on sRGB channels and has no OKLCH form, so a filtered treatment is
 * measured on the triple the filter produced: scaling both channels does not preserve their
 * ratio, because relative luminance carries a 0.05 offset.
 */
export function srgbContrastRatio(foreground: SrgbColor, background: SrgbColor): number {
  const foregroundLuminance = srgbRelativeLuminance(foreground);
  const backgroundLuminance = srgbRelativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 2.2 contrast ratio between two colors; 1 (identical) to 21 (black on white). */
export function contrastRatio(foreground: OklchColor, background: OklchColor): number {
  return srgbContrastRatio(oklchToSrgb(foreground), oklchToSrgb(background));
}

/**
 * The CSS `oklch()` function text for a color, at three decimal places for lightness, four for
 * chroma and one for hue. Rounding happens before measurement, so the number a contrast test
 * reads is the number the browser paints.
 */
export function formatOklch(color: OklchColor): string {
  const lightness = color.lightness.toFixed(3);
  const chroma = color.chroma.toFixed(4);
  const hue = color.hueDegrees.toFixed(1);
  return `oklch(${lightness} ${chroma} ${hue})`;
}

/** Round a color to the precision `formatOklch` emits, so measurement matches paint. */
export function roundToEmittedPrecision(color: OklchColor): OklchColor {
  return {
    lightness: Number(color.lightness.toFixed(3)),
    chroma: Number(color.chroma.toFixed(4)),
    hueDegrees: Number(color.hueDegrees.toFixed(1)),
  };
}

/**
 * WCAG 2.2 relative luminance of a displayed sRGB triple. The triple is what the display shows,
 * since a channel it cannot show contributes the luminance of the channel it shows instead.
 */
function srgbRelativeLuminance(displayed: SrgbColor): number {
  return (
    0.2126 * decodeSrgbChannel(displayed.red) +
    0.7152 * decodeSrgbChannel(displayed.green) +
    0.0722 * decodeSrgbChannel(displayed.blue)
  );
}

/** Decimal places `formatOklch` emits for chroma. The gamut floor rounds to this. */
const CHROMA_EMITTED_DECIMALS = 4;

/**
 * The value a token actually carries: rounded to the precision the CSS emits and inside sRGB at
 * that precision.
 *
 * The order matters. Lightness and hue round first (the fit moves neither), the fit runs on
 * those values, and the fitted chroma rounds down. Rounding to nearest could cross back over the
 * boundary the fit found by up to half a step, fifty times the gamut epsilon; reducing chroma
 * only moves further inside the gamut.
 */
export function resolveEmittedColor(color: OklchColor): OklchColor {
  const rounded = roundToEmittedPrecision(color);
  if (isOklchInsideSrgbGamut(rounded)) {
    return rounded;
  }
  const fitted = fitChromaIntoSrgbGamut(rounded);
  const step = 10 ** CHROMA_EMITTED_DECIMALS;
  return { ...fitted, chroma: Math.floor(fitted.chroma * step) / step };
}
