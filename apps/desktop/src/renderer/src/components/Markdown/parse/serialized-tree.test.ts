// What the parser parses a text into: a formula between single dollars only where Pandoc reads one,
// a price or a shell variable left as the words it is whatever symbols the text holds, and one
// alone between double dollars a display formula; a text opening on a byte order mark read with the
// mark as text, every offset counted in it, so a price and a single tilde there stay the words they
// are; an indented code block after the line that closed a list one block, blank line and all; and
// what the worker transfers to the page, a plain buffer of the tree's bytes alone. A shared buffer
// cannot be posted on a page that is not cross-origin isolated, and a pooled one would hand the
// page other bytes besides.

import type { Nodes } from "mdast";
import { describe, expect, it } from "vitest";

import { parseMarkdownTree, standaloneBufferOf } from "./serialized-tree.js";

describe("mathematics between dollars", () => {
  it("reads a formula inside a sentence, and one alone between double dollars as a display one", () => {
    expect(formulasIn("The ratio $x^2 + 1$ grows.\n")).toStrictEqual(["inlineMath x^2 + 1"]);
    expect(formulasIn("$$\\sum_i x_i$$\n")).toStrictEqual(["math \\sum_i x_i"]);
    expect(formulasIn("$$\n\\frac{a}{b}\n$$\n")).toStrictEqual(["math \\frac{a}{b}"]);
  });

  it("leaves a price and a shell variable as the words they are, beside the symbols a text holds", () => {
    for (const words of [
      "It costs $5.\n",
      "Set $HOME first.\n",
      "Pay $5 and $10 today.\n",
      "Between $5 and $10, take $20$30.\n",
      "From $5-$10.\n",
      "Run echo $PATH and $HOME.\n",
      // The symbols a dollar read as text could stand as first, written by the author.
      "Pay ¢5, £5, ¤5 or $5 and $10, ¥ and ¦ as written.\n",
      // A byte order mark ahead counts in every offset the dollars are read at.
      "\uFEFFPay $5 and $10 today.\n",
    ]) {
      expect(formulasIn(words), words).toStrictEqual([]);
      expect(textOf(parseMarkdownTree(words)), words).toBe(words.trimEnd());
    }
    expect(formulasIn("Pay $5 and $10, then $x^2$ holds.\n")).toStrictEqual(["inlineMath x^2"]);
  });
});

describe("a text opening on a byte order mark", () => {
  it("reads the mark as text, and a single tilde after it as the words it is", () => {
    const words = "\uFEFFsay ~hi~ there\n";
    expect(textOf(parseMarkdownTree(words))).toBe(words.trimEnd());
  });
});

describe("indented code", () => {
  it("keeps a block whole when a thematic break, not the code, closed the list before it", () => {
    const tree = parseMarkdownTree("- a\n\n\n***\n    code\n\n    more\n");
    expect(tree.children.map((node) => node.type)).toStrictEqual(["list", "thematicBreak", "code"]);
    expect(tree.children[2]).toMatchObject({ type: "code", value: "code\n\nmore" });
  });
});

describe("the buffer the worker transfers", () => {
  it("is copied out of shared memory and out of a larger buffer, as a plain buffer", () => {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    shared.set([1, 2, 3, 4]);
    const pooled = new Uint8Array(new ArrayBuffer(8), 2, 3);
    pooled.set([5, 6, 7]);

    for (const [bytes, expected] of [
      [shared, [1, 2, 3, 4]],
      [pooled, [5, 6, 7]],
    ] as const) {
      const buffer = standaloneBufferOf(bytes);
      expect(Object.prototype.toString.call(buffer)).toBe("[object ArrayBuffer]");
      expect([...new Uint8Array(buffer)]).toStrictEqual(expected);
    }
  });
});

/** Each formula in `source`'s parse, as its kind and its TeX. */
function formulasIn(source: string): string[] {
  const formulas: string[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === "math" || node.type === "inlineMath") {
      formulas.push(`${node.type} ${node.value}`);
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  visit(parseMarkdownTree(source));
  return formulas;
}

/** The text a tree holds, its text nodes joined. */
function textOf(node: Nodes): string {
  if (node.type === "text") {
    return node.value;
  }
  return "children" in node ? node.children.map(textOf).join("") : "";
}
