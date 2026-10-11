// A selection across a table tens of thousands of rows long, in a body that copies as text, read
// by the conversation's copy in a real engine, the markdown worker reading the long part into its
// text: every row, the head's among them, comes out on its own line, its cells apart by a tab, and
// none is lost to the call stack's depth.

import { describe, expect, it } from "vitest";

import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import { ConversationCopyBuild } from "#renderer/features/transcript/copy/conversation-copy.js";
import { COPY_FLAVOR_ATTRIBUTE } from "#renderer/features/transcript/copy/conversation-selection.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";

/** Rows enough that collecting their text as one list of call arguments overflows the stack. */
const STACK_DEEP_TABLE_ROW_COUNT = 32_549;

/** The key of the one row the selection runs across. */
const ROW_KEY = "row-0";

describe("a long table in a selection", () => {
  it("copies as text, every row on its own line and a tab between its cells", async () => {
    const lanes = Array.from({ length: STACK_DEEP_TABLE_ROW_COUNT }, (_, index) => String(index));
    const conversation = document.createElement("div");
    conversation.innerHTML =
      `<div ${WINDOWED_ROW_INDEX_ATTRIBUTE}="0"><div ${COPY_FLAVOR_ATTRIBUTE}="text">` +
      `<table><thead><tr><th>Lane</th><th>Rows</th></tr></thead><tbody>` +
      lanes.map((lane) => `<tr><td>lane-${lane}</td><td>${lane}</td></tr>`).join("") +
      `</tbody></table></div></div>`;
    const row = conversation.firstElementChild ?? expect.fail("the conversation draws its row");

    const copy = await new ConversationCopyBuild({
      selection: {
        start: { at: "row", rowKey: ROW_KEY, position: { path: [], characterOffset: 0 } },
        end: {
          at: "row",
          rowKey: ROW_KEY,
          position: { path: [], characterOffset: row.textContent.length },
        },
      },
      rowKeys: [ROW_KEY],
      endRowElement: () => row,
      rowText: () => expect.fail("the one row is an end row"),
      rowBodyText: () => expect.fail("the table draws no large body"),
      drawnTableOf: () => expect.fail("the table draws every row"),
      largeBodyRowIdOf: () => undefined,
      fullBodyReads: undefined,
      markdownWorker: {
        html: () => expect.fail("a text part needs no formatted flavor"),
        drawnText: (tree, flavor, tables) => markdownWorker.drawnText(tree, flavor, tables),
      },
    }).finish(
      window,
      () => true,
      () => expect.fail("a text copy is whole once its text is"),
    );

    expect(copy).toStrictEqual({
      text: ["Lane\tRows", ...lanes.map((lane) => `lane-${lane}\t${lane}`)].join("\n"),
    });
  });
});
