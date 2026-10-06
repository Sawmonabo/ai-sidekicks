// A glyph keeps its drawn size at every text size, as the Text size setting promises: text and the
// space around it grow, icons stay put. Measured in Chromium, since happy-dom has no layout; the
// text beside it is the negative control, growing with the same step.

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";

afterEach(() => {
  cleanup();
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
});

it("draws a glyph at its own size in pixels at the largest text size", () => {
  installMeridianTokens(document);
  applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, textSize: 20 });
  const { container } = render(
    <p>
      <Glyph name="sessions" size={GLYPH_SIZE_CHROME} />
      <span style={{ display: "inline-block", width: "1rem" }}>text</span>
    </p>,
  );

  const glyph = container.querySelector("svg")!.getBoundingClientRect();
  const remBox = container.querySelector("span")!.getBoundingClientRect();
  expect(remBox.width).toBe(20);
  expect(glyph.width).toBe(GLYPH_SIZE_CHROME);
  expect(glyph.height).toBe(GLYPH_SIZE_CHROME);
});
