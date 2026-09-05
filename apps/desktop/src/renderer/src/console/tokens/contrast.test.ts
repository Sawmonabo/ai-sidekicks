// Contrast, measured rather than asserted.
//
// `Spec-023 §Console Design (Meridian)` rule 3 puts the console at WCAG 2.2 AA. A
// palette can claim that; only a computation can hold it. So this file walks every
// pair the rules name and computes the real ratio from the sRGB the browser will
// paint — which is why `tokens/color.ts` fits each colour into gamut at AUTHORING
// time. If the values were left out of gamut, the browser would map them and the
// number measured here would not be the number a person sees.
//
// Two floors, and the distinction is load-bearing:
//
//   • 4.5:1 for text, WCAG 1.4.3.
//   • 3:1 for non-text UI boundaries, WCAG 1.4.11 — which applies to a control
//     boundary a person must find, and NOT to a decorative hairline. The palette
//     names `edge` decorative and `edge-strong` a control boundary for exactly this
//     reason, and this file holds only the second to the floor. Holding a
//     decorative rule to 3:1 would produce a console that looks like a spreadsheet.

import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  isOklchInsideSrgbGamut,
  oklchToSrgb,
  srgbContrastRatio,
  type SrgbColor,
} from "./color.js";
import { PARTICIPANT_HUE_STEPS } from "./palette.js";
import {
  ACCENT_FILL_PAIRS,
  CONSOLE_SCHEMES,
  GROUND_TOKEN_NAMES,
  NON_TEXT_CONTRAST_FLOOR,
  NON_TEXT_FLOOR_TOKEN_NAMES,
  PARTICIPANT_HUES,
  SCHEME_COLOR_TOKENS,
  TEXT_CONTRAST_FLOOR,
  TEXT_FLOOR_TOKEN_NAMES,
  TINTED_GROUND_PAIRS,
  participantHue,
  schemeColor,
} from "./tokens.js";

describe("Meridian palette — every colour is inside the sRGB gamut as authored", () => {
  it("fits every scheme colour, so the browser maps nothing", () => {
    const outsideGamut: string[] = [];
    for (const scheme of CONSOLE_SCHEMES) {
      for (const tokenName of SCHEME_COLOR_TOKENS.keys()) {
        if (!isOklchInsideSrgbGamut(schemeColor(tokenName, scheme))) {
          outsideGamut.push(`${scheme}/${tokenName}`);
        }
      }
    }
    // A colour outside the gamut is painted as something else, so every ratio
    // measured below would be measuring a value the screen never shows.
    expect(outsideGamut).toStrictEqual([]);
  });

  it("fits every participant hue", () => {
    const outsideGamut = PARTICIPANT_HUES.map((hue, step) => ({ step, hue }))
      .filter(({ hue }) => !isOklchInsideSrgbGamut(hue))
      .map(({ step }) => step);
    expect(outsideGamut).toStrictEqual([]);
  });
});

describe("Meridian palette — text clears WCAG 2.2 AA (4.5:1) on every ground", () => {
  for (const scheme of CONSOLE_SCHEMES) {
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
  for (const scheme of CONSOLE_SCHEMES) {
    for (const [textToken, groundToken] of TINTED_GROUND_PAIRS) {
      it(`${scheme}: ${textToken} on ${groundToken}`, () => {
        // The amber and red grounds are the only tinted surfaces in the console,
        // and they carry the two hues that mean "a person is needed" and "this
        // failed". Text on them that fell below the floor would be unreadable
        // exactly where reading matters most.
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
  for (const scheme of CONSOLE_SCHEMES) {
    for (const [inkToken, fillToken] of ACCENT_FILL_PAIRS) {
      it(`${scheme}: ${inkToken} on ${fillToken}`, () => {
        // A primary action's whole face is the accent, so its label is text on
        // that fill and carries 1.4.3's floor like any other text. Measured rather
        // than asserted, for this file's reason: the pair is the one place in the
        // console where a foreground sits on a saturated mid-lightness field, which
        // is where an eyeballed choice is most likely to be wrong.
        const ratio = contrastRatio(schemeColor(inkToken, scheme), schemeColor(fillToken, scheme));
        expect(ratio).toBeGreaterThanOrEqual(TEXT_CONTRAST_FLOOR);
      });
    }
  }

  it("negative control: the accent's own text token fails on the accent fill", () => {
    // This is the pair the console would otherwise have reached for, and the
    // reason `accent-ink` exists at all. Without this case, `ACCENT_FILL_PAIRS`
    // would pass over any ink whatsoever — including the one that is wrong — and
    // the assertion above would prove only that some number was computed.
    for (const scheme of CONSOLE_SCHEMES) {
      const ratio = contrastRatio(
        schemeColor("accent-text", scheme),
        schemeColor("accent", scheme),
      );
      expect(ratio).toBeLessThan(TEXT_CONTRAST_FLOOR);
    }
  });

  it("negative control: darkening the whole control with a filter drops it below", () => {
    // The treatment the pressed token replaced. A `filter` scales foreground and
    // background together, and scaling does not preserve a contrast ratio: relative
    // luminance carries a 0.05 offset that a multiplication does not distribute
    // over. Measured on the LIGHT scheme, where the resting pair clears the floor by
    // about 5% and a 6% channel darkening costs it about 10% of its ratio, because
    // luminance follows the channel through the sRGB transfer function rather than
    // linearly.
    //
    // Without this case, the pressed pair above would prove only that some second
    // fill token exists — not that the state it replaced was unmeasurable in the
    // way that let this through.
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
    // The hover treatment IS still a filter, and this is why that is safe rather
    // than lucky: the ink is dark in both schemes, so brightening the fill moves
    // the pair apart. Asserted rather than assumed, because the claim is about the
    // same mechanism the case above rejects and the difference is only its
    // direction.
    for (const scheme of CONSOLE_SCHEMES) {
      const ink = oklchToSrgb(schemeColor("accent-ink", scheme));
      const resting = oklchToSrgb(schemeColor("accent", scheme));
      const hovered = scaleBrightness(resting, HOVER_FILTER_BRIGHTNESS);
      expect(srgbContrastRatio(ink, hovered)).toBeGreaterThan(srgbContrastRatio(ink, resting));
      expect(srgbContrastRatio(ink, hovered)).toBeGreaterThanOrEqual(TEXT_CONTRAST_FLOOR);
    }
  });
});

describe("Meridian palette — non-text boundaries clear WCAG 2.2 AA (3:1)", () => {
  for (const scheme of CONSOLE_SCHEMES) {
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

describe("Meridian palette — every participant hue is findable on every ground", () => {
  for (const scheme of CONSOLE_SCHEMES) {
    for (const groundToken of GROUND_TOKEN_NAMES) {
      it(`${scheme}: all ${String(PARTICIPANT_HUE_STEPS)} hues on ${groundToken}`, () => {
        // The attribution edge is a non-text boundary a person must be able to
        // find, so the whole wheel is held to 3:1 — including the yellow-greens
        // around step 4, which is the constraint that sets the wheel's lightness.
        const ground = schemeColor(groundToken, scheme);
        const failures: string[] = [];
        for (let step = 0; step < PARTICIPANT_HUE_STEPS; step += 1) {
          const ratio = contrastRatio(participantHue(step), ground);
          if (ratio < NON_TEXT_CONTRAST_FLOOR) {
            failures.push(`step ${String(step)} at ${ratio.toFixed(2)}:1`);
          }
        }
        expect(failures).toStrictEqual([]);
      });
    }
  }
});

/**
 * The `brightness()` amount `accent-fill.css` still spends on hover.
 *
 * Transcribed from that rule rather than imported: a filter amount is a paint
 * instruction with no token, and the two cases that read it are the only things in
 * the console that need to know it. Both fail loudly if the sheet's value moves
 * away from this one — the hover case by measuring a ratio that no longer matches
 * what the sheet paints.
 */
const HOVER_FILTER_BRIGHTNESS = 1.06;

/** The amount the pressed state used to spend, before it became a measured token. */
const PRESS_FILTER_BRIGHTNESS = 0.94;

/**
 * A CSS `brightness()` over a displayed triple.
 *
 * The CSS filter shorthands are defined with `color-interpolation-filters: sRGB`,
 * so the amount multiplies the gamma-encoded channels and the result is clamped
 * into the display range — which is why this models the browser rather than
 * approximating it.
 */
function scaleBrightness(color: SrgbColor, amount: number): SrgbColor {
  const scale = (channel: number): number => Math.min(1, Math.max(0, channel * amount));
  return { red: scale(color.red), green: scale(color.green), blue: scale(color.blue) };
}

describe("Meridian palette — the measurement itself is not vacuous", () => {
  it("reports a low ratio for a pair that genuinely fails", () => {
    // Negative control. Without it, a bug in `contrastRatio` that returned a large
    // constant would make every assertion above pass while proving nothing.
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
    expect(() => participantHue(PARTICIPANT_HUE_STEPS)).toThrow(RangeError);
    expect(() => participantHue(-1)).toThrow(RangeError);
  });
});
