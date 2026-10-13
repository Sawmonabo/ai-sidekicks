// The memory answers a block whose text's hash it holds nothing for without spelling out its key,
// so it must never forget a hash while a geometry for that text is still kept.

import { describe, expect, it } from "vitest";

import { type MarkdownBodyType } from "../body-type.js";
import { recallBlockGeometry, rememberBlockGeometry } from "./geometry-memory.js";

const NARROW: MarkdownBodyType = { widthPx: 400, fontSizePx: 13, lineHeightPx: 19.5 };
const WIDE: MarkdownBodyType = { widthPx: 800, fontSizePx: 13, lineHeightPx: 19.5 };

/** More blocks than the memory holds, so the oldest of them give way. */
const FLOOD_BLOCK_COUNT = 4_000;

describe("block geometry remembered by text", () => {
  it("still recalls a text measured at one width after its geometry at another is evicted", () => {
    const block = { textLength: 120, textHash: 0x5e_ed_00_01, isFinal: false };
    rememberBlockGeometry(
      { ...block, bodyType: NARROW },
      { heightPx: 60, topMarginPx: 0, bottomMarginPx: 8 },
    );
    rememberBlockGeometry(
      { ...block, bodyType: WIDE },
      { heightPx: 40, topMarginPx: 0, bottomMarginPx: 8 },
    );
    // Filed again under the same address, the wide one replaces itself.
    rememberBlockGeometry(
      { ...block, bodyType: WIDE },
      { heightPx: 42, topMarginPx: 0, bottomMarginPx: 8 },
    );

    for (let index = 0; index < FLOOD_BLOCK_COUNT; index += 1) {
      rememberBlockGeometry(
        { textLength: 10, textHash: index, bodyType: NARROW, isFinal: false },
        { heightPx: 20, topMarginPx: 0, bottomMarginPx: 8 },
      );
      // Recalled often, the wide one stays among the most recently used.
      if (index % 100 === 0) {
        expect(recallBlockGeometry({ ...block, bodyType: WIDE })?.heightPx).toBe(42);
      }
    }

    expect(recallBlockGeometry({ ...block, bodyType: NARROW })).toBeUndefined();
    expect(recallBlockGeometry({ ...block, bodyType: WIDE })?.heightPx).toBe(42);
  });
});
