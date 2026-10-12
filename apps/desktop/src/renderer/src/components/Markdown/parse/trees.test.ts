// The app's markdown trees: a settled block against the whole body's definitions, the cache that
// shares a block's tree, a long table read in pieces as its whole parse reads it, and a worker that
// fails or stops answering, which fails every text it holds and is replaced on the next one.

import type { Root } from "mdast";
import { describe, expect, it, vi } from "vitest";

import { MarkdownWorkerConnection, type MarkdownWorkerStart } from "../worker/connection.js";
import { InThreadMarkdownWorkers } from "../worker/connection.test-support.js";
import { parseMarkdownTree } from "../worker/serialized-tree.js";
import { footnoteDefinitionPreamble, MarkdownTrees, type MarkdownParseOutcome } from "./trees.js";

/** Trees of their own, parsed by stand-in workers that `start` starts. */
function treesOn(start: MarkdownWorkerStart): MarkdownTrees {
  return new MarkdownTrees(new MarkdownWorkerConnection(start, window));
}

/** Trees of their own, and the stand-in workers they parse with. */
function standInTrees(): {
  readonly trees: MarkdownTrees;
  readonly workers: InThreadMarkdownWorkers;
} {
  const workers = new InThreadMarkdownWorkers();
  return { trees: treesOn(workers.start), workers };
}

/** A settled block's tree, which the stand-in worker answers before the request returns. */
function settledTreeOf(trees: MarkdownTrees, source: string, definitionPreamble = ""): Root {
  let outcome: MarkdownParseOutcome | undefined;
  trees.requestSettledBlock(source, definitionPreamble, (landed) => {
    outcome = landed;
  });
  return outcome?.status === "parsed" ? outcome.root : expect.fail("the block was parsed");
}

describe("a settled block", () => {
  it("is parsed once and shared, and two different blocks are two different trees", () => {
    const { trees, workers } = standInTrees();
    const first = settledTreeOf(trees, "first\n");

    // A cache keyed on something constant would hand one block's tree to another.
    expect(settledTreeOf(trees, "second\n")).not.toBe(first);
    expect(settledTreeOf(trees, "first\n")).toBe(first);
    expect(workers.latest().requests).toHaveLength(2);
  });

  it("drops the synthetic definitions and keeps the author's own", () => {
    // Both carry the identifier `1`, so identity cannot tell them apart; the offset rule does.
    const parsed = settledTreeOf(
      standInTrees().trees,
      "[^1]: the note body\n",
      footnoteDefinitionPreamble(new Set(["1"])),
    );
    expect(parsed.children).toHaveLength(1);
    expect(JSON.stringify(parsed.children)).toContain("the note body");
  });

  it("keeps an indented code block out of the preamble's last definition", () => {
    // A footnote definition takes indented lines after a blank one as its body, so a preamble
    // ending in a blank line would swallow this block.
    const parsed = settledTreeOf(
      standInTrees().trees,
      "    command --flag\n",
      footnoteDefinitionPreamble(new Set(["1"])),
    );
    expect(parsed.children[0]?.type).toBe("code");
  });
});

describe("a held settled block", () => {
  it("keeps its tree for each holder until that holder lets go, however often it lets go", () => {
    const { trees } = standInTrees();
    const first = heldTreeOf(trees, "held block\n");
    const second = heldTreeOf(trees, "held block\n");
    expect(second.root).toBe(first.root);

    // One holder letting go twice must not let go of the other's hold.
    first.letGo();
    first.letGo();
    fillCache(trees, "first");
    expect(settledTreeOf(trees, "held block\n")).toBe(second.root);
    second.letGo();
    fillCache(trees, "second");
    expect(settledTreeOf(trees, "held block\n")).not.toBe(second.root);
  });
});

describe("a block that is one long table", () => {
  it("is parsed in pieces and reads every row as the whole block's parse reads it", () => {
    const preamble = footnoteDefinitionPreamble(new Set(["1"]));
    for (const lineEnding of ["\n", "\r\n"]) {
      const { trees, workers } = standInTrees();
      // As the reply's blocks are cut: through the blank line that ends the table.
      const block = longTable(lineEnding) + lineEnding + lineEnding;
      const pieced = settledTreeOf(trees, block, preamble);

      // Many texts were parsed, each far shorter than the block, and none of them whole.
      const parsedLengths = workers.latest().requests.map((request) => request.source.length);
      expect(parsedLengths.length).toBeGreaterThan(2);
      expect(Math.max(...parsedLengths)).toBeLessThan(block.length / 2);
      expect(treeOf(pieced)).toStrictEqual(treeOf(wholeParseOf(block, preamble)));
    }
  });

  it("is parsed whole when a line ends the table, as the whole parse reads it", () => {
    const { trees, workers } = standInTrees();
    const rows = longTable("\n").split("\n");
    // A quote line ends a table, so the rows after it are a paragraph, which no piece can tell.
    rows.splice(rows.length - 40, 0, "> a quote between rows");
    const block = rows.join("\n");

    const parsed = settledTreeOf(trees, block);

    expect(workers.latest().requests.at(-1)?.source).toBe(block);
    expect(treeOf(parsed)).toStrictEqual(treeOf(wholeParseOf(block, "")));
    expect(parsed.children.map((node) => node.type)).toStrictEqual(["table", "blockquote"]);
  });
});

/** A table longer than several pieces, its cells holding what reads across a row's text. */
function longTable(lineEnding: string): string {
  const rows = Array.from(
    { length: 1_200 },
    (_, index) =>
      `| lane-${String(index)} | **${String(index)}** ~5% and ~~gone~~ | $x_${String(index)}$ ` +
      `costs $5 and $10 | see www.example.com[^1] | \`code ${String(index)}\` |`,
  );
  return [
    "| Lane | State | Formula | Link | Code |",
    "| :-- | --- | :-: | --- | --: |",
    ...rows,
  ].join(lineEnding);
}

/** The block's tree as one parse of it reads it, against `preamble`, without the preamble's. */
function wholeParseOf(block: string, preamble: string): Root {
  const root = parseMarkdownTree(preamble + block);
  return {
    ...root,
    children: root.children.filter(
      (child) => (child.position?.start.offset ?? 0) >= preamble.length,
    ),
  };
}

/** A tree's nodes as plain data, without the root's own place and a table's mark of its pieces. */
function treeOf(root: Root): unknown {
  return JSON.parse(
    JSON.stringify({ children: root.children }, (key, value: unknown) =>
      key === "data" ? undefined : value,
    ),
  );
}

/** A settled block's tree held in the cache, and what lets it go. */
function heldTreeOf(
  trees: MarkdownTrees,
  source: string,
): { readonly root: Root; readonly letGo: () => void } {
  let outcome: MarkdownParseOutcome | undefined;
  const letGo = trees.holdSettledBlock(source, "", (landed) => {
    outcome = landed;
  });
  return {
    root: outcome?.status === "parsed" ? outcome.root : expect.fail("the block was parsed"),
    letGo,
  };
}

/** Parses blocks past the cache's whole cap, each within it, evicting every tree no one holds. */
function fillCache(trees: MarkdownTrees, tag: string): void {
  for (let block = 0; block < FILLING_BLOCK_COUNT; block += 1) {
    const rows = Array.from(
      { length: FILLING_TABLE_ROWS },
      (_, index) => `| ${tag} ${String(block)} ${String(index)} | **bold** | \`code\` | text |`,
    );
    settledTreeOf(trees, ["| a | b | c | d |", "| - | - | - | - |", ...rows].join("\n"));
  }
}

/**
 * Tables the cache charges over a quarter of its cap each, about 2,000 nodes at 260 bytes and
 * their buffer, and enough of them to pass it.
 */
const FILLING_TABLE_ROWS = 200;
const FILLING_BLOCK_COUNT = 6;

describe("text GFM keeps literal", () => {
  it.each([
    "x ~y~ z",
    "H~2~O",
    "~/.claude/~/.codex",
    "(~10~15 s)",
    "approx. ~3x~ faster",
    "paths ~/a,~/b",
    "~20°C~25°C",
    "Open http://… in browser",
    "see 😀www.example.org",
  ])("keeps %j the text it was written as", (source) => {
    const paragraph = settledTreeOf(standInTrees().trees, source).children[0];
    expect(paragraph?.type === "paragraph" ? paragraph.children : undefined).toMatchObject([
      {
        type: "text",
        value: source,
        position: { start: { offset: 0 }, end: { offset: source.length } },
      },
    ]);
  });

  it("still strikes a double tilde through and links a domain, behind the body's definitions", () => {
    const preamble = footnoteDefinitionPreamble(new Set(["1"]));
    const source = "~~gone~~ and ~b *c* d~ at www.example.org";
    const paragraph = settledTreeOf(standInTrees().trees, source, preamble).children[0];
    const children = paragraph?.type === "paragraph" ? paragraph.children : [];
    expect(children.map(({ type }) => type)).toStrictEqual([
      "delete",
      "text",
      "emphasis",
      "text",
      "link",
    ]);
    // The tildes join the text beside them, and the joined text keeps where it sits.
    expect(children[1]).toMatchObject({
      value: " and ~b ",
      position: { start: { offset: preamble.length + 8 }, end: { offset: preamble.length + 16 } },
    });
    expect(children[3]).toMatchObject({ value: " d~ at " });
  });
});

describe("a worker that fails", () => {
  it("fails every text it holds, and the next text starts a new worker", () => {
    const { trees, workers } = standInTrees();
    const outcomes: MarkdownParseOutcome[] = [];
    trees.requestTree("first", "", (outcome) => outcomes.push(outcome));
    workers.latest().hold();
    trees.requestTree("held", "", (outcome) => outcomes.push(outcome));
    workers.latest().failParser("unreachable executed");

    expect(outcomes.map((outcome) => outcome.status)).toStrictEqual(["parsed", "failed"]);
    expect(workers.latest().isTerminated).toBe(true);
    trees.requestTree("after", "", (outcome) => outcomes.push(outcome));
    expect(workers.started).toHaveLength(2);
    expect(outcomes.at(-1)?.status).toBe("parsed");
  });

  it("that fails to load its parser fails its texts and has the next compile it, which later ones load", () => {
    const { trees, workers } = standInTrees();
    const outcomes: MarkdownParseOutcome[] = [];
    trees.requestTree("first", "", (outcome) => outcomes.push(outcome));
    workers.latest().hold();
    trees.requestTree("held", "", (outcome) => outcomes.push(outcome));
    workers.latest().failLoad("out of memory");

    expect(outcomes.at(-1)).toStrictEqual({
      status: "failed",
      reason: "The markdown parser did not load: out of memory",
    });
    trees.requestTree("after", "", (outcome) => outcomes.push(outcome));
    expect(outcomes.at(-1)?.status).toBe("parsed");
    // A worker replaced for any other failure loads the parser the last one compiled.
    workers.latest().failParser("unreachable executed");
    trees.requestTree("third worker", "", (outcome) => outcomes.push(outcome));
    const [first, second, third] = workers.started.map((worker) => worker.loads);
    expect([first, second]).toStrictEqual([[undefined], [undefined]]);
    expect(third).toHaveLength(1);
    expect(third?.[0]).toBeInstanceOf(WebAssembly.Module);
  });

  it("that cannot start fails the text, and the block is asked for anew next time", () => {
    const workers = new InThreadMarkdownWorkers();
    let startCount = 0;
    const trees = treesOn(() => {
      startCount += 1;
      if (startCount === 1) {
        throw new Error("Workers are not allowed here");
      }
      return workers.start();
    });
    const outcomes: MarkdownParseOutcome[] = [];
    trees.requestSettledBlock("a block\n", "", (outcome) => outcomes.push(outcome));

    expect(outcomes).toStrictEqual([
      {
        status: "failed",
        reason: "The markdown worker could not start: Workers are not allowed here",
      },
    ]);
    // A failed ask leaves no wait behind for the next ask to join.
    expect(settledTreeOf(trees, "a block\n").children[0]?.type).toBe("paragraph");
  });

  it("that never answers fails its texts at the deadline", () => {
    vi.useFakeTimers();
    try {
      const { trees, workers } = standInTrees();
      const outcomes: MarkdownParseOutcome[] = [];
      trees.requestTree("warm", "", () => undefined);
      workers.latest().hold();
      trees.requestTree("never answered", "", (outcome) => outcomes.push(outcome));
      vi.advanceTimersByTime(9_999);
      expect(outcomes).toStrictEqual([]);
      vi.advanceTimersByTime(1);
      expect(outcomes).toStrictEqual([
        { status: "failed", reason: "The markdown worker did not answer in time" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
