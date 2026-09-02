// Meridian color math — OKLCH authoring, sRGB rendering, WCAG 2.2 measurement.
//
// `Spec-023 §Console Design (Meridian)` rule 3 states contrast floors that a
// test must be able to *measure*, and rule 2 generates the twelve participant
// hues from an OKLCH wheel. Both need one conversion path, so this module owns
// it: OKLCH is the authoring space (perceptually uniform lightness, so one
// lightness really does read as one lightness across the wheel), sRGB is what a
// display emits, and WCAG relative luminance is what the floors are stated in.
//
// Why the values are pre-fitted into gamut here rather than left to the browser:
// CSS Color 4 gamut-maps an out-of-gamut `oklch()` by reducing chroma along a
// binary search against a deltaE bound. Modelling that in a test is guesswork,
// and a test that guesses at the renderer's mapping measures the guess. Every
// Meridian color is therefore chroma-fitted (`fitChromaIntoSrgbGamut`) at
// authoring time, so the emitted `oklch()` is already inside sRGB, the browser
// maps nothing, and `oklchToSrgb` below is exact rather than approximate.
//
// The matrices are Björn Ottosson's OKLab publication (the same constants the
// CSS Color 4 specification carries in its sample code).

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

/** True when the color as authored renders inside sRGB with no gamut mapping. */
export function isOklchInsideSrgbGamut(color: OklchColor): boolean {
  return isInsideSrgbGamut(oklchToLinearSrgb(color));
}

/**
 * The number of bisection steps `fitChromaIntoSrgbGamut` takes. Twenty halvings
 * of a 0.4-wide chroma interval settle below 4e-7, which is two orders of
 * magnitude finer than the three decimal places the emitted CSS carries — so the
 * fit is exact at the precision anything downstream can observe.
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

/**
 * WCAG 2.2 relative luminance of a displayed sRGB triple.
 *
 * The triple is what the display shows, not the unclamped linear one, because a
 * channel the display cannot show contributes the luminance of the channel it
 * shows instead.
 */
function srgbRelativeLuminance(displayed: SrgbColor): number {
  return (
    0.2126 * decodeSrgbChannel(displayed.red) +
    0.7152 * decodeSrgbChannel(displayed.green) +
    0.0722 * decodeSrgbChannel(displayed.blue)
  );
}

/**
 * WCAG 2.2 contrast ratio between two colors already in sRGB; 1 (identical) to 21
 * (black on white).
 *
 * The sRGB entry point exists because a CSS `filter` is defined over sRGB channels
 * and has no OKLCH form: measuring what a filtered control really shows means
 * measuring the triple the filter produced. Scaling both of a pair's channels does
 * NOT preserve their ratio — relative luminance carries a 0.05 offset that a
 * multiplication does not distribute over — so a filtered treatment is only
 * checkable this way.
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
 * The CSS `oklch()` function text for a color, at three decimal places for
 * lightness and chroma and one for hue. The rounding is applied before the
 * value is ever measured, so the number the contrast test reads and the number
 * the browser paints are the same number.
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

/** Decimal places `formatOklch` emits for chroma. The gamut floor rounds to this. */
const CHROMA_EMITTED_DECIMALS = 4;

/**
 * The value a token actually carries: rounded to the precision the CSS emits AND
 * inside sRGB at that precision.
 *
 * The order matters, and the obvious order is wrong. Fitting first and rounding
 * second rounds the fitted chroma to the NEAREST emitted step, which is upward
 * half the time — back across the boundary the fit just found, by up to half a
 * step, which is fifty times the gamut epsilon. So: lightness and hue are rounded
 * first (the fit moves neither), the fit runs against those final values, and the
 * fitted chroma is rounded DOWN. Reducing chroma at fixed lightness and hue only
 * moves further inside the gamut, so the emitted value is inside by construction
 * rather than by luck.
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
