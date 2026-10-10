// A paste while a copy is still being written waits for it and then pastes the copy's text, in a
// terminal as in any field; a copy that gives up lets the held paste go ahead; and a middle-click
// paste of the primary selection goes straight through where the system keeps one.

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { windowDiagnosticCapture } from "#renderer/lib/diagnostic-capture/capture.js";
import { XtermMountPoint } from "#renderer/features/terminal/emulator/components/XtermMountPoint.js";
import {
  COMPONENT_TERMINAL_IDS,
  emulatorElementOf,
  reclaimComponentHolds,
  renderSettledMountPoint,
} from "#renderer/features/terminal/emulator/components/XtermMountPoint.test-support.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { copyOnceBuilt } from "#renderer/services/platform/late-clipboard-copy.js";
import { useHeldPaste } from "./useHeldPaste.js";

const WINDOW_ID = "window/w-1";
const OLDER_COPY = "the person's older copy";
const NEW_COPY = "the copy just made";

afterEach(() => {
  reclaimComponentHolds(COMPONENT_TERMINAL_IDS);
});

/** A paste of `text` on `target`, as the browser fires one, and the event fired. */
function pasteInto(target: Element, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  target.dispatchEvent(event);
  return event;
}

/**
 * A fixture bridge, on `platform` where one is named, over a clipboard holding the person's older
 * copy, whose late write lands when `land` is called, and whose window paste pastes what the
 * clipboard holds then into the focused field, as main's does.
 */
function bridgeOverClipboard(platform?: PlatformBridge["app"]["platform"]): {
  readonly bridge: PlatformBridge;
  readonly land: () => Promise<void>;
} {
  const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
  const bridge =
    platform === undefined
      ? fixture.bridge
      : { ...fixture.bridge, app: { ...fixture.bridge.app, platform } };
  const clipboard = { text: OLDER_COPY };
  const landings: (() => void)[] = [];
  vi.spyOn(bridge.native, "copyToClipboardUnlessChanged").mockImplementation(
    (content) =>
      new Promise((resolve) => {
        landings.push(() => {
          clipboard.text = "text" in content ? content.text : expect.fail("the copy is text");
          resolve(true);
        });
      }),
  );
  vi.spyOn(bridge.window, "paste").mockImplementation(async () => {
    pasteInto(document.activeElement ?? expect.fail("a field has focus"), clipboard.text);
  });
  return {
    bridge,
    land: async () => {
      // The write is asked for once main's snapshot of the clipboard is back.
      await vi.waitFor(() => {
        expect(landings).toHaveLength(1);
      });
      landings.shift()?.();
    },
  };
}

function HeldPaste(props: { readonly bridge: PlatformBridge }): null {
  useHeldPaste(props.bridge, window, WINDOW_ID);
  return null;
}

/** Every paste `field` takes, by its text. */
function pastesInto(field: HTMLElement): string[] {
  const pasted: string[] = [];
  field.addEventListener("paste", (event) => {
    pasted.push(event.clipboardData?.getData("text/plain") ?? expect.fail("the paste holds text"));
  });
  return pasted;
}

function Fields(props: { readonly bridge: PlatformBridge; readonly hasMessageBox: boolean }) {
  return (
    <>
      <HeldPaste bridge={props.bridge} />
      {props.hasMessageBox ? <textarea aria-label="Message" /> : null}
      <textarea aria-label="Search" />
    </>
  );
}

/**
 * The message box, focused, and a search field, with the bridge's paste hold on their window,
 * every paste each took, and the message box's removal.
 */
function renderField(bridge: PlatformBridge): {
  readonly field: HTMLTextAreaElement;
  readonly pasted: string[];
  readonly searchField: HTMLTextAreaElement;
  readonly searchPasted: string[];
  readonly removeField: () => void;
} {
  const { rerender } = render(<Fields bridge={bridge} hasMessageBox />);
  const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  const searchField = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Search" });
  field.focus();
  return {
    field,
    pasted: pastesInto(field),
    searchField,
    searchPasted: pastesInto(searchField),
    removeField: () => {
      rerender(<Fields bridge={bridge} hasMessageBox={false} />);
    },
  };
}

describe("a paste while a copy is being written", () => {
  it("pastes the copy into a terminal once it is written, not what the clipboard held", async () => {
    const { bridge, land } = bridgeOverClipboard();
    const onKeystroke = vi.fn();
    const { container } = await renderSettledMountPoint(
      <>
        <HeldPaste bridge={bridge} />
        <XtermMountPoint
          terminalId="terminal-1"
          isWriteEnabled
          label="Shell output"
          onKeystroke={onKeystroke}
        />
      </>,
    );
    const input = emulatorElementOf(container).querySelector("textarea");
    input?.focus();
    const copied = copyOnceBuilt(bridge, (write) => write({ text: NEW_COPY }));

    // The person presses ⌘V just after ⌘C, while the copy's text is still being written.
    const held = pasteInto(input ?? expect.fail("the terminal has an input"), OLDER_COPY);
    expect([held.defaultPrevented, onKeystroke.mock.calls]).toStrictEqual([true, []]);
    await act(async () => {
      await land();
      await copied;
    });

    await vi.waitFor(() => {
      expect(onKeystroke.mock.calls).toStrictEqual([[NEW_COPY]]);
    });
  });

  it("lets a held paste go ahead with what the clipboard holds once the copy gives up", async () => {
    const { bridge } = bridgeOverClipboard();
    const { field, pasted } = renderField(bridge);
    let refuseBody = (): void => undefined;
    const copied = copyOnceBuilt(bridge, async (write) => {
      // A large body the copy reads is refused, so it writes nothing.
      await new Promise<void>((_resolve, reject) => {
        refuseBody = () => {
          reject(new Error("The body was refused."));
        };
      });
      return write({ text: NEW_COPY });
    });

    const held = pasteInto(field, OLDER_COPY);
    expect([held.defaultPrevented, pasted]).toStrictEqual([true, []]);
    refuseBody();
    await expect(copied).rejects.toThrow("The body was refused.");

    await vi.waitFor(() => {
      expect(pasted).toStrictEqual([OLDER_COPY]);
    });
  });

  it("pastes into the field it was pressed in, though focus moved meanwhile", async () => {
    const { bridge, land } = bridgeOverClipboard();
    const { field, pasted, searchField, searchPasted } = renderField(bridge);
    const copied = copyOnceBuilt(bridge, (write) => write({ text: NEW_COPY }));

    pasteInto(field, OLDER_COPY);
    searchField.focus();
    await land();
    await copied;

    await vi.waitFor(() => {
      expect(pasted).toStrictEqual([NEW_COPY]);
    });
    expect([searchPasted, document.activeElement]).toStrictEqual([[], field]);
  });

  it("drops a held paste whose field is gone, pasting it nowhere, and records the drop", async () => {
    const { bridge, land } = bridgeOverClipboard();
    const { field, removeField } = renderField(bridge);
    const batches: string[] = [];
    const detachForwarder = windowDiagnosticCapture.installForwarder((jsonLines) => {
      batches.push(jsonLines);
    });
    const copied = copyOnceBuilt(bridge, (write) => write({ text: NEW_COPY }));

    pasteInto(field, OLDER_COPY);
    removeField();
    await land();
    await copied;

    await vi.waitFor(() => {
      windowDiagnosticCapture.flush();
      expect(batches.join("\n")).toContain('"kind":"held-paste-dropped"');
    });
    detachForwarder();
    expect(bridge.window.paste).not.toHaveBeenCalled();
  });

  it("lets a middle-click paste through where it pastes the primary selection, and holds ⌘V after", async () => {
    const { bridge } = bridgeOverClipboard("linux");
    const { field, pasted } = renderField(bridge);
    void copyOnceBuilt(bridge, (write) => write({ text: NEW_COPY }));

    // The browser pastes the selection in the same task as the middle button's release.
    field.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 1 }));
    const middleClickPaste = pasteInto(field, "the selected words");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const keyPaste = pasteInto(field, OLDER_COPY);

    expect([middleClickPaste.defaultPrevented, keyPaste.defaultPrevented]).toStrictEqual([
      false,
      true,
    ]);
    expect(pasted).toStrictEqual(["the selected words"]);
  });
});
