// One parse per settled block, and `remend` on the tail alone.

import { describe, expect, it } from "vitest";

import type { MarkdownBlockNode } from "./markdown-parse.js";
import {
  footnoteDefinitionPreamble,
  parseSettledBlock,
  parseVolatileTail,
  settledBlockCacheStats,
} from "./markdown-parse.js";

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

describe("parsing a block against the whole body's definitions", () => {
  const CITING_BLOCK = "cite[^1] here\n";

  it("makes a reference whose definition settled elsewhere a real reference node", () => {
    const preamble = footnoteDefinitionPreamble(new Set(["1"]));
    const parsed = parseSettledBlock(CITING_BLOCK, preamble);
    expect(JSON.stringify(parsed.children)).toContain("footnoteReference");
  });

  it("negative control: the same block alone yields no reference node at all", () => {
    // This is the whole defect. GFM leaves `[^1]` as literal characters when its
    // definition is absent from the parse, and no later pass can promote a text node
    // into a reference — so without the preamble there is nothing to upgrade.
    expect(JSON.stringify(parseSettledBlock(CITING_BLOCK).children)).not.toContain(
      "footnoteReference",
    );
  });

  it("drops the synthetic definitions and keeps the author's own", () => {
    // The preamble's `[^1]:` and the block's `[^1]: the note body` carry one identifier,
    // so identity cannot tell them apart and the offset rule is what does.
    const parsed = parseSettledBlock(
      "[^1]: the note body\n",
      footnoteDefinitionPreamble(new Set(["1"])),
    );
    expect(parsed.children).toHaveLength(1);
    expect(JSON.stringify(parsed.children)).toContain("the note body");
  });

  it("keeps an indented code block out of the preamble's last definition", () => {
    // A footnote definition takes indented lines after a blank one as its own body, so a
    // preamble ending in a blank line would swallow this block whole.
    const parsed = parseSettledBlock(
      "    command --flag\n",
      footnoteDefinitionPreamble(new Set(["1"])),
    );
    expect(parsed.children[0]?.type).toBe("code");
  });

  it("negative control: a body declaring no footnotes parses and caches exactly as before", () => {
    // The empty preamble has to be byte-identical to no preamble, or every footnote-free
    // message in the ledger re-keys its cache and re-parses for a feature it never uses.
    const source = `unchanged by the preamble ${String(Math.random())}\n`;
    expect(parseSettledBlock(source, footnoteDefinitionPreamble(new Set()))).toBe(
      parseSettledBlock(source),
    );
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
