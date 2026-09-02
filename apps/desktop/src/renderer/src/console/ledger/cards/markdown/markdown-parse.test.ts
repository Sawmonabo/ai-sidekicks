// One parse per settled block, and `remend` on the tail alone.

import { describe, expect, it } from "vitest";

import type { MarkdownBlockNode } from "./markdown-parse.js";
import { parseSettledBlock, parseVolatileTail, settledBlockCacheStats } from "./markdown-parse.js";

describe("parsing a settled block", () => {
  it("produces an mdast document", () => {
    const root = parseSettledBlock("A paragraph.\n");
    const first: MarkdownBlockNode | undefined = root.children[0];
    expect(first?.type).toBe("paragraph");
  });

  it("parses GFM: tables, strikethrough, task lists, and footnotes", () => {
    const table = parseSettledBlock("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(table.children[0]?.type).toBe("table");

    const struck = parseSettledBlock("~~gone~~\n");
    expect(JSON.stringify(struck)).toContain("delete");

    const tasks = parseSettledBlock("- [x] done\n");
    expect(JSON.stringify(tasks)).toContain('"checked":true');

    const footnote = parseSettledBlock("[^1]: the note\n");
    expect(footnote.children[0]?.type).toBe("footnoteDefinition");
  });

  it("returns the SAME tree for the same text, so a re-render re-parses nothing", () => {
    const source = `unique to this case ${String(Math.random())}\n`;
    expect(parseSettledBlock(source)).toBe(parseSettledBlock(source));
  });

  it("negative control: two different blocks are two different trees", () => {
    // Without this, a cache keyed on something constant would pass the case above.
    expect(parseSettledBlock("first\n")).not.toBe(parseSettledBlock("second\n"));
  });

  it("holds its cache inside a stated bound", () => {
    const stats = settledBlockCacheStats();
    expect(stats.byteCap).toBeGreaterThan(0);
    expect(stats.retainedByteCount).toBeLessThanOrEqual(stats.byteCap);
  });
});

describe("parsing the volatile tail", () => {
  it("closes an unterminated fence rather than rendering the rest as prose", () => {
    const root = parseVolatileTail("```ts\nconst a = 1;");
    expect(root.children[0]?.type).toBe("code");
  });

  it("closes unterminated emphasis", () => {
    expect(JSON.stringify(parseVolatileTail("this is **bold"))).toContain("strong");
  });

  it("negative control: a lone dollar sign is NOT closed into a formula", () => {
    // `inlineKatex` stays off because "it cost $5" is ordinary prose, and closing the
    // first `$` would rewrite a sentence into a formula that never arrives.
    const rendered = JSON.stringify(parseVolatileTail("it cost $5 and then"));
    expect(rendered).not.toContain("inlineMath");
    expect(rendered).toContain("it cost $5 and then");
  });

  it("keeps an unfinished link's text on screen", () => {
    // Dropping it mid-stream and re-introducing it is the flicker the split forbids.
    expect(JSON.stringify(parseVolatileTail("see [the note"))).toContain("the note");
  });
});
