// A block's estimated height from the line lengths its records hold: prose by the lines it wraps
// to, a fence by its source lines, a line longer than 16 bits can count, and an empty block.

import { expect, it } from "vitest";

import { BlockFlag, BlockRecords } from "../block-records.js";
import {
  estimateBlockHeightPx,
  FENCE_OPENER,
  lineLengthsOf,
  type BlockTypography,
} from "./estimate.js";

/**
 * 16 px type on 24 px lines in a 400 px body: a 0.5 em advance of 8 px fits 50 characters to a
 * line, narrower than the 68ch measure.
 */
const TYPOGRAPHY: BlockTypography = { fontSizePx: 16, lineHeightPx: 24, widthPx: 400 };

it.each([
  // 120 characters wrap to 3 lines and 30 to 1, with half a line below: 4.5 lines of 24 px.
  { kind: "prose", text: `${"x".repeat(120)}\n${"y".repeat(30)}\n\n`, heightPx: 108 },
  // 4 source lines and the 2 lines of the code block's frame: 6 lines.
  { kind: "a fence", text: "```ts\nconst a = 1;\nconst b = 2;\n```\n", heightPx: 144 },
  // 70,000 characters wrap to 1,400 lines; a 16-bit length would hold 4,464 and wrap to 90.
  { kind: "a line over 65,535 characters", text: "z".repeat(70_000), heightPx: 33_612 },
  // One empty line, and half a line below it.
  { kind: "an empty block", text: "", heightPx: 36 },
])("estimates $kind from its recorded line lengths", ({ text, heightPx }) => {
  const records = new BlockRecords();
  records.append(0, 1, "before");
  records.append(1, 1 + text.length, text);

  expect(
    estimateBlockHeightPx(
      records.lineLengthsOf(1),
      records.hasFlag(1, BlockFlag.Fence),
      TYPOGRAPHY,
    ),
  ).toBe(heightPx);
  // A streaming tail's text, measured where it stands, estimates the same.
  expect(estimateBlockHeightPx(lineLengthsOf(text), FENCE_OPENER.test(text), TYPOGRAPHY)).toBe(
    heightPx,
  );
});
