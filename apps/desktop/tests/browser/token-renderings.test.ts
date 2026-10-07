// The four renderings, two themes by light and dark, read off the running page rather than off the
// palette's records: the token sheet is installed and the root stamped as main's appearance record
// stamps it, and every color is read from what Chromium paints. A token that resolves to another
// rendering's value, or a pair that falls below its floor, fails naming the rendering.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { GLASS_OPACITY_PERCENT } from "#renderer/styles/palette.js";
import {
  ACCENT_FILL_PAIRS,
  GROUND_TOKEN_NAMES,
  HUE_WHEEL,
  NON_TEXT_CONTRAST_FLOOR,
  NON_TEXT_FLOOR_TOKEN_NAMES,
  SUNKEN_WELL_GROUND_TOKEN_NAME,
  SUNKEN_WELL_TEXT_TOKEN_NAMES,
  TEXT_CONTRAST_FLOOR,
  TEXT_FLOOR_TOKEN_NAMES,
  THEMED_COLOR_TOKENS,
  TINTED_GROUND_PAIRS,
  formatHueWheelTokenName,
  tokenReference,
} from "#renderer/styles/tokens.js";
import {
  APPEARANCE_THEMES,
  COLOR_SCHEMES,
  DEFAULT_APPEARANCE_RECORD,
  SYSTEM_SCHEME_PREFERENCE,
  type AppearanceTheme,
  type ColorScheme,
} from "#shared/appearance.js";
import { contrastRatio, formatOklch, type SrgbColor } from "#shared/color.js";
import { tokenVariableName } from "#shared/token-variable.js";
import { clearMediaEmulation, emulateSystemScheme } from "#test/helpers/media-emulation.js";

/** One of the four renderings. */
interface Rendering {
  readonly theme: AppearanceTheme;
  readonly scheme: ColorScheme;
}

/** A foreground token, the ground it sits on, and the floor the pair must reach. */
interface FloorPair {
  readonly foreground: string;
  readonly ground: string;
  readonly floor: number;
}

const RENDERINGS: readonly Rendering[] = APPEARANCE_THEMES.flatMap((theme) =>
  COLOR_SCHEMES.map((scheme) => ({ theme, scheme })),
);

const OPPOSITE_SCHEME: Readonly<Record<ColorScheme, ColorScheme>> = {
  light: "dark",
  dark: "light",
};

/** Every pair a floor holds: text and marks on the grounds they sit on, ink on the accent. */
const FLOOR_PAIRS: readonly FloorPair[] = [
  ...TEXT_FLOOR_TOKEN_NAMES.flatMap((foreground) =>
    GROUND_TOKEN_NAMES.map((ground) => ({ foreground, ground, floor: TEXT_CONTRAST_FLOOR })),
  ),
  ...[...TINTED_GROUND_PAIRS, ...ACCENT_FILL_PAIRS].map(([foreground, ground]) => ({
    foreground,
    ground,
    floor: TEXT_CONTRAST_FLOOR,
  })),
  ...SUNKEN_WELL_TEXT_TOKEN_NAMES.map((foreground) => ({
    foreground,
    ground: SUNKEN_WELL_GROUND_TOKEN_NAME,
    floor: TEXT_CONTRAST_FLOOR,
  })),
  ...[
    ...NON_TEXT_FLOOR_TOKEN_NAMES,
    ...HUE_WHEEL.map((_hue, step) => formatHueWheelTokenName(step)),
  ].flatMap((foreground) =>
    GROUND_TOKEN_NAMES.map((ground) => ({ foreground, ground, floor: NON_TEXT_CONTRAST_FLOOR })),
  ),
];

function describeRendering(rendering: Rendering): string {
  return `${rendering.theme} ${rendering.scheme}`;
}

/** Stamps the root as main stamps it for a person who chose this theme and scheme. */
function applyRendering(rendering: Rendering): void {
  applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, ...rendering });
}

/** The color Chromium paints for a token now, read back from a pixel it drew. */
function readPaintedColor(tokenName: string): SrgbColor {
  const probe = document.createElement("span");
  probe.style.color = tokenReference(tokenName);
  document.body.append(probe);
  const computedColor = getComputedStyle(probe).color;
  probe.remove();
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    throw new Error("Chromium gave no 2D canvas context to read a painted color from.");
  }
  context.fillStyle = computedColor;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
  if (alpha !== 255) {
    throw new Error(`${tokenName} paints ${computedColor}, which is not opaque.`);
  }
  return { red: red / 255, green: green / 255, blue: blue / 255 };
}

/** Each pair below its floor in the rendering on the page now, with the ratio it measured. */
function measureFloorMisses(rendering: Rendering): string[] {
  const paintedByToken = new Map<string, SrgbColor>();
  const painted = (tokenName: string): SrgbColor => {
    const known = paintedByToken.get(tokenName);
    if (known !== undefined) {
      return known;
    }
    const color = readPaintedColor(tokenName);
    paintedByToken.set(tokenName, color);
    return color;
  };
  return FLOOR_PAIRS.flatMap(({ foreground, ground, floor }) => {
    const ratio = contrastRatio(painted(foreground), painted(ground));
    return ratio < floor
      ? [
          `${describeRendering(rendering)}: ${foreground} on ${ground} ${ratio.toFixed(2)}:1 < ${floor}:1`,
        ]
      : [];
  });
}

/** Each color token whose value on the root is not its own for this rendering. */
function findForeignValues(rendering: Rendering): string[] {
  const rootStyle = getComputedStyle(document.documentElement);
  const declared = (tokenName: string): string =>
    rootStyle.getPropertyValue(tokenVariableName(tokenName)).trim();
  const expected: (readonly [string, string])[] = [
    ...THEMED_COLOR_TOKENS.map(
      ([tokenName, color]) =>
        [tokenName, formatOklch(color[rendering.theme][rendering.scheme])] as const,
    ),
    ["glass", `${String(GLASS_OPACITY_PERCENT[rendering.theme][rendering.scheme])}%`],
  ];
  return expected.flatMap(([tokenName, value]) =>
    declared(tokenName) === value
      ? []
      : [`${describeRendering(rendering)}: ${tokenName} is ${declared(tokenName)}, not ${value}`],
  );
}

beforeEach(() => {
  installMeridianTokens(document);
});

afterEach(async () => {
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
  await clearMediaEmulation();
});

describe.each(RENDERINGS)("the $theme $scheme rendering", (rendering) => {
  it("resolves every color token to its own value, chosen or following the system", async () => {
    // Chosen against an operating system set the other way, so the choice must win over it.
    await emulateSystemScheme(OPPOSITE_SCHEME[rendering.scheme]);
    applyRendering(rendering);
    expect(findForeignValues(rendering)).toStrictEqual([]);

    await emulateSystemScheme(rendering.scheme);
    applyAppearance(document, {
      ...DEFAULT_APPEARANCE_RECORD,
      theme: rendering.theme,
      scheme: SYSTEM_SCHEME_PREFERENCE,
    });
    expect(findForeignValues(rendering)).toStrictEqual([]);
  });

  it("holds every pair to its floor", () => {
    applyRendering(rendering);
    expect(measureFloorMisses(rendering)).toStrictEqual([]);
  });
});

describe("the contrast check", () => {
  it("names the rendering, the pair and the ratio when a pair drops below its floor", () => {
    const rendering: Rendering = { theme: "graphite", scheme: "dark" };
    applyRendering(rendering);
    const root = document.documentElement;
    root.style.setProperty(tokenVariableName("text-faint"), tokenReference("surface-raised"));
    try {
      const misses = measureFloorMisses(rendering);
      expect(misses).toContainEqual(
        expect.stringMatching(/^graphite dark: text-faint on surface-sunken \d+\.\d\d:1 < 4\.5:1$/),
      );
    } finally {
      root.style.removeProperty(tokenVariableName("text-faint"));
    }
  });
});

describe("the value check", () => {
  it("names each token whose value belongs to another rendering", () => {
    applyRendering({ theme: "graphite", scheme: "dark" });
    expect(findForeignValues({ theme: "meridian", scheme: "light" })).toContainEqual(
      expect.stringMatching(/^meridian light: ground is oklch\(.+\), not oklch\(.+\)$/),
    );
  });
});
