// What a selection across the conversation copies from the rows its ends sit in, read from the
// rows as they are drawn: each end row's part from the end's character offset, a large body read
// in full in its control's place, and a long table's undrawn rows read in their spacer's place, by
// the markdown worker for a long part.

import { render } from "@testing-library/react";
import type { TextClipboardContent } from "#shared/preload-api.js";
import { toHtml } from "hast-util-to-html";
import { renderToString } from "katex";
import { describe, expect, it, vi } from "vitest";

import { markdownTableBodyRows, markdownToHtml } from "#renderer/components/Markdown/html.js";
import { drawnTreeText, type CopyFlavor } from "#renderer/components/Markdown/drawn-text.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import {
  SAMPLE_RUN_ROW_TIME_SELECTOR,
  sampleRunRow,
  sampleUserMessageRow,
} from "#test/helpers/transcript/event-row-samples.js";
import { classifyTranscriptRow } from "../rows/kind.js";
import { MessageRow } from "../rows/MessageRow.js";
import { ToolRow } from "../rows/ToolRow.js";
import { FullBodyReads, FullBodyReadsContext } from "../rows/full-body-reads.js";
import {
  MARKDOWN_COLUMN_COUNT_ATTRIBUTE,
  MARKDOWN_SOURCE_END_ATTRIBUTE,
  MARKDOWN_SOURCE_START_ATTRIBUTE,
} from "../rows/markdown/block-window/markers.js";
import { FootnoteRegistry } from "../rows/markdown/footnotes/registry.js";
import { characterOffsetWithin } from "../viewport/selection/preservation.js";
import { ConversationCopyBuild, type ConversationCopyRows } from "./conversation-copy.js";
import { windowCuttingEveryPart } from "./conversation-copy.test-support.js";
import { COPY_FLAVOR_ATTRIBUTE } from "./conversation-selection.js";

/** A call's output size, too large to travel with its row. */
const LARGE_OUTPUT_BYTES = 2_000_000;

/** A formula whose drawing spells none of its source: KaTeX draws `\frac` as a fraction. */
const FORMULA_SOURCE = String.raw`\frac{a}{b} = x^2`;

/**
 * A conversation of one row whose body copies as `flavor` and holds only a display formula as
 * KaTeX draws it, inside a span carrying `formulaAttributes`.
 */
function conversationWithFormula(flavor: CopyFlavor, formulaAttributes: string): HTMLElement {
  const formulaMarkup = renderToString(FORMULA_SOURCE, {
    displayMode: true,
    output: "htmlAndMathml",
  });
  const conversation = document.createElement("div");
  conversation.innerHTML =
    `<div ${WINDOWED_ROW_INDEX_ATTRIBUTE}="0"><div ${COPY_FLAVOR_ATTRIBUTE}="${flavor}">` +
    `<span ${formulaAttributes}>${formulaMarkup}</span></div></div>`;
  return conversation;
}

/** Row text readers for rows that are all end rows, drawing no long table and no large body. */
const END_ROWS_ONLY: Pick<ConversationCopyRows, "rowText" | "rowBodyText"> = {
  rowText: () => expect.fail("every row here is an end row"),
  rowBodyText: () => expect.fail("no row here draws a table or a large body"),
};

/**
 * What a selection copies from the first drawn row in `conversation`, at `startOffset` characters,
 * to the end of the last, each row an end row, its text read through `readers`.
 */
function copyOfDrawnRows(
  conversation: Element,
  startOffset = 0,
  readers = END_ROWS_ONLY,
): TextClipboardContent | undefined {
  const copy = buildOfDrawnRows(conversation, startOffset, readers, {
    html: () => expect.fail("no reply part is long enough for the worker"),
    drawnText: () => expect.fail("no part is long enough for the worker"),
  }).buildWhile(() => true);
  return copy.isBuilt ? copy.content : expect.fail("a copy reading no body in full builds at once");
}

/**
 * The build of a copy as `copyOfDrawnRows` reads it, a long reply part's HTML made and a long part
 * read into its text by `worker`.
 */
function buildOfDrawnRows(
  conversation: Element,
  startOffset: number,
  readers: Pick<ConversationCopyRows, "rowText" | "rowBodyText">,
  worker: ConversationCopyRows["markdownWorker"],
): ConversationCopyBuild {
  const rows = [...conversation.querySelectorAll(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`)];
  const rowKeys = rows.map((_, index) => `row-${String(index)}`);
  const lastRow = rows.at(-1) ?? expect.fail("the conversation draws a row");
  return new ConversationCopyBuild({
    selection: {
      start: {
        at: "row",
        rowKey: rowKeys[0] ?? "",
        position: { path: [], characterOffset: startOffset },
      },
      end: {
        at: "row",
        rowKey: rowKeys.at(-1) ?? "",
        position: { path: [], characterOffset: lastRow.textContent.length },
      },
    },
    rowKeys,
    endRowElement: (rowKey) => rows[rowKeys.indexOf(rowKey)],
    ...readers,
    largeBodyRowIdOf: () => undefined,
    fullBodyReads: undefined,
    markdownWorker: worker,
  });
}

/** A reply drawn as a table of `rowCount` rows, each row's markdown its own line. */
function tableReply(rowCount: number): { readonly text: string; readonly rowLines: string[] } {
  const rowLines = Array.from({ length: rowCount }, (_, index) => {
    const lane = String(index);
    return `| lane-${lane} | **${lane}** rows |`;
  });
  return { text: ["| Lane | Rows |", "| --- | --- |", ...rowLines].join("\n"), rowLines };
}

/** A conversation of one reply row drawing `rows` as its table's body, under the table's head. */
function conversationWithTable(rows: string): HTMLElement {
  const conversation = document.createElement("div");
  conversation.innerHTML =
    `<div ${WINDOWED_ROW_INDEX_ATTRIBUTE}="0"><div ${COPY_FLAVOR_ATTRIBUTE}="markdown"><table>` +
    `<thead><tr><th>Lane</th><th>Rows</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  return conversation;
}

describe("a selection across the conversation", () => {
  it("copies each row's lines as drawn, and no control's label", () => {
    const asked = sampleUserMessageRow({ id: "asks", message: "line one\n\nline two" });
    const askedKind = classifyTranscriptRow(asked);
    if (askedKind === undefined) {
      throw new Error("a user message is a message kind");
    }
    const { container } = render(
      <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
        <div {...{ [WINDOWED_ROW_INDEX_ATTRIBUTE]: "0" }}>
          <MessageRow
            row={asked}
            rowKind={askedKind}
            agentHue={undefined}
            isSuperseded={false}
            density="expanded"
            footnotes={new FootnoteRegistry()}
            thinkingRow={undefined}
            editControl={undefined}
          />
        </div>
        <div {...{ [WINDOWED_ROW_INDEX_ATTRIBUTE]: "1" }}>
          <ToolRow
            row={sampleRunRow({
              id: "ran",
              type: "tool.result",
              actor: "Claude",
              payload: { toolName: "bash", contentLength: "first line\n  second line".length },
              content: { status: "available", body: "first line\n  second line" },
            })}
            agentHue={undefined}
            isSuperseded={false}
            density="expanded"
            footnotes={new FootnoteRegistry()}
            onDensityToggle={() => undefined}
          />
        </div>
      </FixtureBridgeProvider>,
    );
    const toolTime = container.querySelector(
      `[data-index="1"] ${SAMPLE_RUN_ROW_TIME_SELECTOR}`,
    )?.textContent;

    expect(copyOfDrawnRows(container)).toStrictEqual({
      text: [
        "line one\n\nline two",
        `Claude\n${toolTime ?? ""}\nbash\nfirst line\n  second line`,
      ].join("\n\n"),
    });
  });

  it("copies a call's large output in its control's place, from where the selection begins", () => {
    const output = "first line\n  second line";
    const ran = sampleRunRow({
      id: "ran",
      type: "tool.result",
      actor: "Claude",
      payload: { toolName: "bash", contentLength: LARGE_OUTPUT_BYTES },
      content: { status: "large", contentLength: LARGE_OUTPUT_BYTES },
    });
    // The control is drawn and never pressed, so no body is read and no store is reached.
    const fullBodyReads = new FullBodyReads({} as SessionStore, () =>
      expect.fail("a copy's reads are made before it builds"),
    );
    const { container } = render(
      <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
        <FullBodyReadsContext value={fullBodyReads}>
          <div {...{ [WINDOWED_ROW_INDEX_ATTRIBUTE]: "0" }}>
            <ToolRow
              row={ran}
              agentHue={undefined}
              isSuperseded={false}
              density="expanded"
              footnotes={new FootnoteRegistry()}
              onDensityToggle={() => undefined}
            />
          </div>
        </FullBodyReadsContext>
      </FixtureBridgeProvider>,
    );
    const row = container.firstElementChild ?? expect.fail("the call is drawn");
    const heading = document
      .createTreeWalker(row, NodeFilter.SHOW_TEXT, (node) =>
        node.textContent === "bash" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
      )
      .nextNode();
    expect(row.textContent).toContain("Show full output");

    // Begun inside the heading, past its first two letters.
    const copied = copyOfDrawnRows(
      container,
      characterOffsetWithin(row, heading ?? expect.fail("the heading is drawn"), 2),
      {
        rowText: () => ({ flavor: "text", text: `Claude\nbash\n${output}` }),
        rowBodyText: () => output,
      },
    );
    expect(copied).toStrictEqual({ text: `sh\n${output}` });
  });

  it("rebuilds a reply's code block as its fence, with no word from the block's corner", () => {
    const reply = sampleRunRow({
      id: "replies",
      type: "assistant.message",
      content: { status: "available", body: "Run it:\n\n```ts\nconst a = 1;\n```\n" },
    });
    const replyKind = classifyTranscriptRow(reply);
    if (replyKind === undefined) {
      throw new Error("an agent message is a message kind");
    }
    const { container } = render(
      <FixtureBridgeProvider fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}>
        <div {...{ [WINDOWED_ROW_INDEX_ATTRIBUTE]: "0" }}>
          <MessageRow
            row={reply}
            rowKind={replyKind}
            agentHue={undefined}
            isSuperseded={false}
            density="expanded"
            footnotes={new FootnoteRegistry()}
            thinkingRow={undefined}
            editControl={undefined}
            replyRowIds={["replies"]}
          />
        </div>
      </FixtureBridgeProvider>,
    );
    const copied = copyOfDrawnRows(container);
    expect(copied?.text).toBe("Run it:\n\n```ts\nconst a = 1;\n```");
    expect(copied?.html).not.toContain("Copy");
  });
});

describe("a long table's undrawn rows in a selection", () => {
  it("are read by the markdown worker in their spacer's place, as drawn rows are", async () => {
    // Long enough that the part is read off the page's thread.
    const { text, rowLines } = tableReply(160);
    const drawnRow = (line: string): string =>
      toHtml(markdownTableBodyRows(`| Lane | Rows |\n| --- | --- |\n${line}`));
    const firstLine = rowLines[0] ?? expect.fail("the table has rows");
    const lastLine = rowLines.at(-1) ?? expect.fail("the table has rows");
    const undrawnStart = text.indexOf(rowLines[1] ?? "");
    const undrawnEnd = text.lastIndexOf("\n");
    const spacer =
      `<tr ${MARKDOWN_SOURCE_START_ATTRIBUTE}="${String(undrawnStart)}" ` +
      `${MARKDOWN_SOURCE_END_ATTRIBUTE}="${String(undrawnEnd)}" ` +
      `${MARKDOWN_COLUMN_COUNT_ATTRIBUTE}="2"></tr>`;
    const drawnText = vi.fn<ConversationCopyRows["markdownWorker"]["drawnText"]>((tree, flavor) =>
      Promise.resolve(drawnTreeText(tree, flavor)),
    );
    const worker = {
      html: (markdown: string) => Promise.resolve(markdownToHtml(markdown)),
      drawnText,
    };
    const readers = { ...END_ROWS_ONLY, rowBodyText: () => text };
    const windowed = buildOfDrawnRows(
      conversationWithTable(drawnRow(firstLine) + spacer + drawnRow(lastLine)),
      0,
      readers,
      worker,
    );

    expect(windowed.buildWhile(() => true).isBuilt).toBe(false);
    const copied = await windowed.finish(
      windowCuttingEveryPart(),
      () => true,
      () => undefined,
    );
    const whole = await buildOfDrawnRows(
      conversationWithTable(rowLines.map(drawnRow).join("")),
      0,
      END_ROWS_ONLY,
      worker,
    ).finish(
      windowCuttingEveryPart(),
      () => true,
      () => undefined,
    );
    expect(drawnText).toHaveBeenCalledTimes(2);
    expect(copied).toStrictEqual(whole);
    expect(copied?.text).toMatch(/^\| lane-80 +\| \*\*80\*\* rows +\|$/mu);
  });
});

describe("a formula in a selection", () => {
  it("copies as its TeX source once, as text and as a math block", () => {
    const asText = conversationWithFormula("text", 'data-math=""');
    expect(copyOfDrawnRows(asText)).toStrictEqual({
      text: FORMULA_SOURCE,
    });

    // Begun on the drawn glyphs, past the hidden MathML that holds the source.
    const asMarkdown = conversationWithFormula("markdown", 'data-math=""');
    const firstGlyph = asMarkdown.querySelector(".katex-html .mord");
    const drawnRow = asMarkdown.firstElementChild;
    if (firstGlyph === null || drawnRow === null) {
      throw new Error("KaTeX drew no glyph");
    }
    const glyphOffset = characterOffsetWithin(drawnRow, firstGlyph, 0);
    expect(glyphOffset).toBeGreaterThan(0);
    expect(copyOfDrawnRows(asMarkdown, glyphOffset)?.text).toBe(
      ["```math", FORMULA_SOURCE, "```"].join("\n"),
    );
  });

  it("negative control: an unmarked drawing copies more than its source", () => {
    const unmarked = conversationWithFormula("text", 'class="other"');
    const copied = copyOfDrawnRows(unmarked)?.text;

    expect(copied).toContain(FORMULA_SOURCE);
    expect(copied).not.toBe(FORMULA_SOURCE);
  });
});
