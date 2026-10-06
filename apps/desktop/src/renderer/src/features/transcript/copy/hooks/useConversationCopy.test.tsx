// `⌘C` in a session: a selection in the conversation goes onto the clipboard through main, each
// message row's body joined in the order the rows are read, a reply's part as the markdown rebuilt
// from what was selected with a formatted flavor beside it; a selection in the message box is left
// to the platform's own copy. The rows are the real message rows inside the real windowed row.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ClipboardContent } from "#shared/preload-api.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { WindowedListRow } from "#renderer/components/WindowedListRow/WindowedListRow.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { sampleRunRow } from "#test/helpers/transcript-event-row-samples.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { MessageRow } from "../../rows/MessageRow.js";
import { classifyTranscriptRow } from "../../rows/kind.js";
import { FootnoteRegistry } from "../../rows/markdown/footnotes/registry.js";
import { useConversationCopy } from "./useConversationCopy.js";

const USER_MESSAGE = "please rename the reader";
const REPLY = "Here is **the plan**:\n\n- rename the reader\n- keep its callers";

/** The two rows as the conversation draws them: the person's message, then the agent's reply. */
const ROWS = [
  sampleRunRow({ id: "event-01", type: "user.message", summary: USER_MESSAGE }),
  sampleRunRow({ id: "event-02", type: "assistant.message" }),
];

function Conversation(): React.JSX.Element {
  const copySelection = useConversationCopy();
  return (
    <div onCopy={copySelection}>
      {ROWS.map((row, index) => {
        const rowKind = classifyTranscriptRow(row) ?? expect.fail(`${row.type} is a message`);
        return (
          <WindowedListRow key={row.id} as="div" rowIndex={index} totalRowCount={ROWS.length}>
            <MessageRow
              row={row}
              rowKind={rowKind}
              agentHue={undefined}
              isSuperseded={false}
              density="expanded"
              footnotes={new FootnoteRegistry()}
              thinkingRow={undefined}
              content={{ status: "available", body: REPLY }}
              editControl={undefined}
            />
          </WindowedListRow>
        );
      })}
    </div>
  );
}

/** The session's conversation and message box, and every clipboard write main was asked for. */
function renderSession(): {
  readonly copied: ClipboardContent[];
  readonly box: HTMLTextAreaElement;
} {
  const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
  const copied: ClipboardContent[] = [];
  vi.spyOn(fixture.bridge.native, "copyToClipboard").mockImplementation(async (content) => {
    copied.push(content);
  });
  const { container } = render(
    <FixtureBridgeProvider fixture={fixture}>
      <LiveAnnouncerProvider>
        <Conversation />
        <textarea aria-label="Message" defaultValue="draft words" />
      </LiveAnnouncerProvider>
    </FixtureBridgeProvider>,
  );
  const box = container.querySelector("textarea") ?? expect.fail("the message box is drawn");
  return { copied, box };
}

/** The text node holding `text`, so a selection can start or end inside it. */
function textNodeHolding(text: string): Text {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.textContent?.includes(text) === true) {
      return node as Text;
    }
  }
  return expect.fail(`no text node holds ${text}`);
}

describe("⌘C in a session", () => {
  it("copies the conversation's selection in reading order while the message box holds none", () => {
    const { copied, box } = renderSession();
    box.focus();
    box.setSelectionRange(0, 0);
    const start = textNodeHolding(USER_MESSAGE);
    const end = textNodeHolding("keep its callers");
    document.getSelection()?.setBaseAndExtent(start, 0, end, "keep".length);

    const event = fireEvent.copy(start);

    expect(event).toBe(false);
    expect(copied).toHaveLength(1);
    const [content] = copied;
    // The author lines, stamps and Copy controls between the bodies are left out; the reply's
    // part is the markdown that drew it, cut where the selection ended.
    expect(content?.text).toBe(
      `${USER_MESSAGE}\n\nHere is **the plan**:\n\n- rename the reader\n- keep`,
    );
    expect(content?.html).toContain("<strong>the plan</strong>");
    expect(content?.html).toContain(`<p>${USER_MESSAGE}</p>`);
  });

  it("leaves a selection in the message box to the platform's own copy", () => {
    const { copied, box } = renderSession();
    box.focus();
    box.setSelectionRange(0, "draft".length);

    const event = fireEvent.copy(box);

    expect(event).toBe(true);
    expect(copied).toStrictEqual([]);
  });
});
