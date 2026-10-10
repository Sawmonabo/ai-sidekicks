// Parsing a settled block, a block against the body's definitions, and mending the volatile tail.

import { describe, expect, it } from "vitest";

import {
  footnoteDefinitionPreamble,
  holdSettledBlock,
  mendVolatileTail,
  parseSettledBlock,
} from "./parse.js";

describe("parsing a settled block", () => {
  it("two different blocks are two different trees", () => {
    // A cache keyed on something constant would hand one block's tree to another.
    expect(parseSettledBlock("first\n")).not.toBe(parseSettledBlock("second\n"));
  });
});

describe("holding a settled block's parse", () => {
  it("keeps the tree for each holder until that holder lets go, however often it lets go", () => {
    const first = holdSettledBlock("held block\n");
    const second = holdSettledBlock("held block\n");
    expect(second.root).toBe(first.root);
    // One holder letting go twice must not let go of the other's hold.
    first.release();
    first.release();
    fillCache("first");
    expect(parseSettledBlock("held block\n")).toBe(second.root);
    second.release();
    fillCache("second");
    expect(parseSettledBlock("held block\n")).not.toBe(second.root);
  });
});

/** Parses blocks past the cache's whole cap, each within it, evicting every tree no one holds. */
function fillCache(tag: string): void {
  for (let block = 0; block < FILLING_BLOCK_COUNT; block += 1) {
    const rows = Array.from(
      { length: FILLING_TABLE_ROWS },
      (_, index) => `| ${tag} ${String(block)} ${String(index)} | **bold** | \`code\` | text |`,
    );
    parseSettledBlock(["| a | b | c | d |", "| - | - | - | - |", ...rows].join("\n"));
  }
}

/** Tables of about a quarter of the cache each, and enough of them to pass it. */
const FILLING_TABLE_ROWS = 100;
const FILLING_BLOCK_COUNT = 6;

describe("parsing a block against the whole body's definitions", () => {
  it("drops the synthetic definitions and keeps the author's own", () => {
    // Both carry the identifier `1`, so identity cannot tell them apart; the offset rule does.
    const parsed = parseSettledBlock(
      "[^1]: the note body\n",
      footnoteDefinitionPreamble(new Set(["1"])),
    );
    expect(parsed.children).toHaveLength(1);
    expect(JSON.stringify(parsed.children)).toContain("the note body");
  });

  it("keeps an indented code block out of the preamble's last definition", () => {
    // A footnote definition takes indented lines after a blank one as its body, so a preamble
    // ending in a blank line would swallow this block.
    const parsed = parseSettledBlock(
      "    command --flag\n",
      footnoteDefinitionPreamble(new Set(["1"])),
    );
    expect(parsed.children[0]?.type).toBe("code");
  });
});

describe("mending the volatile tail", () => {
  it("leaves a lone dollar sign unclosed", () => {
    // "it cost $5" is prose, not the start of a formula, so no closing `$` is written after it.
    expect(mendVolatileTail("it cost $5 and then")).toBe("it cost $5 and then");
  });
});
