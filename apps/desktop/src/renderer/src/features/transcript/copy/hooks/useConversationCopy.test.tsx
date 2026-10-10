// `⌘C` in a session: a selection in the conversation goes onto the clipboard through main, each
// message row's body joined in the order the rows are read, a reply's part as the markdown rebuilt
// from what was selected with a formatted flavor beside it; a selection in the message box is left
// to the platform's own copy. The rows are the real message rows inside the real windowed row,
// known to a real selection tracker on the conversation, drawn in a window of its own as every
// window the app opens is: its document is not the one the code runs in.

import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { TextClipboardContent } from "#shared/preload-api.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { OwnerWindowProvider } from "#renderer/components/OwnerWindow/OwnerWindowProvider.js";
import { WindowedListRow } from "#renderer/components/WindowedListRow/WindowedListRow.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { sampleRunRow, sampleUserMessageRow } from "#test/helpers/transcript/event-row-samples.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { MessageRow } from "../../rows/MessageRow.js";
import { classifyTranscriptRow } from "../../rows/kind.js";
import { FootnoteRegistry } from "../../rows/markdown/footnotes/registry.js";
import { ViewportSelectionTracker } from "../../viewport/selection/tracker.js";
import { deriveTranscriptWindow } from "../../window/transcript-window.js";
import { useConversationCopy } from "./useConversationCopy.js";

const USER_MESSAGE = "please rename the reader";
const REPLY = "Here is **the plan**:\n\n- rename the reader\n- keep its callers";

/** The two rows as the conversation draws them: the person's message, then the agent's reply. */
const ROWS = [
  sampleUserMessageRow({ id: "event-01", message: USER_MESSAGE }),
  sampleRunRow({
    id: "event-02",
    type: "assistant.message",
    content: { status: "available", body: REPLY },
  }),
];

const ROW_KEYS = ROWS.map((row) => row.id);

/** No log behind the rows: the store holds both, so nothing is read back. */
const NO_WINDOW = deriveTranscriptWindow([]);

function Conversation(): React.JSX.Element {
  const [tracker] = useState(
    () =>
      new ViewportSelectionTracker({
        holdSelectedRows: () => {},
        logPositionOf: (rowKey) => ROW_KEYS.indexOf(rowKey),
        logEdgeRowKey: (side) => (side === "head" ? ROW_KEYS[0] : ROW_KEYS.at(-1)),
        drawRow: () => {},
      }),
  );
  useConversationCopy({
    selectionTracker: tracker,
    selectedRowKeys: () => ROW_KEYS,
    rowSourceWindows: { unfurledWindow: NO_WINDOW, transcriptWindow: NO_WINDOW },
    rowText: () => expect.fail("both rows are end rows"),
    rowBodyText: () => expect.fail("neither row draws a table or a large body"),
    largeBodyRowIdOf: () => undefined,
    fullBodyReads: undefined,
    history: undefined,
  });
  return (
    <div
      ref={(element) => {
        if (element === null) {
          tracker.detach();
          return;
        }
        tracker.attach(element);
      }}
    >
      {ROWS.map((row, index) => {
        const rowKind = classifyTranscriptRow(row) ?? expect.fail(`${row.type} is a message`);
        return (
          <WindowedListRow
            key={row.id}
            as="div"
            rowIndex={index}
            totalRowCount={ROWS.length}
            rowRef={(element) => {
              if (element !== null) {
                tracker.addRow(element, row.id);
              }
            }}
          >
            <MessageRow
              row={row}
              rowKind={rowKind}
              agentHue={undefined}
              isSuperseded={false}
              density="expanded"
              footnotes={new FootnoteRegistry()}
              thinkingRow={undefined}
              editControl={undefined}
            />
          </WindowedListRow>
        );
      })}
    </div>
  );
}

/**
 * The session's conversation and message box in a window of their own, and every clipboard write
 * main was asked for.
 */
function renderSession(): {
  readonly copied: TextClipboardContent[];
  readonly box: HTMLTextAreaElement;
  readonly sessionDocument: Document;
} {
  const sessionWindow =
    document.body.appendChild(document.createElement("iframe")).contentWindow ??
    expect.fail("the frame has a window");
  // happy-dom schedules no tasks; a copy that outlasts the slice it starts in builds on in them.
  Object.defineProperty(sessionWindow, "scheduler", {
    value: { postTask: async (task: () => unknown) => task() },
  });
  const sessionDocument = sessionWindow.document;
  const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
  const copied: TextClipboardContent[] = [];
  vi.spyOn(fixture.bridge.native, "copyToClipboard").mockImplementation(async (content) => {
    copied.push("text" in content ? content : expect.fail("the conversation copies text"));
  });
  const { container } = render(
    <FixtureBridgeProvider fixture={fixture}>
      <OwnerWindowProvider window={sessionWindow}>
        <LiveAnnouncerProvider>
          <Conversation />
          <textarea aria-label="Message" defaultValue="draft words" />
        </LiveAnnouncerProvider>
      </OwnerWindowProvider>
    </FixtureBridgeProvider>,
    { container: sessionDocument.body.appendChild(sessionDocument.createElement("div")) },
  );
  const box = container.querySelector("textarea") ?? expect.fail("the message box is drawn");
  return { copied, box, sessionDocument };
}

/** The text node in `ownerDocument` holding `text`, so a selection can start or end inside it. */
function textNodeHolding(ownerDocument: Document, text: string): Text {
  const walker = ownerDocument.createTreeWalker(ownerDocument.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.textContent?.includes(text) === true) {
      return node as Text;
    }
  }
  return expect.fail(`no text node holds ${text}`);
}

describe("⌘C in a session", () => {
  it("copies the conversation's selection in reading order while the message box holds none", async () => {
    const { copied, box, sessionDocument } = renderSession();
    box.focus();
    box.setSelectionRange(0, 0);
    const start = textNodeHolding(sessionDocument, USER_MESSAGE);
    const end = textNodeHolding(sessionDocument, "keep its callers");
    sessionDocument.getSelection()?.setBaseAndExtent(start, 0, end, "keep".length);

    const event = fireEvent.copy(start);

    expect(event).toBe(false);
    await vi.waitFor(() => {
      expect(copied).toHaveLength(1);
    });
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
