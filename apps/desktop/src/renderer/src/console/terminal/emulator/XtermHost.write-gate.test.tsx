// The write gate, as the emulator and a screen reader both see it.
//
// Two claims, and neither is about a field of ours. The gate reaches the LIBRARY: xterm
// mirrors `disableStdin` onto the hidden textarea it listens on, so the emulator's own
// input state is what these cases read. And it reaches a person: the region's accessible
// name says whether this surface may be typed into, and it distinguishes the two
// read-only states — somebody else holds the shell, versus there is nowhere to send what
// you type — because a lease this participant holds over a surface with no output stream
// registered is still read-only, and a name that said otherwise would be a promise the
// wire has not made.
//
// A lease change forwards the gate WITHOUT tearing the emulator down, which is the other
// half: the scrollback and the operator's scroll position survive a claim.
//
// The readers are `XtermHost.test-support.tsx`'s, and the loader is the real one there
// too.

import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { XtermHost } from "./XtermHost.js";
import {
  COMPONENT_TERMINAL_IDS,
  isEmulatorAcceptingInput,
  mountHost,
  reclaimComponentHolds,
  surfaceOf,
} from "./XtermHost.test-support.js";

afterEach(() => {
  reclaimComponentHolds(COMPONENT_TERMINAL_IDS);
});

describe("the write gate reaches assistive technology by name", () => {
  /** A writer, so the lease is the only thing a case about the lease is varying. */
  const sendToWire = (): void => undefined;

  it("names the surface read-only while the lease is not the viewer's", async () => {
    const { container } = await mountHost(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    expect(surfaceOf(container).getAttribute("aria-label")).toBe("Terminal output, read-only");
  });

  it("drops the read-only suffix when the viewer holds the shell and can reach the wire", async () => {
    const { container } = await mountHost(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    expect(surfaceOf(container).getAttribute("aria-label")).toBe("Terminal output");
  });

  it("opens the emulator's own gate for a lease that was already the viewer's", async () => {
    // The emulator is built a commit AFTER the one that first carried the lease, so
    // a gate forwarded only when the lease MOVES would leave a holder watching a
    // shell they hold — the emulator would be built closed and stay closed until
    // the next transition.
    const { container } = await mountHost(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    expect(isEmulatorAcceptingInput(surfaceOf(container))).toBe(true);
  });

  it("negative control: a watcher's emulator is closed, so the case above is not free", async () => {
    const { container } = await mountHost(
      <XtermHost
        terminalId="host-2"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    expect(isEmulatorAcceptingInput(surfaceOf(container))).toBe(false);
  });

  it("forwards a lease change without rebuilding the emulator", async () => {
    const observed = vi.fn();
    const { container, rerender } = await mountHost(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={sendToWire}
        onRendererMode={observed}
      />,
    );
    const surfaceBefore = surfaceOf(container).firstElementChild;
    act(() => {
      rerender(
        <XtermHost
          terminalId="host-1"
          isWriteEnabled
          label="Terminal output"
          onKeystroke={sendToWire}
          onRendererMode={observed}
        />,
      );
    });
    // 8.8: a transition never disturbs the foreground process. The emulator is the
    // same instance — the mount effect did not run a second time — and only the
    // gate moved.
    expect(observed).toHaveBeenCalledTimes(1);
    expect(surfaceOf(container).firstElementChild).toBe(surfaceBefore);
    expect(surfaceOf(container).getAttribute("aria-label")).toBe("Terminal output");
  });

  it("opens the gate on the emulator a new terminal id builds under the same lease", async () => {
    // The finding. A terminal id that moves replaces the adapter, and the lease did
    // not move with it — so a gate forwarded only when the LEASE changes left the
    // fresh binding on its default shut stdin while the box below still read
    // `data-write-enabled="true"`, and every character the holder typed was dropped
    // until the shell next changed hands.
    const { container, rerender } = await mountHost(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    expect(isEmulatorAcceptingInput(surfaceOf(container))).toBe(true);

    act(() => {
      rerender(
        <XtermHost
          terminalId="host-2"
          isWriteEnabled
          label="Terminal output"
          onKeystroke={sendToWire}
        />,
      );
    });

    expect(surfaceOf(container).getAttribute("aria-label")).toBe("Terminal output");
    expect(isEmulatorAcceptingInput(surfaceOf(container))).toBe(true);
  });

  it("negative control: a shut lease stays shut across the same terminal id change", async () => {
    // Without it the case above would pass against a component that opened stdin on
    // every adapter it built, which is watch mode failing open on a rebuild.
    const { container, rerender } = await mountHost(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    act(() => {
      rerender(
        <XtermHost
          terminalId="host-2"
          isWriteEnabled={false}
          label="Terminal output"
          onKeystroke={sendToWire}
        />,
      );
    });
    expect(isEmulatorAcceptingInput(surfaceOf(container))).toBe(false);
  });

  it("carries the gate on the host box too, for the styling that has no text", async () => {
    const { container, rerender } = await mountHost(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    const host = container.querySelector(".meridian-terminal-host");
    expect(host?.getAttribute("data-write-enabled")).toBe("false");
    act(() => {
      rerender(
        <XtermHost
          terminalId="host-1"
          isWriteEnabled
          label="Terminal output"
          onKeystroke={sendToWire}
        />,
      );
    });
    expect(host?.getAttribute("data-write-enabled")).toBe("true");
  });

  it("negative control: the name is not read-only in both states", async () => {
    // Every case above would pass against a component that hardcoded one name.
    const watching = await mountHost(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    const holding = await mountHost(
      <XtermHost
        terminalId="host-2"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={sendToWire}
      />,
    );
    expect(surfaceOf(watching.container).getAttribute("aria-label")).not.toBe(
      surfaceOf(holding.container).getAttribute("aria-label"),
    );
  });
});

describe("a held lease with nowhere to send a keystroke is still read-only", () => {
  // The pane mounts exactly this combination today — the output wire is
  // unregistered, so no writer is passed — and a re-render across a terminal id
  // reaches it too. The old gate read the lease alone, so xterm accepted every
  // character while the adapter, built without an `onData` subscription, forwarded
  // none of them.

  it("keeps the emulator's own gate shut when the surface has no writer", async () => {
    const { container } = await mountHost(
      <XtermHost terminalId="host-1" isWriteEnabled label="Terminal output" />,
    );
    expect(isEmulatorAcceptingInput(surfaceOf(container))).toBe(false);
  });

  it("names the missing channel rather than announcing the surface writable", async () => {
    const { container } = await mountHost(
      <XtermHost terminalId="host-1" isWriteEnabled label="Terminal output" />,
    );
    // The old component announced "Terminal output" here — a name that says a
    // person may type into a shell that will discard everything they send.
    expect(surfaceOf(container).getAttribute("aria-label")).toBe(
      "Terminal output, read-only: no input channel",
    );
    expect(
      container.querySelector(".meridian-terminal-host")?.getAttribute("data-write-enabled"),
    ).toBe("false");
  });

  it("distinguishes the missing channel from the lease being somebody else's", async () => {
    // Two different next moves: wait for the shell, or stop waiting because this
    // build has nowhere to put a keystroke. One suffix for both would send a holder
    // to wait for a lease they already have.
    const noWriter = await mountHost(
      <XtermHost terminalId="host-1" isWriteEnabled label="Terminal output" />,
    );
    const noLease = await mountHost(
      <XtermHost
        terminalId="host-2"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={() => undefined}
      />,
    );
    expect(surfaceOf(noWriter.container).getAttribute("aria-label")).not.toBe(
      surfaceOf(noLease.container).getAttribute("aria-label"),
    );
  });

  it("negative control: adding the writer to that same lease opens the surface", async () => {
    // Without this the cases above would pass against a component that never opened
    // the gate at all, which is a different bug and not a fix.
    const { container } = await mountHost(
      <XtermHost
        terminalId="host-2"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={() => undefined}
      />,
    );
    expect(isEmulatorAcceptingInput(surfaceOf(container))).toBe(true);
    expect(surfaceOf(container).getAttribute("aria-label")).toBe("Terminal output");
  });
});
