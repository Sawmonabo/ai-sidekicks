// A copy built a slice at a time: cut after every part, and after every formatted part, it is the
// same bytes as the whole copy, with each large body read in full before its row and only a long
// reply part's formatted flavor made by the markdown worker, in its place; a refused read or a
// failed worker copies nothing.

import { afterEach, describe, expect, it, vi } from "vitest";

import { PAGE_HTML_CHARACTER_LIMIT } from "#renderer/components/Markdown/worker/connection.js";
import { RefusalError } from "#renderer/lib/refusal/contract.js";
import { ConversationCopyBuild, type ConversationCopyRows } from "./conversation-copy.js";
import { type SelectedPart } from "./conversation-selection.js";

const LARGE_BODY_ROW_ID = "event-large";
const LARGE_BODY = "line one\nline two";
/** A reply too long to make into HTML on the page's thread. */
const LONG_REPLY = "a".repeat(PAGE_HTML_CHARACTER_LIMIT);
/** What the stand-in worker makes of the long reply. */
const WORKER_HTML = "<p>made by the worker</p>";

/** Each row's text; a row whose large body is not read copies its unread badge. */
const ROW_TEXT: Readonly<Record<string, (fullBody: string | undefined) => SelectedPart>> = {
  asked: () => ({ flavor: "text", text: "rename the reader\nand its callers" }),
  replied: () => ({ flavor: "markdown", text: "Here is **the plan**" }),
  long: () => ({ flavor: "markdown", text: LONG_REPLY }),
  blank: () => ({ flavor: "text", text: "  " }),
  output: (fullBody) => ({ flavor: "text", text: fullBody ?? "Output not read" }),
  closing: () => ({ flavor: "markdown", text: "- done" }),
};

const ROW_KEYS = Object.keys(ROW_TEXT);

/**
 * The rows above, none drawn, `output` reading its large body through `readFullBody`, the long
 * reply's formatted flavor made by `markdownWorker`.
 */
function rowsReading(
  readFullBody: NonNullable<ConversationCopyRows["fullBodyReads"]>["readFullBody"],
  markdownWorker: ConversationCopyRows["markdownWorker"],
): ConversationCopyRows {
  const position = { path: [], characterOffset: 0 };
  return {
    selection: {
      start: { at: "row", rowKey: ROW_KEYS[0] ?? "", position },
      end: { at: "row", rowKey: ROW_KEYS.at(-1) ?? "", position },
    },
    rowKeys: ROW_KEYS,
    endRowElement: () => undefined,
    rowText: (rowKey, fullBodyOf) => {
      const fullBody = fullBodyOf(LARGE_BODY_ROW_ID);
      return ROW_TEXT[rowKey]?.(fullBody?.status === "available" ? fullBody.body : undefined);
    },
    rowBodyText: () => expect.fail("no row is drawn"),
    largeBodyRowIdOf: (rowKey) => (rowKey === "output" ? LARGE_BODY_ROW_ID : undefined),
    fullBodyReads: { readFullBody },
    markdownWorker,
  };
}

/** A window running its tasks at once, its clock past each slice's end: a slice holds one part. */
function windowCuttingEveryPart(): Window {
  let nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (nowMs += 10));
  return { scheduler: { postTask: async (task: () => unknown) => task() } } as unknown as Window;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a copy built a slice at a time", () => {
  it("is the whole copy: bodies read in full, a long reply made by the worker", async () => {
    const reads: string[] = [];
    const workerTexts: string[] = [];
    const build = new ConversationCopyBuild(
      rowsReading(
        async (rowId) => {
          reads.push(rowId);
          return { status: "served", value: { status: "available", body: LARGE_BODY } };
        },
        {
          html: async (markdown) => {
            workerTexts.push(markdown);
            return WORKER_HTML;
          },
        },
      ),
    );

    const content = await build.finish(windowCuttingEveryPart(), () => true);

    expect([reads, workerTexts]).toStrictEqual([[LARGE_BODY_ROW_ID], [LONG_REPLY]]);
    expect(content).toStrictEqual({
      text:
        "rename the reader\nand its callers\n\nHere is **the plan**\n\n" +
        `${LONG_REPLY}\n\n${LARGE_BODY}\n\n- done`,
      html:
        "<p>rename the reader<br>and its callers</p>" +
        "<p>Here is <strong>the plan</strong></p>" +
        WORKER_HTML +
        "<p>line one<br>line two</p>" +
        "<ul>\n<li>done</li>\n</ul>",
    });
  });

  it("copies nothing when a large body's read is refused", async () => {
    const refusal = {
      code: "transcript.body_not_found",
      detail: "No such body.",
      origin: "daemon",
    };
    const build = new ConversationCopyBuild(
      rowsReading(async () => ({ status: "refused", refusal }), {
        html: () => expect.fail("the copy stops at the refused read"),
      }),
    );

    await expect(build.finish(windowCuttingEveryPart(), () => true)).rejects.toStrictEqual(
      new RefusalError(refusal),
    );
  });

  it("copies nothing when the markdown worker fails", async () => {
    const failure = new Error("The markdown worker stopped: out of memory");
    const build = new ConversationCopyBuild(
      rowsReading(
        async () => ({ status: "served", value: { status: "available", body: LARGE_BODY } }),
        { html: async () => Promise.reject(failure) },
      ),
    );

    await expect(build.finish(windowCuttingEveryPart(), () => true)).rejects.toBe(failure);
  });
});
