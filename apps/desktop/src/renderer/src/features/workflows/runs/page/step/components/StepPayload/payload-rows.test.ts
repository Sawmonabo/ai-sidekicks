// The Table view's rows as strings are read in whatever order their rows are drawn: each read
// replaces its own string's row in place, so the rows read out of order come out exactly as the
// rows read in order.

import { describe, expect, it } from "vitest";

import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow/definition/definition";

import { parseMarkdownDocument } from "#renderer/components/Markdown/markdown-document-rows.js";
import type { CodeSpanReader } from "#renderer/components/Markdown/highlight/code-span-reader.js";
import { PayloadTableRows } from "./payload-rows.js";

const NO_SPANS: CodeSpanReader = {
  heldSpans: () => undefined,
  readSpans: () => Promise.resolve(undefined),
};

const ITEMS: readonly WorkflowItem[] = [
  { json: { summary: "# Findings\n\n- one\n- two", notes: "plain words here" } },
  { json: { summary: "## Second\n\nA paragraph.\n\n- three", id: "run-7" } },
];

function rowsOf(order: readonly number[]): PayloadTableRows {
  const model = new PayloadTableRows(ITEMS, (text) => parseMarkdownDocument(text, NO_SPANS));
  for (const stringIndex of order) {
    model.readString(stringIndex);
  }
  return model;
}

/** What each row draws, without the parsed nodes' positions. */
function drawn(model: PayloadTableRows): readonly string[] {
  return model.rows.map((row) => {
    switch (row.kind) {
      case "item":
        return `item ${row.heading}`;
      case "value":
        return `value ${row.text}`;
      case "unread":
        return `unread ${String(row.stringIndex)}`;
      case "markdown":
        return `markdown ${row.place.kind === "member" ? String(row.place.key) : "whole"}`;
      case "file":
        return `file ${row.line}`;
    }
  });
}

describe("the Table view's rows", () => {
  it("come out the same whichever order their strings are read in", () => {
    const inOrder = rowsOf([0, 1, 2]);
    const outOfOrder = rowsOf([2, 0, 1]);

    expect(drawn(outOfOrder)).toStrictEqual(drawn(inOrder));
    expect(drawn(inOrder).filter((row) => row.startsWith("unread"))).toStrictEqual([]);
  });

  it("keep a row's key while a read before it adds rows", () => {
    const model = rowsOf([]);
    const lastRow = model.rows.length - 1;
    const keyBefore = model.rowKey(lastRow);

    model.readString(0);

    expect(model.rows.length).toBeGreaterThan(lastRow + 1);
    expect(model.rowKey(model.rows.length - 1)).toBe(keyBefore);
  });
});
