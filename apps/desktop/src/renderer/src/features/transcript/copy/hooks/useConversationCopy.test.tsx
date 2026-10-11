// `⌘C` in a session: a selection in the conversation goes onto the clipboard through main, each
// message row's body joined in the order the rows are read, a reply's part as the markdown rebuilt
// from what was selected with a formatted flavor beside it; a long part's text is written first
// and its formatted flavor added once made, unless a newer copy took over; a selection in the
// message box is left to the platform's own copy. The rows are the real message rows inside the
// real windowed row, known to a real selection tracker on the conversation, drawn in a window of
// its own as every window the app opens is: its document is not the one the code runs in.

import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClipboardContent, TextClipboardContent } from "#shared/preload-api.js";
import { inThreadMarkdownWorker } from "#renderer/components/Markdown/worker/connection.test-support.js";
import {
  markdownWorker,
  PAGE_HTML_CHARACTER_LIMIT,
} from "#renderer/components/Markdown/worker/connection.js";
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
import { DrawnLongTables } from "../../rows/markdown/table-window/drawn-tables.js";
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

/** A reply too long for its formatted flavor to be made on the page's thread. */
const LONG_REPLY = `Long start ${"word ".repeat(PAGE_HTML_CHARACTER_LIMIT / 5)}long end`;

/** The person's closing message after the long reply. */
const CLOSING_MESSAGE = "thanks";

/**
 * The person's message, a long reply, and their closing message: a copy across all three reads the
 * reply as a whole row, whose formatted flavor the markdown worker makes after its text is read.
 */
const LONG_ROWS = [
  ROWS[0] ?? expect.fail("the person's message is a row"),
  sampleRunRow({
    id: "event-03",
    type: "assistant.message",
    content: { status: "available", body: LONG_REPLY },
  }),
  sampleUserMessageRow({ id: "event-04", message: CLOSING_MESSAGE }),
];

/** No log behind the rows: the store holds both, so nothing is read back. */
const NO_WINDOW = deriveTranscriptWindow([], {});

function Conversation(props: { readonly rows: typeof ROWS }): React.JSX.Element {
  const rowKeys = props.rows.map((row) => row.id);
  const [tracker] = useState(
    () =>
      new ViewportSelectionTracker({
        holdSelectedRows: () => {},
        logPositionOf: (rowKey) => rowKeys.indexOf(rowKey),
        drawRow: () => {},
      }),
  );
  const [drawnLongTables] = useState(() => new DrawnLongTables());
  const [rowElements] = useState(() => new Map<string, Element>());
  useConversationCopy({
    selectionTracker: tracker,
    // The rows the window's selection reaches, as the viewport's record of it holds them.
    selectedRowKeys: () =>
      rowKeys.filter((rowKey) => {
        const element = rowElements.get(rowKey);
        const selection = element?.ownerDocument.getSelection();
        return (
          element !== undefined &&
          selection !== null &&
          selection !== undefined &&
          selection.rangeCount > 0 &&
          selection.getRangeAt(0).intersectsNode(element)
        );
      }),
    rowSourceWindows: { unfurledWindow: NO_WINDOW, transcriptWindow: NO_WINDOW },
    // Only the long reply is ever a row between a copy's ends.
    rowText: (rowKey) =>
      rowKey === LONG_ROWS[1]?.id
        ? { flavor: "markdown", text: LONG_REPLY }
        : expect.fail(`${rowKey} is an end row`),
    rowBodyText: () => expect.fail("neither row draws a large body"),
    largeBodyRowIdOf: () => undefined,
    fullBodyReads: undefined,
    drawnLongTables,
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
      {props.rows.map((row, index) => {
        const rowKind = classifyTranscriptRow(row) ?? expect.fail(`${row.type} is a message`);
        return (
          <WindowedListRow
            key={row.id}
            as="div"
            rowIndex={index}
            totalRowCount={props.rows.length}
            rowRef={(element) => {
              if (element !== null) {
                rowElements.set(row.id, element);
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

/** What a clipboard holds: its text, which main reads for a copy's snapshot, and its html. */
interface HeldClipboard {
  text: string;
  html: string | undefined;
}

/**
 * The session's conversation of `rows` and message box in a window of their own, the clipboard it
 * copies to, every clipboard write that landed, and every formatted flavor main was asked to add, a
 * long part read into its text on the page.
 */
function renderSession(rows = ROWS): {
  readonly native: ReturnType<typeof createFixtureBridge>["bridge"]["native"];
  readonly clipboard: HeldClipboard;
  readonly copied: TextClipboardContent[];
  readonly formatted: TextClipboardContent[];
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
  const clipboard: HeldClipboard = { text: "the person's older copy", html: undefined };
  const copied: TextClipboardContent[] = [];
  const land = (content: ClipboardContent): void => {
    const text = "text" in content ? content : expect.fail("the conversation copies text");
    copied.push(text);
    clipboard.text = text.text;
    clipboard.html = text.html;
  };
  vi.spyOn(fixture.bridge.native, "copyToClipboard").mockImplementation(async (content) => {
    land(content);
  });
  // Main's snapshot is the text held; a later write lands only while the clipboard still holds it.
  vi.spyOn(fixture.bridge.native, "takeClipboardSnapshot").mockImplementation(async () => ({
    digest: clipboard.text,
  }));
  vi.spyOn(fixture.bridge.native, "copyToClipboardUnlessChanged").mockImplementation(
    async (content, since) => {
      if (since.digest !== clipboard.text) {
        return false;
      }
      land(content);
      return true;
    },
  );
  // happy-dom runs no worker; a long part is read on the page, as the worker reads it.
  const inThreadWorker = inThreadMarkdownWorker(sessionWindow);
  vi.spyOn(markdownWorker, "drawnText").mockImplementation((tree, flavor, tables) =>
    inThreadWorker.drawnText(tree, flavor, tables),
  );
  const formatted: TextClipboardContent[] = [];
  // The formatted flavor joins the text only while the clipboard still holds it, as main's does.
  vi.spyOn(fixture.bridge.native, "addClipboardFormatting").mockImplementation(async (content) => {
    formatted.push(content);
    if (clipboard.text !== content.text) {
      return false;
    }
    clipboard.html = content.html;
    return true;
  });
  const { container } = render(
    <FixtureBridgeProvider fixture={fixture}>
      <OwnerWindowProvider window={sessionWindow}>
        <LiveAnnouncerProvider>
          <Conversation rows={rows} />
          <textarea aria-label="Message" defaultValue="draft words" />
        </LiveAnnouncerProvider>
      </OwnerWindowProvider>
    </FixtureBridgeProvider>,
    { container: sessionDocument.body.appendChild(sessionDocument.createElement("div")) },
  );
  const box = container.querySelector("textarea") ?? expect.fail("the message box is drawn");
  return { native: fixture.bridge.native, clipboard, copied, formatted, box, sessionDocument };
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("⌘C in a session", () => {
  it("copies the selection in reading order while the message box holds none", async () => {
    const { clipboard, copied, box, sessionDocument } = renderSession();
    box.focus();
    box.setSelectionRange(0, 0);
    const start = textNodeHolding(sessionDocument, USER_MESSAGE);
    const end = textNodeHolding(sessionDocument, "keep its callers");
    sessionDocument.getSelection()?.setBaseAndExtent(start, 0, end, "keep".length);

    const event = fireEvent.copy(start);

    expect(event).toBe(false);
    // A copy built within its first slice writes both flavors at once; one that outlasts it, as
    // under load, writes its text, then adds the formatted flavor beside it.
    await vi.waitFor(() => {
      expect(clipboard.html).toBeDefined();
    });
    // The author lines, stamps and Copy controls between the bodies are left out; the reply's
    // part is the markdown that drew it, cut where the selection ended.
    expect(copied.map((content) => content.text)).toStrictEqual([
      `${USER_MESSAGE}\n\nHere is **the plan**:\n\n- rename the reader\n- keep`,
    ]);
    expect(clipboard.text).toBe(copied[0]?.text);
    expect(clipboard.html).toContain("<strong>the plan</strong>");
    expect(clipboard.html).toContain(`<p>${USER_MESSAGE}</p>`);
  });

  it("writes a long part's text at once, and adds its formatting unless a newer copy took over", async () => {
    const { copied, formatted, sessionDocument } = renderSession(LONG_ROWS);
    const workerAnswers: ((html: string) => void)[] = [];
    vi.spyOn(markdownWorker, "html").mockImplementation(
      () => new Promise((resolve) => workerAnswers.push(resolve)),
    );
    const selection = sessionDocument.getSelection() ?? expect.fail("the window has a selection");
    const selectLongReply = (): Text => {
      const start = textNodeHolding(sessionDocument, USER_MESSAGE);
      const end = textNodeHolding(sessionDocument, CLOSING_MESSAGE);
      selection.setBaseAndExtent(start, 0, end, end.length);
      return start;
    };

    fireEvent.copy(selectLongReply());
    // The text is written while the worker makes the formatting.
    await vi.waitFor(() => {
      expect([workerAnswers.length, copied.length]).toStrictEqual([1, 1]);
    });
    expect(copied[0]).toStrictEqual({
      text: `${USER_MESSAGE}\n\n${LONG_REPLY}\n\n${CLOSING_MESSAGE}`,
    });
    // A newer copy, short enough to be written whole at once, lands while the first's formatting
    // is made.
    const message = textNodeHolding(sessionDocument, USER_MESSAGE);
    selection.setBaseAndExtent(message, 0, textNodeHolding(sessionDocument, "Long start"), 2);
    fireEvent.copy(message);
    await vi.waitFor(() => {
      expect(copied).toHaveLength(2);
    });
    workerAnswers[0]?.("<p>the first copy's formatting</p>");
    fireEvent.copy(selectLongReply());
    await vi.waitFor(() => {
      expect(workerAnswers).toHaveLength(2);
    });
    workerAnswers[1]?.("<p>the third copy's formatting</p>");

    await vi.waitFor(() => {
      expect(formatted).toHaveLength(1);
    });
    expect(copied.map((content) => content.text)).toStrictEqual([
      `${USER_MESSAGE}\n\n${LONG_REPLY}\n\n${CLOSING_MESSAGE}`,
      `${USER_MESSAGE}\n\nLo`,
      `${USER_MESSAGE}\n\n${LONG_REPLY}\n\n${CLOSING_MESSAGE}`,
    ]);
    expect(formatted[0]?.html).toContain("<p>the third copy's formatting</p>");
  });

  it("adds a long part's formatting only once its text write has landed", async () => {
    const { native, copied, formatted, sessionDocument } = renderSession(LONG_ROWS);
    vi.spyOn(markdownWorker, "html").mockResolvedValue("<p>made by the worker</p>");
    const textWrites: (() => void)[] = [];
    vi.spyOn(native, "copyToClipboardUnlessChanged").mockImplementationOnce(
      (content) =>
        new Promise((resolve) => {
          textWrites.push(() => {
            copied.push("text" in content ? content : expect.fail("the copy is text"));
            resolve(true);
          });
        }),
    );
    const start = textNodeHolding(sessionDocument, USER_MESSAGE);
    const end = textNodeHolding(sessionDocument, CLOSING_MESSAGE);
    sessionDocument.getSelection()?.setBaseAndExtent(start, 0, end, end.length);

    fireEvent.copy(start);
    await vi.waitFor(() => {
      expect(markdownWorker.html).toHaveBeenCalledOnce();
    });
    // The worker has answered; the text write has not landed, so nothing is added yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(formatted).toStrictEqual([]);
    textWrites[0]?.();

    await vi.waitFor(() => {
      expect(formatted).toHaveLength(1);
    });
    expect(copied.map((content) => content.text)).toStrictEqual([
      `${USER_MESSAGE}\n\n${LONG_REPLY}\n\n${CLOSING_MESSAGE}`,
    ]);
  });

  it("leaves a copy another app made while a long part was read standing, and says nothing", async () => {
    const { native, clipboard, copied, formatted, sessionDocument } = renderSession(LONG_ROWS);
    vi.spyOn(markdownWorker, "html").mockResolvedValue("<p>made by the worker</p>");
    // Another app copies just after the key is pressed, before the long part's text is read.
    vi.spyOn(native, "takeClipboardSnapshot").mockImplementationOnce(async () => {
      const since = { digest: clipboard.text };
      clipboard.text = "another app's copy";
      return since;
    });
    const start = textNodeHolding(sessionDocument, USER_MESSAGE);
    const end = textNodeHolding(sessionDocument, CLOSING_MESSAGE);
    sessionDocument.getSelection()?.setBaseAndExtent(start, 0, end, end.length);

    fireEvent.copy(start);
    await vi.waitFor(() => {
      expect(markdownWorker.html).toHaveBeenCalledOnce();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect([clipboard.text, copied, formatted]).toStrictEqual(["another app's copy", [], []]);
    expect(sessionDocument.body.textContent).not.toContain("Could not copy");
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
