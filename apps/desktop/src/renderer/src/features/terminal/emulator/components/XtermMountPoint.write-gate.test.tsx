// The write gate as the emulator and a screen reader both see it. It reaches the library (xterm
// mirrors `disableStdin` onto its hidden textarea, which these cases read) and a person (the
// region's accessible name says whether the terminal may be typed into, and separates "someone
// else holds the shell" from "nowhere to send what you type"). A lease change forwards the gate
// without tearing the emulator down, so scrollback survives a claim. The readers are in
// `XtermMountPoint.test-support.ts`.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { XtermMountPoint } from "./XtermMountPoint.js";
import {
  COMPONENT_TERMINAL_IDS,
  isEmulatorAcceptingInput,
  renderSettledMountPoint,
  reclaimComponentHolds,
  emulatorElementOf,
} from "./XtermMountPoint.test-support.js";

afterEach(() => {
  reclaimComponentHolds(COMPONENT_TERMINAL_IDS);
});

describe("the write gate reaches assistive technology by name", () => {
  /** A writer, so the lease is the only thing a case about the lease is varying. */
  const sendToWire = (): void => undefined;

  it("names the terminal read-only while the lease is not this device's", async () => {
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    expect(emulatorElementOf(container).getAttribute("aria-label")).toBe(
      "Terminal output, read-only",
    );
  });

  it("drops the read-only suffix when this device holds the shell and can reach the wire", async () => {
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    expect(emulatorElementOf(container).getAttribute("aria-label")).toBe("Terminal output");
  });

  it("opens the emulator's own gate for a lease that was already this device's", async () => {
    // The emulator is built a commit after the one that first carried the lease, so a gate
    // forwarded only when the lease moves would leave a holder watching a shell they hold.
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    expect(isEmulatorAcceptingInput(emulatorElementOf(container))).toBe(true);
  });

  it("negative control: a watcher's emulator is closed, so the case above is not free", async () => {
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-2"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    expect(isEmulatorAcceptingInput(emulatorElementOf(container))).toBe(false);
  });

  it("forwards a lease change without rebuilding the emulator", async () => {
    const observed = vi.fn();
    const { container, rerender } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={sendToWire}
        onRendererMode={observed}
      />,
    );
    const emulatorBefore = emulatorElementOf(container).firstElementChild;
    act(() => {
      rerender(
        <XtermMountPoint
          terminalId="terminal-1"
          isWriteEnabled
          label="Terminal output"
          onKeystroke={sendToWire}
          onRendererMode={observed}
        />,
      );
    });
    // A transition never disturbs the foreground process: the mount effect does not run again,
    // only the gate moves.
    expect(observed).toHaveBeenCalledTimes(1);
    expect(emulatorElementOf(container).firstElementChild).toBe(emulatorBefore);
    expect(emulatorElementOf(container).getAttribute("aria-label")).toBe("Terminal output");
  });

  it("opens the gate on the emulator a new terminal id builds under the same lease", async () => {
    // A terminal id that moves replaces the adapter while the lease does not, so the fresh
    // binding must be built with the lease's answer, or the box reads
    // `data-write-enabled="true"` over a shut stdin.
    const { container, rerender } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    expect(isEmulatorAcceptingInput(emulatorElementOf(container))).toBe(true);

    act(() => {
      rerender(
        <XtermMountPoint
          terminalId="terminal-2"
          isWriteEnabled
          label="Terminal output"
          onKeystroke={sendToWire}
        />,
      );
    });

    expect(emulatorElementOf(container).getAttribute("aria-label")).toBe("Terminal output");
    expect(isEmulatorAcceptingInput(emulatorElementOf(container))).toBe(true);
  });

  it("negative control: a shut lease stays shut across the same terminal id change", async () => {
    // Without it the case above would pass against a component that opened stdin on every
    // adapter it built.
    const { container, rerender } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    act(() => {
      rerender(
        <XtermMountPoint
          terminalId="terminal-2"
          isWriteEnabled={false}
          label="Terminal output"
          onKeystroke={sendToWire}
        />,
      );
    });
    expect(isEmulatorAcceptingInput(emulatorElementOf(container))).toBe(false);
  });

  it("carries the gate on the mount point's box too, for the styling that has no text", async () => {
    const { container, rerender } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    const box = container.querySelector(".meridian-terminal-mount-point");
    expect(box?.getAttribute("data-write-enabled")).toBe("false");
    act(() => {
      rerender(
        <XtermMountPoint
          terminalId="terminal-1"
          isWriteEnabled
          label="Terminal output"
          onKeystroke={sendToWire}
        />,
      );
    });
    expect(box?.getAttribute("data-write-enabled")).toBe("true");
  });

  it("negative control: the name is not read-only in both states", async () => {
    // Every case above would pass against a component that hardcoded one name.
    const watching = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    const holding = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-2"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    expect(emulatorElementOf(watching.container).getAttribute("aria-label")).not.toBe(
      emulatorElementOf(holding.container).getAttribute("aria-label"),
    );
  });
});

describe("a held lease with nowhere to send a keystroke is still read-only", () => {
  // The pane mounts this combination (no writer is passed), and a re-render across a terminal
  // id reaches it too. A gate that read the lease alone would open xterm's stdin with no
  // `onData` subscription to forward it.

  it("keeps the emulator's own gate shut when the terminal has no writer", async () => {
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint terminalId="terminal-1" isWriteEnabled label="Terminal output" />,
    );
    expect(isEmulatorAcceptingInput(emulatorElementOf(container))).toBe(false);
  });

  it("names the missing channel rather than announcing the terminal writable", async () => {
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint terminalId="terminal-1" isWriteEnabled label="Terminal output" />,
    );
    // A name of "Terminal output" here would say a person may type into a shell that discards
    // everything they send.
    expect(emulatorElementOf(container).getAttribute("aria-label")).toBe(
      "Terminal output, read-only: no input channel",
    );
    expect(
      container.querySelector(".meridian-terminal-mount-point")?.getAttribute("data-write-enabled"),
    ).toBe("false");
  });

  it("distinguishes the missing channel from the lease being somebody else's", async () => {
    // Two different next moves: wait for the shell, or stop waiting because this build has
    // nowhere to put a keystroke.
    const noWriter = await renderSettledMountPoint(
      <XtermMountPoint terminalId="terminal-1" isWriteEnabled label="Terminal output" />,
    );
    const noLease = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-2"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={() => undefined}
      />,
    );
    expect(emulatorElementOf(noWriter.container).getAttribute("aria-label")).not.toBe(
      emulatorElementOf(noLease.container).getAttribute("aria-label"),
    );
  });

  it("negative control: adding the writer to that same lease opens the terminal", async () => {
    // Without this the cases above would pass against a component that never opened
    // the gate at all, which is a different bug and not a fix.
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-2"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={() => undefined}
      />,
    );
    expect(isEmulatorAcceptingInput(emulatorElementOf(container))).toBe(true);
    expect(emulatorElementOf(container).getAttribute("aria-label")).toBe("Terminal output");
  });
});
