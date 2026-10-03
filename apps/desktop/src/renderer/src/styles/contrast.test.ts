// Contrast, measured rather than restated: each pair is computed from the resolved token records
// the stylesheet is emitted from, so a token edit that drops a pair below its floor fails here,
// and the case's name gives the rendering and the pair while the failure prints the ratio.
//
// Two floors: 4.5:1 for text, including words painted on the accent, and 3:1 for the accent, the
// other control boundaries and marks, and every agent hue against the grounds they sit on.

import { describe, expect, it } from "vitest";
import { contrastRatio } from "./color.js";
import {
  ACCENT_FILL_PAIRS,
  COLOR_SCHEMES,
  GROUND_TOKEN_NAMES,
  NON_TEXT_CONTRAST_FLOOR,
  NON_TEXT_FLOOR_TOKEN_NAMES,
  HUE_WHEEL,
  SUNKEN_WELL_GROUND_TOKEN_NAME,
  SUNKEN_WELL_TEXT_TOKEN_NAMES,
  TEXT_CONTRAST_FLOOR,
  TEXT_FLOOR_TOKEN_NAMES,
  TINTED_GROUND_PAIRS,
  schemeColor,
  type ColorScheme,
} from "./tokens.js";

/** The ratio of one pair in one rendering. */
function measuredRatio(foregroundToken: string, groundToken: string, scheme: ColorScheme): number {
  return contrastRatio(schemeColor(foregroundToken, scheme), schemeColor(groundToken, scheme));
}

/** Every text pair: text on the neutral grounds, on the tinted grounds, and on the code well. */
const TEXT_PAIRS: readonly (readonly [string, string])[] = [
  ...TEXT_FLOOR_TOKEN_NAMES.flatMap((textToken) =>
    GROUND_TOKEN_NAMES.map((groundToken) => [textToken, groundToken] as const),
  ),
  ...TINTED_GROUND_PAIRS,
  ...SUNKEN_WELL_TEXT_TOKEN_NAMES.map(
    (textToken) => [textToken, SUNKEN_WELL_GROUND_TOKEN_NAME] as const,
  ),
];

/** Every mark pair: the accent and the other control boundaries on the neutral grounds. */
const MARK_PAIRS: readonly (readonly [string, string])[] = NON_TEXT_FLOOR_TOKEN_NAMES.flatMap(
  (markToken) => GROUND_TOKEN_NAMES.map((groundToken) => [markToken, groundToken] as const),
);

describe.each(COLOR_SCHEMES)("Meridian %s rendering", (scheme) => {
  it.each(TEXT_PAIRS)("text %s on %s reaches 4.5:1", (textToken, groundToken) => {
    expect(measuredRatio(textToken, groundToken, scheme)).toBeGreaterThanOrEqual(
      TEXT_CONTRAST_FLOOR,
    );
  });

  it.each(MARK_PAIRS)("mark %s on %s reaches 3:1", (markToken, groundToken) => {
    expect(measuredRatio(markToken, groundToken, scheme)).toBeGreaterThanOrEqual(
      NON_TEXT_CONTRAST_FLOOR,
    );
  });

  it.each(ACCENT_FILL_PAIRS)("words %s on the accent %s reach 4.5:1", (inkToken, fillToken) => {
    expect(measuredRatio(inkToken, fillToken, scheme)).toBeGreaterThanOrEqual(TEXT_CONTRAST_FLOOR);
  });

  it.each(GROUND_TOKEN_NAMES)("every agent hue on %s reaches 3:1", (groundToken) => {
    const ground = schemeColor(groundToken, scheme);
    const failures = HUE_WHEEL.flatMap((hue, step) => {
      const ratio = contrastRatio(hue, ground);
      return ratio < NON_TEXT_CONTRAST_FLOOR ? [`step ${String(step)} at ${String(ratio)}:1`] : [];
    });
    expect(failures).toStrictEqual([]);
  });
});

describe("the contrast measurement", () => {
  it("reads 21:1 for black on white and near 1:1 for two close grays", () => {
    // A measurement that answered a large constant would pass every floor above.
    const black = { lightness: 0, chroma: 0, hueDegrees: 0 };
    const white = { lightness: 1, chroma: 0, hueDegrees: 0 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(
      contrastRatio(
        { lightness: 0.5, chroma: 0.02, hueDegrees: 200 },
        { lightness: 0.52, chroma: 0.02, hueDegrees: 200 },
      ),
    ).toBeLessThan(1.2);
  });
});
