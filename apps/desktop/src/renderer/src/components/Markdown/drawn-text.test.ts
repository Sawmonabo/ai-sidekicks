// An inline formula read back into the markdown a copy carries: its source between single dollars,
// whether the screen drew it or it sits in a table row the screen never drew, a price beside it
// left as written, and the copy parsing back to the same formula.

import { expect, it } from "vitest";

import {
  drawnTreeMarkdown,
  drawnTreeText,
  markUndrawnRows,
  type DrawnElement,
  type DrawnTree,
} from "./drawn-text.js";
import { parseMarkdownTree } from "./parse/serialized-tree.js";

it("copies an inline formula as its source between dollars, and a price as written", () => {
  // As a copy of the drawing hands it over: the formula's place holds its source, marked as math.
  const drawn: DrawnTree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "p",
        properties: {},
        children: [
          { type: "text", value: "The ratio " },
          {
            type: "element",
            tagName: "code",
            properties: { dataLanguage: "math" },
            children: [{ type: "text", value: "x^2 + 1" }],
          },
          { type: "text", value: " costs $5." },
        ],
      },
    ],
  };

  const markdown = drawnTreeText(drawn, "markdown");

  expect(markdown).toBe("The ratio $x^2 + 1$ costs $5.");
  const [paragraph] = parseMarkdownTree(markdown).children;
  expect(paragraph?.type === "paragraph" ? paragraph.children[1] : undefined).toMatchObject({
    type: "inlineMath",
    value: "x^2 + 1",
  });
});

it("copies an inline formula in a table row the screen never drew between dollars", async () => {
  const [table] = parseMarkdownTree("| n | formula |\n| - | - |\n| 1 | $x^2$ |").children;
  if (table?.type !== "table") {
    return expect.fail("the markdown makes a table");
  }
  // The table as drawn: its head, and one row standing for the body row the screen did not draw.
  const standIn: DrawnElement = { type: "element", tagName: "tr", properties: {}, children: [] };
  markUndrawnRows(standIn, { tableKey: "table", firstIndex: 0, lastIndex: 0 });
  const headCell = (text: string): DrawnElement => ({
    type: "element",
    tagName: "th",
    properties: {},
    children: [{ type: "text", value: text }],
  });
  const drawn: DrawnTree = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "table",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "thead",
            properties: {},
            children: [
              {
                type: "element",
                tagName: "tr",
                properties: {},
                children: [headCell("n"), headCell("formula")],
              },
            ],
          },
          { type: "element", tagName: "tbody", properties: {}, children: [standIn] },
        ],
      },
    ],
  };

  const copied = await drawnTreeMarkdown(
    drawn,
    {
      alignments: new Map([["table", table.align]]),
      pull: (_tableKey, firstIndex, lastIndex) =>
        Promise.resolve(table.children.slice(firstIndex + 1, lastIndex + 2)),
    },
    parseMarkdownTree,
  );

  expect(copied.markdown.join("")).toBe(
    ["| n | formula |", "| - | ------- |", "| 1 | $x^2$   |"].join("\n"),
  );
});
