// The terminal pane over a fake daemon wire: the shell list draws one tab per shell and a
// middle-click closes one, a session read empty opens one shell and no more; a close of a shell
// another device holds is asked first and forced on the answer, and a moved tab sends its order; an
// exited shell reads its exit line and one that did not start reads its cause with `Try again`; the
// holding pane tells the shell its grid's size; a paste goes into the shell's input as one paste;
// on a re-opened output stream what the ended one handed back goes first, even when it comes
// after the re-open, then the keys typed since the end, across a switch of tabs, which keeps the
// shell's stream, and a pane closed meanwhile; and what an input hands back after its pane closed
// first goes first on the next pane's input.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { TerminalId, TerminalListEntry } from "@ai-sidekicks/contracts/terminal";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { TERMINAL_LIST_STREAM, TERMINAL_OUTPUT_STREAM } from "#shared/daemon/streams.js";
import type { UnsentShellWrite } from "#shared/preload-api.js";
import type { ShellOutputSubject } from "#renderer/services/daemon/terminal/output.js";
import { bridgeWrapper, withAnnouncer } from "#test/helpers/app/frame-fixtures.js";
import { RecordedShellWire } from "#renderer/services/daemon/terminal/output.test-support.js";
import { SessionStore } from "#renderer/store/session/store.js";
import { UNREPORTED_MAIN_PROCESS_STATE } from "#renderer/store/window/main-process-state.js";
import { WindowStore } from "#renderer/store/window/store.js";
import {
  emulatorElementOf,
  reclaimComponentHolds,
  typeOneCharacter,
} from "../../emulator/components/XtermMountPoint.test-support.js";
import { SessionTerminalPane } from "./SessionTerminalPane.js";

const SESSION_ID = "019b7b30-0280-79a4-8110-cca0117a0135";
const THIS_DEVICE_ID = "019b7b30-0280-79a4-8110-cca0117a0137" as DeviceId;
const OTHER_DEVICE_ID = "019b7b30-0280-79a4-8110-cca0117a0138" as DeviceId;
const FIRST_SUBSCRIPTION_ID = "019b7b30-0280-79a4-8110-cca0117a0141" as SubscriptionId;
const SECOND_SUBSCRIPTION_ID = "019b7b30-0280-79a4-8110-cca0117a0142" as SubscriptionId;
const THIRD_SUBSCRIPTION_ID = "019b7b30-0280-79a4-8110-cca0117a0143" as SubscriptionId;
const FOURTH_SUBSCRIPTION_ID = "019b7b30-0280-79a4-8110-cca0117a0144" as SubscriptionId;
const TERMINAL_IDS = ["terminal-1", "terminal-2"] as const;
// What the client's queue had not sent when a stream ended: keys, then a paste's last part.
const QUEUED_WRITES: readonly UnsentShellWrite[] = [
  { data: "ls" },
  { data: "tail", paste: { pasteId: "019b7b30-0280-79a4-8110-cca0117a0151", isLastPart: true } },
];

// The emulator's first fit, in a box jsdom gives no size, keeps xterm's own default grid.
const UNSIZED_GRID = { columns: 80, rows: 24 };

afterEach(() => {
  reclaimComponentHolds(TERMINAL_IDS);
});

describe("the terminal pane's tab strip", () => {
  it("draws a tab per shell, closes one on a middle-click, and opens a shell only for a first read with none", async () => {
    const wire = new RecordedShellWire({ "terminal.open": () => ({ terminalId: "terminal-1" }) });
    const { container } = mountPane(wire);
    listShells(wire, []);
    await waitFor(() => {
      expect(wire.paramsOf("terminal.open")).toHaveLength(1);
    });

    listShells(wire, [shellEntry("terminal-1")]);
    listShells(wire, [shellEntry("terminal-1"), shellEntry("terminal-2")]);
    const tabs = container.querySelectorAll(".meridian-tab");
    expect(tabs).toHaveLength(2);
    const secondTab = tabs[1];
    if (secondTab === undefined) {
      throw new Error("the strip drew no second tab");
    }
    fireEvent(secondTab, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await waitFor(() => {
      expect(wire.paramsOf("terminal.close")).toStrictEqual([
        { sessionId: SESSION_ID, terminalId: "terminal-2" },
      ]);
    });

    listShells(wire, []);
    expect(await screen.findByText("No active terminal.")).toBeDefined();
    expect(wire.paramsOf("terminal.open")).toHaveLength(1);
  });
});

describe("closing and moving a shell's tab", () => {
  it("asks before closing a shell another device holds, and closes it with force on the answer", async () => {
    const wire = new RecordedShellWire();
    mountPane(wire);
    listShells(wire, [
      shellEntry("terminal-1"),
      shellEntry("terminal-2", { holder: { holderDeviceId: OTHER_DEVICE_ID }, leaseVersion: 1 }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Close zsh terminal-2" }));
    expect(await screen.findByText("Another device holds zsh terminal-2. Close it?")).toBeDefined();
    expect(wire.paramsOf("terminal.close")).toStrictEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(wire.paramsOf("terminal.close")).toStrictEqual([
        { sessionId: SESSION_ID, terminalId: "terminal-2", force: true },
      ]);
    });
    expect(screen.queryByText("Another device holds zsh terminal-2. Close it?")).toBeNull();
  });

  it("sends a moved tab's new order once", async () => {
    const wire = new RecordedShellWire();
    mountPane(wire);
    listShells(wire, [shellEntry("terminal-1"), shellEntry("terminal-2")]);
    fireEvent.keyDown(screen.getByRole("button", { name: "zsh terminal-1" }), {
      key: "ContextMenu",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move right" }));
    await waitFor(() => {
      expect(wire.paramsOf("terminal.reorder")).toStrictEqual([
        { sessionId: SESSION_ID, terminalIds: ["terminal-2", "terminal-1"] },
      ]);
    });
  });
});

describe("a shell's status lines", () => {
  it("reads an exited shell's code under its output, and a shell that did not start opens another on Try again", async () => {
    const wire = new RecordedShellWire({ "terminal.open": () => ({ terminalId: "terminal-3" }) });
    mountPane(wire);
    listShells(wire, [
      shellEntry("terminal-1", { status: { state: "exited", exitCode: 3 } }),
      shellEntry("terminal-2", { status: { state: "didNotStart", cause: "no such file" } }),
    ]);
    expect(await screen.findByText("Exited with code 3")).toBeDefined();

    fireEvent.click(screen.getByText("zsh terminal-2"));
    expect(await screen.findByText("Couldn't start terminal · no such file")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(wire.paramsOf("terminal.open")).toHaveLength(1);
    });
  });
});

describe("the shell's input and size", () => {
  it("tells the shell the grid's size only once this device holds it", async () => {
    const wire = new RecordedShellWire();
    mountPane(wire);
    listShells(wire, [shellEntry("terminal-1")]);
    await waitFor(() => {
      expect(wire.opensOf(TERMINAL_OUTPUT_STREAM)).toHaveLength(1);
    });
    expect(wire.paramsOf("terminal.resize")).toStrictEqual([]);

    listShells(wire, [
      shellEntry("terminal-1", { holder: { holderDeviceId: THIS_DEVICE_ID }, leaseVersion: 1 }),
    ]);
    await waitFor(() => {
      expect(wire.paramsOf("terminal.resize")).toStrictEqual([
        { sessionId: SESSION_ID, terminalId: "terminal-1", ...UNSIZED_GRID },
      ]);
    });
  });

  it("types a paste as one paste, with its line breaks as carriage returns", async () => {
    const wire = new RecordedShellWire();
    const { container } = mountPane(wire);
    listShells(wire, [shellEntry("terminal-1")]);
    await openShellAs(wire, 1, FIRST_SUBSCRIPTION_ID);

    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (format: string) => (format === "text/plain" ? "echo one\necho two" : "") },
    });
    textareaOf(container).dispatchEvent(paste);
    await waitFor(() => {
      expect(wire.shellInputs).toStrictEqual([
        { outputSubscriptionId: FIRST_SUBSCRIPTION_ID, kind: "paste", data: "echo one\recho two" },
      ]);
    });
  });

  it("sends what was held for a shell in the order typed across a switch of tabs and a closed pane", async () => {
    const wire = new RecordedShellWire();
    const { container, unmount } = mountPane(wire);
    listShells(wire, [shellEntry("terminal-1"), shellEntry("terminal-2")]);
    await openShellAs(wire, 1, FIRST_SUBSCRIPTION_ID);
    typeOneCharacter(emulatorElementOf(container));
    await waitFor(() => {
      expect(writtenKeys(wire)).toStrictEqual([["a", FIRST_SUBSCRIPTION_ID]]);
    });
    // The stream's end is told at once and its input's hand-back comes later: keys typed before
    // and after the re-open wait for it.
    endShellStream(wire);
    typeOneCharacter(emulatorElementOf(container));
    await openShellAs(wire, 2, SECOND_SUBSCRIPTION_ID);
    typeOneCharacter(emulatorElementOf(container));

    // A switch away and back keeps the shell's stream, and nothing goes while that input is pending.
    fireEvent.click(screen.getByText("zsh terminal-2"));
    fireEvent.click(screen.getByText("zsh terminal-1"));
    expect(shellOpens(wire)).toHaveLength(2);
    expect(shellOpens(wire)[1]?.isClosed).toBe(false);
    typeOneCharacter(emulatorElementOf(container));
    expect(wire.shellInputs).toHaveLength(1);

    // The paste's rest and the keys sent before the end come back, then the input is told closed:
    // they go first on the open stream, the held keys after them, the key typed since last.
    act(() => {
      wire.handBack(FIRST_SUBSCRIPTION_ID, { kind: "queued", writes: QUEUED_WRITES });
      wire.handBack(FIRST_SUBSCRIPTION_ID, { kind: "keys", data: "b" });
      wire.tellClosed(FIRST_SUBSCRIPTION_ID);
    });
    expect(wire.shellInputs).toStrictEqual([
      { outputSubscriptionId: FIRST_SUBSCRIPTION_ID, kind: "keys", data: "a" },
      { outputSubscriptionId: SECOND_SUBSCRIPTION_ID, kind: "resubmit", writes: QUEUED_WRITES },
      { outputSubscriptionId: SECOND_SUBSCRIPTION_ID, kind: "keys", data: "b" },
      { outputSubscriptionId: SECOND_SUBSCRIPTION_ID, kind: "keys", data: "a" },
      { outputSubscriptionId: SECOND_SUBSCRIPTION_ID, kind: "keys", data: "a" },
      { outputSubscriptionId: SECOND_SUBSCRIPTION_ID, kind: "keys", data: "a" },
    ]);

    // A pane closed for good while an ended input may still hand back lets its stream go too, and
    // once that input and the pane's own are told closed, what waits goes on a stream opened for
    // it alone after the output the pane drew, then closed.
    endShellStream(wire);
    await openShellAs(wire, 3, THIRD_SUBSCRIPTION_ID);
    typeOneCharacter(emulatorElementOf(container));
    unmount();
    expect(shellOpens(wire)[2]?.isClosed).toBe(true);
    act(() => {
      wire.tellClosed(SECOND_SUBSCRIPTION_ID);
    });
    expect(shellOpens(wire)).toHaveLength(3);
    act(() => {
      wire.tellClosed(THIRD_SUBSCRIPTION_ID);
    });
    await openShellAs(wire, 4, FOURTH_SUBSCRIPTION_ID);
    expect(shellOpens(wire)[3]?.params).toStrictEqual({
      sessionId: SESSION_ID,
      terminalId: "terminal-1",
      afterOffset: 1,
    });
    expect(wire.shellInputs.slice(6)).toStrictEqual([
      { outputSubscriptionId: FOURTH_SUBSCRIPTION_ID, kind: "keys", data: "a" },
    ]);
    expect(shellOpens(wire)[3]?.isClosed).toBe(true);
  });

  it("keeps what an input hands back after its pane closed before its stream's end, and sends it first on the next pane's input", async () => {
    const wire = new RecordedShellWire();
    const firstPane = mountPane(wire);
    listShells(wire, [shellEntry("terminal-1")]);
    await openShellAs(wire, 1, FIRST_SUBSCRIPTION_ID);
    typeOneCharacter(emulatorElementOf(firstPane.container));
    await waitFor(() => {
      expect(writtenKeys(wire)).toStrictEqual([["a", FIRST_SUBSCRIPTION_ID]]);
    });
    // The helper ended the stream, but the pane closed before the end reached it.
    firstPane.unmount();
    expect(shellOpens(wire)[0]?.isClosed).toBe(true);

    const nextPane = mountPane(wire);
    listShells(wire, [shellEntry("terminal-1")]);
    await openShellAs(wire, 2, SECOND_SUBSCRIPTION_ID);
    typeOneCharacter(emulatorElementOf(nextPane.container));
    expect(wire.shellInputs).toHaveLength(1);

    act(() => {
      wire.handBack(FIRST_SUBSCRIPTION_ID, { kind: "queued", writes: QUEUED_WRITES });
      wire.tellClosed(FIRST_SUBSCRIPTION_ID);
    });
    expect(wire.shellInputs).toStrictEqual([
      { outputSubscriptionId: FIRST_SUBSCRIPTION_ID, kind: "keys", data: "a" },
      { outputSubscriptionId: SECOND_SUBSCRIPTION_ID, kind: "resubmit", writes: QUEUED_WRITES },
      { outputSubscriptionId: SECOND_SUBSCRIPTION_ID, kind: "keys", data: "a" },
    ]);
  });
});

// Ends terminal-1's newest output stream after a frame; its input's hand-back is left to the
// case.
function endShellStream(wire: RecordedShellWire): void {
  act(() => {
    const newestOpen = shellOpens(wire).at(-1);
    if (newestOpen === undefined) {
      throw new Error("terminal-1's output stream was never opened");
    }
    newestOpen.deliver(
      {
        changes: [
          {
            kind: "output",
            sessionId: SESSION_ID,
            terminalId: "terminal-1",
            data: { $bytes: 0 },
            cursor: 1,
          },
        ],
      },
      [new TextEncoder().encode("$")],
    );
    newestOpen.end({ reason: "failed", message: "the link went away" });
  });
}

/** Every open of terminal-1's output stream, oldest first. */
function shellOpens(wire: RecordedShellWire): ReturnType<RecordedShellWire["opensOf"]> {
  return wire
    .opensOf(TERMINAL_OUTPUT_STREAM)
    .filter((open) => (open.params as ShellOutputSubject).terminalId === "terminal-1");
}

// Once terminal-1's output stream has been opened `openCount` times, the daemon acknowledges the
// newest open as `subscriptionId`. A stream that delivered is opened again after a wait once it
// ends, so this waits for it.
async function openShellAs(
  wire: RecordedShellWire,
  openCount: number,
  subscriptionId: SubscriptionId,
): Promise<void> {
  await vi.waitFor(() => {
    expect(shellOpens(wire)).toHaveLength(openCount);
  });
  act(() => {
    shellOpens(wire).at(-1)?.opened(subscriptionId);
  });
}

/** The pane for the session, on this device, over the fake wire. */
function mountPane(wire: RecordedShellWire): ReturnType<typeof render> {
  const frameStore = new WindowStore();
  frameStore.publishMainProcessReport({
    ...UNREPORTED_MAIN_PROCESS_STATE,
    negotiation: {
      compatible: true,
      deviceId: THIS_DEVICE_ID,
      daemonProtocolVersion: "1",
      appProtocolVersion: "1",
      daemonSupportedProtocols: [],
      reason: undefined,
      behind: undefined,
    },
  });
  return render(
    <SessionTerminalPane
      bridge={wire.bridge}
      sessionStore={new SessionStore({ sessionId: SESSION_ID })}
      frameStore={frameStore}
    />,
    { wrapper: withAnnouncer(bridgeWrapper(wire.bridge)) },
  );
}

/** One shell as the list names it, running and held by nobody unless the case says otherwise. */
function shellEntry(
  terminalId: string,
  overrides: Partial<TerminalListEntry> = {},
): TerminalListEntry {
  return {
    terminalId: terminalId as TerminalId,
    title: `zsh ${terminalId}`,
    status: { state: "running" },
    holder: null,
    leaseVersion: 0,
    ...overrides,
  };
}

function listShells(wire: RecordedShellWire, terminals: readonly TerminalListEntry[]): void {
  act(() => {
    wire.newestOpenOf(TERMINAL_LIST_STREAM).deliver({ sessionId: SESSION_ID, terminals });
  });
}

/** Each run of keys typed into the shell: its text and the subscription it was bound to. */
function writtenKeys(wire: RecordedShellWire): (readonly [string, SubscriptionId])[] {
  return wire.shellInputs.flatMap((input) =>
    input.kind === "keys" ? [[input.data, input.outputSubscriptionId] as const] : [],
  );
}

function textareaOf(container: HTMLElement): HTMLTextAreaElement {
  const textarea = emulatorElementOf(container).querySelector("textarea");
  if (textarea === null) {
    throw new Error("the emulator rendered no input");
  }
  return textarea;
}
