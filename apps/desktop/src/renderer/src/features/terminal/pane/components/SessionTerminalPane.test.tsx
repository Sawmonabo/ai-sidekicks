// The terminal pane over a fake daemon wire: the shell list draws one tab per shell and a
// middle-click closes one, a session read empty opens one shell and no more; a close of a shell
// another device holds is asked first and forced on the answer, and a moved tab sends its order; an exited shell
// reads its exit line and one that did not start reads its cause with `Try again`; the holding
// pane tells the shell its grid's size; a paste goes as one paste; and keys typed while the
// output stream is opened again go once the new subscription is acknowledged.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { TerminalId, TerminalListEntry } from "@ai-sidekicks/contracts/terminal";
import type { DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { TERMINAL_LIST_STREAM, TERMINAL_OUTPUT_STREAM } from "#shared/daemon/streams.js";
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
const TERMINAL_IDS = ["terminal-1", "terminal-2"] as const;

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
    expect(await screen.findByText("The shell did not start · no such file")).toBeDefined();
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

  it("sends a paste as one paste, with its line breaks as carriage returns", async () => {
    const wire = new RecordedShellWire();
    const { container } = mountPane(wire);
    listShells(wire, [shellEntry("terminal-1")]);
    await openOutputAs(wire, FIRST_SUBSCRIPTION_ID);

    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (format: string) => (format === "text/plain" ? "echo one\necho two" : "") },
    });
    textareaOf(container).dispatchEvent(paste);
    await waitFor(() => {
      expect(wire.paramsOf("terminal.write")).toStrictEqual([
        {
          kind: "paste",
          sessionId: SESSION_ID,
          terminalId: "terminal-1",
          outputSubscriptionId: FIRST_SUBSCRIPTION_ID,
          data: "echo one\recho two",
          pasteId: expect.any(String) as unknown,
          isLastPart: true,
        },
      ]);
    });
  });

  it("holds keys typed while the output stream is opened again and sends them on its new subscription", async () => {
    const wire = new RecordedShellWire();
    const { container } = mountPane(wire);
    listShells(wire, [shellEntry("terminal-1")]);
    await openOutputAs(wire, FIRST_SUBSCRIPTION_ID);
    const mountElement = emulatorElementOf(container);
    typeOneCharacter(mountElement);
    await waitFor(() => {
      expect(writtenKeys(wire)).toStrictEqual([["a", FIRST_SUBSCRIPTION_ID]]);
    });

    // A stream that delivered is opened again after a wait once it ends.
    act(() => {
      const firstOpen = wire.newestOpenOf(TERMINAL_OUTPUT_STREAM);
      firstOpen.deliver(
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
      firstOpen.end({ reason: "failed", message: "the link went away" });
    });
    typeOneCharacter(mountElement);
    await vi.waitFor(() => {
      expect(wire.opensOf(TERMINAL_OUTPUT_STREAM)).toHaveLength(2);
    });
    expect(writtenKeys(wire)).toHaveLength(1);

    act(() => {
      wire.newestOpenOf(TERMINAL_OUTPUT_STREAM).opened(SECOND_SUBSCRIPTION_ID);
    });
    await waitFor(() => {
      expect(writtenKeys(wire)).toStrictEqual([
        ["a", FIRST_SUBSCRIPTION_ID],
        ["a", SECOND_SUBSCRIPTION_ID],
      ]);
    });
  });
});

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

// Once the emulator is on screen its output stream opens; the daemon acknowledges it here.
async function openOutputAs(
  wire: RecordedShellWire,
  subscriptionId: SubscriptionId,
): Promise<void> {
  await waitFor(() => {
    expect(wire.opensOf(TERMINAL_OUTPUT_STREAM)).toHaveLength(1);
  });
  act(() => {
    wire.newestOpenOf(TERMINAL_OUTPUT_STREAM).opened(subscriptionId);
  });
}

/** Each keys write sent: its text and the subscription it was bound to. */
function writtenKeys(wire: RecordedShellWire): (readonly [string, SubscriptionId])[] {
  return wire.paramsOf("terminal.write").flatMap((params) => {
    const write = params as { kind: string; data: string; outputSubscriptionId: SubscriptionId };
    return write.kind === "keys" ? [[write.data, write.outputSubscriptionId] as const] : [];
  });
}

function textareaOf(container: HTMLElement): HTMLTextAreaElement {
  const textarea = emulatorElementOf(container).querySelector("textarea");
  if (textarea === null) {
    throw new Error("the emulator rendered no input");
  }
  return textarea;
}
