// The Table view's rows as strings are read and their parses land in any order: the list draws
// no row past a string still being read, and the rows that land out of order come out exactly as
// the rows that land in order.

import { describe, expect, it } from "vitest";

import type { WorkflowItem } from "@ai-sidekicks/contracts/workflow/definition/document";

import type { CodeSpanReader } from "#renderer/components/Markdown/highlight/code-span-reader.js";
import { parseTree } from "#renderer/components/Markdown/parse/trees.test-support.js";
import { markdownDocumentOf } from "./markdown-document-rows.js";
import { PayloadTableRows, type MarkdownDocumentOutcome } from "./rows.js";
import { joinFigureSentence } from "#renderer/lib/figure-sentence.js";

const NO_SPANS: CodeSpanReader = {
  heldSpans: () => undefined,
  readSpans: () => Promise.resolve(undefined),
};

const ITEMS: readonly WorkflowItem[] = [
  { json: { summary: "# Findings\n\n- one\n- two", notes: "plain words here" } },
  { json: { summary: "## Second\n\nA paragraph.\n\n- three", id: "run-7" } },
];

/** The lines ITEMS' rows stand for: a head, a string's own, and a token value each as one. */
const ITEM_LINE_COUNT = 1 + 4 + 1 + 1 + 5 + 1;

/** The model and its asked reads, each to be landed with its string's parsed document. */
function readingModel(): {
  readonly model: PayloadTableRows;
  readonly land: (read: number) => Promise<void>;
} {
  const reads: {
    readonly text: string;
    readonly settle: (outcome: MarkdownDocumentOutcome) => void;
  }[] = [];
  const model = new PayloadTableRows(ITEMS, (text, settle) => {
    reads.push({ text, settle });
  });
  return {
    model,
    land: async (read) => {
      const asked = reads[read] ?? expect.fail(`no read ${String(read)} to land`);
      asked.settle({
        status: "read",
        document: markdownDocumentOf(await parseTree(asked.text), NO_SPANS, undefined),
      });
    },
  };
}

/** What each row draws, without the parsed nodes' positions. */
function drawn(model: PayloadTableRows): readonly string[] {
  return model.rows.map((row) => {
    switch (row.kind) {
      case "item":
        return `item ${joinFigureSentence(row.heading)}`;
      case "value":
        return `value ${row.text}`;
      case "markdown":
        return `markdown ${row.place.kind === "member" ? String(row.place.key) : "whole"}`;
      case "file":
        return `file ${joinFigureSentence(row.line)}`;
    }
  });
}

describe("the Table view's rows", () => {
  it("draw nothing past a string still being read, and the same rows in any landing order", async () => {
    const inOrder = readingModel();
    // The first head draws at once; every row after it waits.
    expect(inOrder.model.waitingLineCount).toBe(ITEM_LINE_COUNT - 1);
    inOrder.model.readAhead(ITEM_LINE_COUNT - 1, () => undefined);
    for (const read of [0, 1, 2]) {
      await inOrder.land(read);
    }
    const outOfOrder = readingModel();
    outOfOrder.model.readAhead(ITEM_LINE_COUNT - 1, () => undefined);
    expect(drawn(outOfOrder.model)).toStrictEqual(["item Item 0"]);

    // The second and third strings land before the first: nothing past the first is drawn.
    await outOfOrder.land(2);
    await outOfOrder.land(1);
    expect(drawn(outOfOrder.model)).toStrictEqual(["item Item 0"]);
    await outOfOrder.land(0);

    expect(drawn(outOfOrder.model)).toStrictEqual(drawn(inOrder.model));
    expect(drawn(inOrder.model)).toContain("value run-7");
    expect(inOrder.model.waitingLineCount).toBe(0);
  });

  it("read only as far ahead as asked, and keep the room of the rows still waiting", async () => {
    const { model, land } = readingModel();
    // The first two lines past the drawn head: the first summary's.
    model.readAhead(2, () => undefined);
    await land(0);

    expect(drawn(model)).toContain("markdown summary");
    expect(drawn(model)).not.toContain("value plain words here");
    // The rest: the notes, the second head, its summary and its id.
    expect(model.waitingLineCount).toBe(1 + 1 + 5 + 1);
  });
});
