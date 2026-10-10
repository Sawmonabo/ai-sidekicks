// Parsing a settled block, a block against the body's definitions, and mending the volatile tail.

import { describe, expect, it } from "vitest";

import { footnoteDefinitionPreamble, mendVolatileTail, parseSettledBlock } from "./parse.js";

describe("parsing a settled block", () => {
  it("two different blocks are two different trees", () => {
    // A cache keyed on something constant would hand one block's tree to another.
    expect(parseSettledBlock("first\n")).not.toBe(parseSettledBlock("second\n"));
  });
});

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
