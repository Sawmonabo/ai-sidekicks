// Contrast, measured rather than asserted: every pair the rules name is computed from the sRGB
// the browser paints. That is why `color.ts` fits each color into gamut at authoring time; a
// color the browser had to map would make the measured number differ from the one a person sees.
//
// Two floors: 4.5:1 for text (WCAG 1.4.3), and 3:1 for non-text control boundaries (WCAG
// 1.4.11). The palette names `edge` decorative and `edge-strong` a control boundary, and only
// the second is held to 3:1; holding a decorative rule to it would look like a spreadsheet.

import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  isOklchInsideSrgbGamut,
  oklchToSrgb,
  srgbContrastRatio,
  type SrgbColor,
} from "./color.js";
import { HUE_WHEEL_STEPS } from "./palette.js";
import {
  ACCENT_FILL_PAIRS,
  COLOR_SCHEMES,
  GROUND_TOKEN_NAMES,
  NON_TEXT_CONTRAST_FLOOR,
  NON_TEXT_FLOOR_TOKEN_NAMES,
  HUE_WHEEL,
  SCHEME_COLOR_TOKENS,
  SUNKEN_WELL_GROUND_TOKEN_NAME,
  SUNKEN_WELL_TEXT_TOKEN_NAMES,
  TEXT_CONTRAST_FLOOR,
  TEXT_FLOOR_TOKEN_NAMES,
  TINTED_GROUND_PAIRS,
  readHueWheelColor,
  schemeColor,
} from "./tokens.js";

describe("Meridian palette — every color is inside the sRGB gamut as authored", () => {
  it("fits every scheme color, so the browser maps nothing", () => {
    const outsideGamut: string[] = [];
    for (const scheme of COLOR_SCHEMES) {
      for (const [tokenName] of SCHEME_COLOR_TOKENS) {
        if (!isOklchInsideSrgbGamut(schemeColor(tokenName, scheme))) {
          outsideGamut.push(`${scheme}/${tokenName}`);
        }
      }
    }
    // A color outside the gamut is painted as something else, so every ratio below would
    // measure a value the screen never shows.
    expect(outsideGamut).toStrictEqual([]);
  });

  it("fits every user hue", () => {
    const outsideGamut = HUE_WHEEL.map((hue, step) => ({ step, hue }))
      .filter(({ hue }) => !isOklchInsideSrgbGamut(hue))
      .map(({ step }) => step);
    expect(outsideGamut).toStrictEqual([]);
  });
});

describe("Meridian palette — text clears WCAG 2.2 AA (4.5:1) on every ground", () => {
  for (const scheme of COLOR_SCHEMES) {
    for (const groundToken of GROUND_TOKEN_NAMES) {
      for (const textToken of TEXT_FLOOR_TOKEN_NAMES) {
        it(`${scheme}: ${textToken} on ${groundToken}`, () => {
          const ratio = contrastRatio(
            schemeColor(textToken, scheme),
            schemeColor(groundToken, scheme),
          );
          expect(ratio).toBeGreaterThanOrEqual(TEXT_CONTRAST_FLOOR);
        });
      }
    }
  }
});

describe("Meridian palette — tinted grounds hold the text floor for their own text", () => {
  for (const scheme of COLOR_SCHEMES) {
    for (const [textToken, groundToken] of TINTED_GROUND_PAIRS) {
      it(`${scheme}: ${textToken} on ${groundToken}`, () => {
        // The amber and red grounds are the only tinted grounds, and they carry the hues for
        // "a person is needed" and "this failed", where unreadable text costs the most.
        const ratio = contrastRatio(
          schemeColor(textToken, scheme),
          schemeColor(groundToken, scheme),
        );
        expect(ratio).toBeGreaterThanOrEqual(TEXT_CONTRAST_FLOOR);
      });
    }
  }
});

describe("Meridian palette — a filled accent control holds the text floor for its label", () => {
  for (const scheme of COLOR_SCHEMES) {
    for (const [inkToken, fillToken] of ACCENT_FILL_PAIRS) {
      it(`${scheme}: ${inkToken} on ${fillToken}`, () => {
        // A primary action's whole face is the accent, so its label is text on that fill. A
        // saturated mid-lightness field is where an eyeballed choice is most likely to be wrong.
        const ratio = contrastRatio(schemeColor(inkToken, scheme), schemeColor(fillToken, scheme));
        expect(ratio).toBeGreaterThanOrEqual(TEXT_CONTRAST_FLOOR);
      });
    }
  }

  it("negative control: the accent's own text token fails on the accent fill", () => {
    // The pair the console would otherwise reach for, and the reason `accent-ink` exists;
    // without this case `ACCENT_FILL_PAIRS` would pass any ink at all.
    for (const scheme of COLOR_SCHEMES) {
      const ratio = contrastRatio(
        schemeColor("accent-text", scheme),
        schemeColor("accent", scheme),
      );
      expect(ratio).toBeLessThan(TEXT_CONTRAST_FLOOR);
    }
  });

  it("negative control: darkening the whole control with a filter drops it below", () => {
    // A `filter` scales foreground and background together, and scaling does not preserve a
    // ratio because relative luminance carries a 0.05 offset. On the light scheme the resting
    // pair clears the floor by about 5%, and a 6% channel darkening costs about 10% of its ratio.
    // Without this case the pressed pair above would not show why the filter was replaced.
    const filtered = srgbContrastRatio(
      oklchToSrgb(schemeColor("accent-ink", "light")),
      scaleBrightness(oklchToSrgb(schemeColor("accent", "light")), PRESS_FILTER_BRIGHTNESS),
    );
    expect(filtered).toBeLessThan(TEXT_CONTRAST_FLOOR);
    // And the token that replaced it clears the floor at the same press.
    expect(
      contrastRatio(schemeColor("accent-ink", "light"), schemeColor("accent-pressed", "light")),
    ).toBeGreaterThanOrEqual(TEXT_CONTRAST_FLOOR);
  });

  it("keeps the hover lift, which raises the ratio rather than spending it", () => {
    // Hover is still a filter, and safe because the ink is dark in both schemes, so brightening
    // the fill moves the pair apart. Asserted because it is the mechanism the case above rejects,
    // in the other direction.
    for (const scheme of COLOR_SCHEMES) {
      const ink = oklchToSrgb(schemeColor("accent-ink", scheme));
      const resting = oklchToSrgb(schemeColor("accent", scheme));
      const hovered = scaleBrightness(resting, HOVER_FILTER_BRIGHTNESS);
      expect(srgbContrastRatio(ink, hovered)).toBeGreaterThan(srgbContrastRatio(ink, resting));
      expect(srgbContrastRatio(ink, hovered)).toBeGreaterThanOrEqual(TEXT_CONTRAST_FLOOR);
    }
  });
});

describe("Meridian palette — non-text boundaries clear WCAG 2.2 AA (3:1)", () => {
  for (const scheme of COLOR_SCHEMES) {
    for (const groundToken of GROUND_TOKEN_NAMES) {
      for (const markToken of NON_TEXT_FLOOR_TOKEN_NAMES) {
        it(`${scheme}: ${markToken} on ${groundToken}`, () => {
          const ratio = contrastRatio(
            schemeColor(markToken, scheme),
            schemeColor(groundToken, scheme),
          );
          expect(ratio).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_FLOOR);
        });
      }
    }
  }
});

describe("Meridian palette — every user hue is findable on every ground", () => {
  for (const scheme of COLOR_SCHEMES) {
    for (const groundToken of GROUND_TOKEN_NAMES) {
      it(`${scheme}: all ${String(HUE_WHEEL_STEPS)} hues on ${groundToken}`, () => {
        // The attribution edge is a non-text boundary, so the whole wheel is held to 3:1; its
        // worst steps (5 in light, 11 in dark) set the wheel's lightness.
        const ground = schemeColor(groundToken, scheme);
        const failures: string[] = [];
        for (let step = 0; step < HUE_WHEEL_STEPS; step += 1) {
          const ratio = contrastRatio(readHueWheelColor(step), ground);
          if (ratio < NON_TEXT_CONTRAST_FLOOR) {
            failures.push(`step ${String(step)} at ${ratio.toFixed(2)}:1`);
          }
        }
        expect(failures).toStrictEqual([]);
      });
    }
  }
});

describe("Meridian palette — a code or command-output body clears the text floor on its own well", () => {
  // The code-token and ANSI vocabularies are read text, so they carry the 1.4.3 floor. They are
  // measured on `surface-sunken` alone, the only ground they are painted on. Values kept as
  // literals in a stylesheet would be fitted into no gamut and held to no floor.
  for (const scheme of COLOR_SCHEMES) {
    for (const tokenName of SUNKEN_WELL_TEXT_TOKEN_NAMES) {
      it(`${scheme}: ${tokenName} on ${SUNKEN_WELL_GROUND_TOKEN_NAME}`, () => {
        const ratio = contrastRatio(
          schemeColor(tokenName, scheme),
          schemeColor(SUNKEN_WELL_GROUND_TOKEN_NAME, scheme),
        );
        expect(ratio).toBeGreaterThanOrEqual(TEXT_CONTRAST_FLOOR);
      });
    }
  }

  it("negative control: the census is populated, and the same measurement rejects a foreground the well cannot hold", () => {
    // An emptied census would make every case above vacuous.
    expect(SUNKEN_WELL_TEXT_TOKEN_NAMES.length).toBeGreaterThan(0);
    // The same measurement over `edge`, the decorative hairline with no floor, must fail.
    for (const scheme of COLOR_SCHEMES) {
      const ratio = contrastRatio(
        schemeColor("edge", scheme),
        schemeColor(SUNKEN_WELL_GROUND_TOKEN_NAME, scheme),
      );
      expect(ratio).toBeLessThan(TEXT_CONTRAST_FLOOR);
    }
  });

  it("keeps every bright ANSI name distinguishable from the normal one it pairs with", () => {
    // The light scheme's bright values are the deepest the floor admits and could collapse pairs
    // into one color. Asserted over resolved values, since chroma fitting could close the last of
    // the gap.
    for (const scheme of COLOR_SCHEMES) {
      const collapsed = SUNKEN_WELL_TEXT_TOKEN_NAMES.filter((tokenName) =>
        tokenName.startsWith("ansi-bright-"),
      ).filter((brightName) => {
        const bright = schemeColor(brightName, scheme);
        const normal = schemeColor(brightName.replace("ansi-bright-", "ansi-"), scheme);
        return bright.lightness === normal.lightness && bright.chroma === normal.chroma;
      });
      expect(collapsed).toStrictEqual([]);
    }
  });
});

/**
 * The `brightness()` amount `features/composer/accent-fill.css` spends on hover. Transcribed
 * rather than imported, because a filter amount is a paint instruction with no token; keep it
 * equal to that sheet's value.
 */
const HOVER_FILTER_BRIGHTNESS = 1.06;

/** The amount the retired press filter spent; the negative control measures its effect. */
const PRESS_FILTER_BRIGHTNESS = 0.94;

/**
 * A CSS `brightness()` over a displayed triple. Filter shorthands use
 * `color-interpolation-filters: sRGB`, so the amount multiplies the gamma-encoded channels,
 * clamped into the display range.
 */
function scaleBrightness(color: SrgbColor, amount: number): SrgbColor {
  const scale = (channel: number): number => Math.min(1, Math.max(0, channel * amount));
  return { red: scale(color.red), green: scale(color.green), blue: scale(color.blue) };
}

describe("Meridian palette — the measurement itself is not vacuous", () => {
  it("reports a low ratio for a pair that genuinely fails", () => {
    // Negative control: a `contrastRatio` that returned a large constant would pass every
    // assertion above.
    const nearlyIdentical = contrastRatio(
      { lightness: 0.5, chroma: 0.02, hueDegrees: 200 },
      { lightness: 0.52, chroma: 0.02, hueDegrees: 200 },
    );
    expect(nearlyIdentical).toBeLessThan(1.2);
  });

  it("reports 21:1 for black on white, the definitional maximum", () => {
    const maximum = contrastRatio(
      { lightness: 0, chroma: 0, hueDegrees: 0 },
      { lightness: 1, chroma: 0, hueDegrees: 0 },
    );
    expect(maximum).toBeCloseTo(21, 1);
  });

  it("refuses a step outside the wheel rather than wrapping silently", () => {
    expect(() => readHueWheelColor(HUE_WHEEL_STEPS)).toThrow(RangeError);
    expect(() => readHueWheelColor(-1)).toThrow(RangeError);
  });
});
