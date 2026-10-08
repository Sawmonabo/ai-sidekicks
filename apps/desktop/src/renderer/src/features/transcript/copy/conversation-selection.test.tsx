// What a selection across the conversation copies, read from the rows as they are drawn.

import { render } from "@testing-library/react";
import { renderToString } from "katex";
import { describe, expect, it } from "vitest";

import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import {
  SAMPLE_RUN_ROW_TIME_SELECTOR,
  sampleRunRow,
} from "#test/helpers/transcript-event-row-samples.js";
import { classifyTranscriptRow } from "../rows/kind.js";
import { MessageRow } from "../rows/MessageRow.js";
import { ToolRow } from "../rows/ToolRow.js";
import { FootnoteRegistry } from "../rows/markdown/footnotes/registry.js";
import {
  COPY_FLAVOR_ATTRIBUTE,
  type CopyFlavor,
  readConversationSelection,
} from "./conversation-selection.js";

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

/** A range over everything in `conversation`. */
function everythingIn(conversation: Element): Range {
  const range = document.createRange();
  range.selectNodeContents(conversation);
  return range;
}

describe("a selection across the conversation", () => {
  it("copies each row's lines as drawn, and no control's label", () => {
    const asked = sampleRunRow({
      id: "asks",
      type: "user.message",
      summary: "line one\n\nline two",
    });
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
              summary: "Ran pnpm test",
              payload: { toolName: "bash" },
            })}
            agentHue={undefined}
            isSuperseded={false}
            density="expanded"
            footnotes={new FootnoteRegistry()}
            content={{ status: "available", body: "first line\n  second line" }}
            onDensityToggle={() => undefined}
          />
        </div>
      </FixtureBridgeProvider>,
    );
    const toolTime = container.querySelector(
      `[data-index="1"] ${SAMPLE_RUN_ROW_TIME_SELECTOR}`,
    )?.textContent;
    const everything = document.createRange();
    everything.selectNodeContents(container);

    expect(readConversationSelection(everything, container)).toStrictEqual({
      text: [
        "line one\n\nline two",
        `Claude\n${toolTime ?? ""}\nbash Ran pnpm test\nfirst line\n  second line`,
      ].join("\n\n"),
    });
  });

  it("rebuilds a reply's code block as its fence, with no word from the block's corner", () => {
    const reply = sampleRunRow({ id: "replies", type: "assistant.message" });
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
            content={{ status: "available", body: "Run it:\n\n```ts\nconst a = 1;\n```\n" }}
            replyRowIds={["replies"]}
          />
        </div>
      </FixtureBridgeProvider>,
    );
    const everything = document.createRange();
    everything.selectNodeContents(container);

    const copied = readConversationSelection(everything, container);
    expect(copied?.text).toBe("Run it:\n\n```ts\nconst a = 1;\n```");
    expect(copied?.html).not.toContain("Copy");
  });
});

describe("a formula in a selection", () => {
  it("copies as its TeX source once, as text and as a math block", () => {
    const asText = conversationWithFormula("text", 'data-math=""');
    expect(readConversationSelection(everythingIn(asText), asText)).toStrictEqual({
      text: FORMULA_SOURCE,
    });

    // Begun on the drawn glyphs, past the hidden MathML that holds the source.
    const asMarkdown = conversationWithFormula("markdown", 'data-math=""');
    const fromGlyphs = everythingIn(asMarkdown);
    const firstGlyph = asMarkdown.querySelector(".katex-html .mord");
    if (firstGlyph === null) {
      throw new Error("KaTeX drew no glyph");
    }
    fromGlyphs.setStart(firstGlyph, 0);
    expect(readConversationSelection(fromGlyphs, asMarkdown)?.text).toBe(
      ["```math", FORMULA_SOURCE, "```"].join("\n"),
    );
  });

  it("negative control: an unmarked drawing copies more than its source", () => {
    const unmarked = conversationWithFormula("text", 'class="other"');
    const copied = readConversationSelection(everythingIn(unmarked), unmarked)?.text;

    expect(copied).toContain(FORMULA_SOURCE);
    expect(copied).not.toBe(FORMULA_SOURCE);
  });
});
