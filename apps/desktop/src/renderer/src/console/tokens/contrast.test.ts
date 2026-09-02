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
import { contrastRatio, isOklchInsideSrgbGamut } from "./color.js";
import { PARTICIPANT_HUE_STEPS } from "./palette.js";
import {
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
