// A drawn part whose own text holds the character that marks undrawn items while they are read:
// copied with those items read back in their places, as the part drawn whole copies, whether its
// undrawn items are an output's lines or a table's rows, as text or as markdown.

import type { Table, TableRow } from "mdast";
import { describe, expect, it } from "vitest";

import { TASKS_AT_ONCE } from "#test/helpers/tasks-at-once.js";
import { type DrawnWindowSource } from "#renderer/components/TranscriptBodyViewport/drawn-window-sources.js";
import { withUndrawnItems, withUndrawnItemsText } from "./undrawn-items.js";
import {
  drawnTreeMarkdown,
  drawnTreeText,
  MARKER_ESCAPE,
  UNDRAWN_ROWS_MARKER,
  type DrawnElement,
  type DrawnTree,
} from "#renderer/components/Markdown/drawn-text.js";

/** A text holding both characters a reading writes apart, each where an escape's digit follows. */
const MARKED = `a ${UNDRAWN_ROWS_MARKER}0 b ${MARKER_ESCAPE}1 c`;

/** An element of `tagName` holding `children`, with `properties`. */
function element(
  tagName: string,
  children: DrawnTree[],
  properties: DrawnElement["properties"] = {},
): DrawnElement {
  return { type: "element", tagName, properties, children } as DrawnElement;
}

function text(value: string): DrawnTree {
  return { type: "text", value };
}

/** The output's lines, its second holding the marker too. */
const OUTPUT_LINES = [`one ${MARKED}\n`, `two ${MARKED}\n`, "three\n"];

/** A part of a paragraph and the output, its second line drawn as a spacer or drawn whole. */
function outputPart(isWhole: boolean): DrawnTree {
  const second = isWhole
    ? element("span", [text(OUTPUT_LINES[1] ?? "")])
    : element("span", [], {
        dataUndrawnTextSource: "output",
        dataFirstUndrawnItem: 1,
        dataLastUndrawnItem: 1,
      });
  return element("div", [
    element("p", [text(MARKED)]),
    element("pre", [
      element("span", [text(OUTPUT_LINES[0] ?? "")]),
      second,
      element("span", [text(OUTPUT_LINES[2] ?? "")]),
    ]),
  ]);
}

/** A table's body row of `cells`, as the parse holds it. */
function parsedRow(cells: readonly string[]): TableRow {
  return {
    type: "tableRow",
    children: cells.map((cell) => ({
      type: "tableCell",
      children: [{ type: "text", value: cell }],
    })),
  };
}

/** The table's head and its body rows, its middle row holding the marker. */
const TABLE_ROWS = [
  ["name", "note"],
  [`x ${MARKED}`, "1"],
  [`y ${MARKED}`, "2"],
  ["z", "3"],
];

const TABLE: Table = { type: "table", align: [null, null], children: TABLE_ROWS.map(parsedRow) };

/** A part of a paragraph and the table, its middle body row drawn as a spacer or drawn whole. */
function tablePart(isWhole: boolean): DrawnTree {
  const row = (cells: readonly string[] | undefined, cellTag: string): DrawnElement =>
    element(
      "tr",
      (cells ?? []).map((cell) => element(cellTag, [text(cell)])),
    );
  const middle = isWhole
    ? row(TABLE_ROWS[2], "td")
    : element("tr", [], {
        dataMarkdownTable: "table",
        dataMarkdownFirstUndrawnRow: 1,
        dataMarkdownLastUndrawnRow: 1,
      });
  return element("div", [
    element("p", [text(MARKED)]),
    element("table", [
      element("thead", [row(TABLE_ROWS[0], "th")]),
      element("tbody", [row(TABLE_ROWS[1], "td"), middle, row(TABLE_ROWS[3], "td")]),
    ]),
  ]);
}

const SOURCES = new Map<string, DrawnWindowSource>([
  // The output's lines a chunk each, as its window reads them.
  ["output", { kind: "text", itemText: (index) => OUTPUT_LINES[index] ?? "", itemSeparator: "" }],
  ["table", { kind: "table", table: TABLE }],
]);

/** `part` copied as text, its undrawn items read back, its text cut after each escape. */
async function copiedText(part: DrawnTree): Promise<string> {
  const reading = withUndrawnItems(part, "text", (sourceKey) => SOURCES.get(sourceKey));
  const drawn = drawnTreeText(reading.tree, "text");
  // Each piece ends on an escape, so the escape and its digit come in two pieces.
  const pieces = drawn.split(new RegExp(`(?<=${MARKER_ESCAPE})`, "u"));
  expect(pieces.length).toBeGreaterThan(1);
  return (await withUndrawnItemsText({ text: drawn, pieces }, reading.textRuns, TASKS_AT_ONCE))
    .text;
}

describe("a copy of a part whose own text holds the undrawn items' marker", () => {
  it("reads an output's undrawn lines and a table's undrawn rows back as the part drawn whole", async () => {
    expect(await copiedText(outputPart(false))).toBe(drawnTreeText(outputPart(true), "text"));
    expect(await copiedText(tablePart(false))).toBe(drawnTreeText(tablePart(true), "text"));

    const reading = withUndrawnItems(tablePart(false), "markdown", (sourceKey) =>
      SOURCES.get(sourceKey),
    );
    const made = await drawnTreeMarkdown(reading.tree, {
      alignments: new Map([["table", TABLE.align]]),
      pull: (_tableKey, firstIndex, lastIndex) =>
        Promise.resolve(TABLE.children.slice(firstIndex + 1, lastIndex + 2)),
    });
    const whole = drawnTreeText(tablePart(true), "markdown");
    expect(made.markdown.join("")).toBe(whole);
    expect(whole).toContain(`| y ${MARKED} | 2    |`);
  });
});
