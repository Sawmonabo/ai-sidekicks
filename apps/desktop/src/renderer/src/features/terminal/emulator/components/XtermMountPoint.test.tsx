// The mount point's life and its write gate: one emulator per terminal id, kept across callback
// and lease changes so scrollback survives, disposed on unmount or a failed setup, keystrokes
// sent to the newest handler, and a keyboard that stays shut for a device that does not hold
// the shell. The readers are in `XtermMountPoint.test-support.ts`.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalRendererPool } from "../renderer-pool.js";
import { XtermTerminalAdapter } from "../xterm-adapter.js";
import { XtermMountPoint } from "./XtermMountPoint.js";
import {
  COMPONENT_TERMINAL_IDS,
  isEmulatorAcceptingInput,
  renderSettledMountPoint,
  reclaimComponentHolds,
  settleEmulatorLoad,
  emulatorElementOf,
  typeOneCharacter,
} from "./XtermMountPoint.test-support.js";

afterEach(() => {
  reclaimComponentHolds(COMPONENT_TERMINAL_IDS);
});

describe("the mount point — one adapter per mount", () => {
  it("disposes on unmount, tearing the emulator's DOM down", async () => {
    const { unmount, container } = await renderSettledMountPoint(
      <XtermMountPoint terminalId="terminal-1" isWriteEnabled={false} label="Shell output" />,
    );
    const mountElement = emulatorElementOf(container);
    expect(mountElement.childElementCount).toBeGreaterThan(0);
    unmount();
    // The adapter tore its own DOM down; nothing of the emulator is left behind in
    // a box React is about to drop.
    expect(mountElement.childElementCount).toBe(0);
  });
});

describe("the emulator outlives the parent's callback identities", () => {
  it("keeps the same instance when a parent hands it fresh callbacks", async () => {
    const observedAtMount = vi.fn();
    const { container, rerender } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled
        label="Shell output"
        onKeystroke={() => undefined}
        onActivateLink={() => undefined}
        onRendererMode={observedAtMount}
      />,
    );
    const emulatorBefore = emulatorElementOf(container).firstElementChild;

    const observedAfterRerender = vi.fn();
    act(() => {
      rerender(
        <XtermMountPoint
          terminalId="terminal-1"
          isWriteEnabled
          label="Shell output"
          onKeystroke={() => undefined}
          onActivateLink={() => undefined}
          onRendererMode={observedAfterRerender}
        />,
      );
    });

    // Three new functions and the same terminal: a mount effect depending on their identities
    // would dispose the emulator and drop the scrollback.
    expect(emulatorElementOf(container).firstElementChild).toBe(emulatorBefore);
    expect(observedAtMount).toHaveBeenCalledTimes(1);
    expect(observedAfterRerender).not.toHaveBeenCalled();
  });

  it("builds a new emulator for a different terminal id", async () => {
    // Reusing the emulator would show one shell's scrollback under another's name.
    const { container, rerender } = await renderSettledMountPoint(
      <XtermMountPoint terminalId="terminal-1" isWriteEnabled label="Shell output" />,
    );
    const emulatorBefore = emulatorElementOf(container).firstElementChild;
    act(() => {
      rerender(<XtermMountPoint terminalId="terminal-2" isWriteEnabled label="Shell output" />);
    });
    expect(emulatorElementOf(container).firstElementChild).not.toBe(emulatorBefore);
  });

  it("sends a keystroke to the callback the parent passed most recently", async () => {
    const firstKeystrokeHandler = vi.fn();
    const latestKeystrokeHandler = vi.fn();
    const { container, rerender } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled
        label="Shell output"
        onKeystroke={firstKeystrokeHandler}
      />,
    );
    act(() => {
      rerender(
        <XtermMountPoint
          terminalId="terminal-1"
          isWriteEnabled
          label="Shell output"
          onKeystroke={latestKeystrokeHandler}
        />,
      );
    });

    typeOneCharacter(emulatorElementOf(container));

    // An adapter still holding the mount pass's function would send keystrokes to a handler
    // the parent has replaced.
    expect(latestKeystrokeHandler).toHaveBeenCalledWith("a");
    expect(firstKeystrokeHandler).not.toHaveBeenCalled();
  });

  it("sends no keystroke from a device that does not hold the lease", async () => {
    // The emulator's own gate drops the keystroke, not only the read-only input element.
    const watcherKeystrokeHandler = vi.fn();
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-2"
        isWriteEnabled={false}
        label="Shell output"
        onKeystroke={watcherKeystrokeHandler}
      />,
    );
    typeOneCharacter(emulatorElementOf(container));
    expect(watcherKeystrokeHandler).not.toHaveBeenCalled();
  });
});

describe("the write gate", () => {
  /** A writer, so the lease is the only thing a case about the lease is varying. */
  const sendToWire = (): void => undefined;

  it("opens the emulator's own gate for a lease that was already this device's", async () => {
    // The emulator is built a commit after the one that first carried the lease, so a gate
    // forwarded only when the lease moves would leave a holder watching a shell they hold.
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled
        label="Shell output"
        onKeystroke={sendToWire}
      />,
    );
    expect(isEmulatorAcceptingInput(emulatorElementOf(container))).toBe(true);
  });

  it("keeps the same emulator when the lease changes, and moves its gate both ways", async () => {
    const observed = vi.fn();
    const { container, rerender } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled={false}
        label="Shell output"
        onKeystroke={sendToWire}
        onRendererMode={observed}
      />,
    );
    const emulatorBefore = emulatorElementOf(container).firstElementChild;
    const renderWithLease = (isWriteEnabled: boolean): void => {
      act(() => {
        rerender(
          <XtermMountPoint
            terminalId="terminal-1"
            isWriteEnabled={isWriteEnabled}
            label="Shell output"
            onKeystroke={sendToWire}
            onRendererMode={observed}
          />,
        );
      });
    };
    renderWithLease(true);
    // A transition never disturbs the foreground process: the mount effect does not run again,
    // only the gate moves.
    expect(observed).toHaveBeenCalledTimes(1);
    expect(emulatorElementOf(container).firstElementChild).toBe(emulatorBefore);
    expect(emulatorElementOf(container).getAttribute("aria-label")).toBe("Shell output");
    expect(isEmulatorAcceptingInput(emulatorElementOf(container))).toBe(true);
    // The shell taken by another device: this device must stop typing into it.
    renderWithLease(false);
    expect(isEmulatorAcceptingInput(emulatorElementOf(container))).toBe(false);
  });

  it("keeps a watcher's gate shut on the emulator a new terminal id builds", async () => {
    // A fresh adapter is built with the lease's answer, never an open stdin by default.
    const { container, rerender } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled={false}
        label="Shell output"
        onKeystroke={sendToWire}
      />,
    );
    act(() => {
      rerender(
        <XtermMountPoint
          terminalId="terminal-2"
          isWriteEnabled={false}
          label="Shell output"
          onKeystroke={sendToWire}
        />,
      );
    });
    expect(isEmulatorAcceptingInput(emulatorElementOf(container))).toBe(false);
  });
});

// The one moment the component can construct an emulator and never get a disposer:
// `subscribeToRendererMode` delivers the settled mode synchronously inside the effect body,
// before its cleanup exists, so a throwing `onRendererMode` would leave the terminal, its
// observers and its renderer allocation behind.
describe("a renderer-mode consumer that throws during the first delivery", () => {
  it("disposes the adapter, leaves no hold taken, and still raises the failure", async () => {
    const dispose = vi.spyOn(XtermTerminalAdapter.prototype, "dispose");
    const consumerFailure = new Error("the renderer-mode consumer refused the delivery");
    render(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled={false}
        label="Shell output"
        onRendererMode={() => {
          throw consumerFailure;
        }}
      />,
    );

    await expect(settleEmulatorLoad()).rejects.toThrow(consumerFailure);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(terminalRendererPool.heldContextCount).toBe(0);
    dispose.mockRestore();
  });
});
