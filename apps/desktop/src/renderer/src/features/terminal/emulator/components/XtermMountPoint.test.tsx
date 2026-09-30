// The mount point: the chunk it waits for, one adapter per mount, and disposal. The emulator's
// behavior is `xterm-adapter.test.ts`'s; this file owns the component's decisions about its
// life: code fetched not linked, an adapter built once per mount and never in a render pass,
// disposal on unmount, a lifetime that follows the terminal id rather than callback identities,
// and disposal even when `onRendererMode` throws in the effect body. The write gate and the
// renderer fallback have their own files; the readers are in `XtermMountPoint.test-support.ts`.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { XtermTerminalAdapter } from "../xterm-adapter.js";
import { TerminalRendererPool, terminalRendererPool } from "../renderer-pool.js";
import { XtermMountPoint } from "./XtermMountPoint.js";
import {
  COMPONENT_TERMINAL_IDS,
  renderSettledMountPoint,
  reclaimComponentHolds,
  settleEmulatorLoad,
  emulatorElementOf,
  typeOneCharacter,
} from "./XtermMountPoint.test-support.js";

afterEach(() => {
  reclaimComponentHolds(COMPONENT_TERMINAL_IDS);
});

describe("the emulator's code is fetched, not linked", () => {
  it("stands the box in as a read-in-flight absence before the chunk lands", async () => {
    const { container } = render(
      <XtermMountPoint terminalId="terminal-1" isWriteEnabled={false} label="Terminal output" />,
    );
    // Synchronously after the mount there is no mount element, because the module that draws
    // into one has not arrived; the box still says which gate it is under.
    expect(container.querySelector(".meridian-terminal-mount-point")).not.toBeNull();
    expect(container.querySelector(".meridian-terminal-mount-point__mount-element")).toBeNull();
    const absence = container.querySelector(".meridian-nothing");
    expect(absence?.className).toContain("meridian-nothing--not-loaded");
    expect(absence?.className).toContain("meridian-nothing--block");

    await settleEmulatorLoad();

    // Once it lands the absence is replaced, not joined: a skeleton beside a live grid would
    // read as a second terminal still loading.
    expect(emulatorElementOf(container).childElementCount).toBeGreaterThan(0);
    expect(container.querySelector(".meridian-nothing")).toBeNull();
  });

  it("negative control: the absence is not the kind that would look finished", async () => {
    const { container } = render(
      <XtermMountPoint terminalId="terminal-1" isWriteEnabled={false} label="Terminal output" />,
    );
    // `empty` would claim the shell printed nothing and `not-checked` that nobody asked; both
    // are claims about the session from a component only waiting on its own bytes.
    const absence = container.querySelector(".meridian-nothing");
    expect(absence?.className).not.toContain("meridian-nothing--empty");
    expect(absence?.className).not.toContain("meridian-nothing--not-checked");
    await settleEmulatorLoad();
  });

  it("ignores an emulator that arrives after the pane closed", async () => {
    const observed = vi.fn();
    const { container, unmount } = render(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    // Closed inside the fetch: settling it into state would be a write against a disposed
    // component.
    unmount();
    await settleEmulatorLoad();
    expect(observed).not.toHaveBeenCalled();
    expect(container.querySelector(".meridian-terminal-mount-point__mount-element")).toBeNull();
    // No adapter was built, so nothing took a hold that nothing will give back.
    expect(terminalRendererPool.holds("terminal-1")).toBe(false);
  });

  it("negative control: that same wait does build one for a mount point still mounted", async () => {
    // Without this the case above would pass against a wait too short for the
    // chunk to have arrived at all, which asserts nothing about the unmount.
    const observed = vi.fn();
    render(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    await settleEmulatorLoad();
    expect(observed).toHaveBeenCalledTimes(1);
  });
});

describe("the mount point — one adapter per mount", () => {
  it("builds an emulator into the mount element on mount", async () => {
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint terminalId="terminal-1" isWriteEnabled={false} label="Terminal output" />,
    );
    // The library writes its grid into the box it was opened against, so a non-empty mount
    // element shows a real emulator attached and not just a ref set.
    expect(emulatorElementOf(container).childElementCount).toBeGreaterThan(0);
  });

  it("reports the renderer it settled on, so its parent can say which it got", async () => {
    const observed = vi.fn();
    await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    expect(observed).toHaveBeenCalledTimes(1);
    // The DOM shim has no WebGL2, so this environment settles on the fallback —
    // which is the arm the pool's cap also leads to.
    expect(observed).toHaveBeenCalledWith("dom");
  });

  it("disposes on unmount, which is what gives the renderer hold back", async () => {
    const pool = new TerminalRendererPool();
    const { unmount, container } = await renderSettledMountPoint(
      <XtermMountPoint terminalId="terminal-1" isWriteEnabled={false} label="Terminal output" />,
    );
    const mountElement = emulatorElementOf(container);
    expect(mountElement.childElementCount).toBeGreaterThan(0);
    unmount();
    // The adapter tore its own DOM down; nothing of the emulator is left behind in
    // a box React is about to drop.
    expect(mountElement.childElementCount).toBe(0);
    expect(pool.heldContextCount).toBe(0);
    expect(terminalRendererPool.holds("terminal-1")).toBe(false);
  });
});

describe("the emulator outlives the parent's callback identities", () => {
  it("keeps the same instance when a parent hands it fresh callbacks", async () => {
    const observedAtMount = vi.fn();
    const { container, rerender } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled
        label="Terminal output"
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
          label="Terminal output"
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

  it("sends a keystroke to the callback the parent passed most recently", async () => {
    const firstKeystrokeHandler = vi.fn();
    const latestKeystrokeHandler = vi.fn();
    const { container, rerender } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={firstKeystrokeHandler}
      />,
    );
    act(() => {
      rerender(
        <XtermMountPoint
          terminalId="terminal-1"
          isWriteEnabled
          label="Terminal output"
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

  it("negative control: a different terminal DOES get a different emulator", async () => {
    // Without this the first case would pass against a component whose mount
    // effect never re-ran at all, which is a different bug and not a fix.
    const { container, rerender } = await renderSettledMountPoint(
      <XtermMountPoint terminalId="terminal-1" isWriteEnabled label="Terminal output" />,
    );
    const emulatorBefore = emulatorElementOf(container).firstElementChild;
    act(() => {
      rerender(<XtermMountPoint terminalId="terminal-2" isWriteEnabled label="Terminal output" />);
    });
    expect(emulatorElementOf(container).firstElementChild).not.toBe(emulatorBefore);
  });

  it("negative control: a watcher's keystroke reaches nobody", async () => {
    // And without this the case above would pass against a wrapper that forwarded
    // every keystroke regardless of the gate the adapter reads.
    const watcherKeystrokeHandler = vi.fn();
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-2"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={watcherKeystrokeHandler}
      />,
    );
    typeOneCharacter(emulatorElementOf(container));
    expect(watcherKeystrokeHandler).not.toHaveBeenCalled();
  });
});

// The one moment the component can construct an emulator and never get a disposer:
// `subscribeToRendererMode` delivers the settled mode synchronously inside the effect body,
// before its cleanup exists, so a throwing `onRendererMode` would leave the terminal, its
// observers and its renderer allocation behind. The adapter class is the real one the loader
// resolves; the spy observes it.
describe("a renderer-mode consumer that throws during the first delivery", () => {
  it("disposes the adapter, leaves no hold taken, and still raises the failure", async () => {
    const dispose = vi.spyOn(XtermTerminalAdapter.prototype, "dispose");
    const consumerFailure = new Error("the renderer-mode consumer refused the delivery");
    render(
      <XtermMountPoint
        terminalId="terminal-1"
        isWriteEnabled={false}
        label="Terminal output"
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

  it("negative control: a consumer that returns leaves the emulator running", async () => {
    // Without this, a component that disposed the adapter on every mount would satisfy the case
    // above.
    const dispose = vi.spyOn(XtermTerminalAdapter.prototype, "dispose");
    const modes: string[] = [];
    const { container } = await renderSettledMountPoint(
      <XtermMountPoint
        terminalId="terminal-2"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={(mode) => modes.push(mode)}
      />,
    );

    expect(modes.length).toBeGreaterThan(0);
    expect(dispose).not.toHaveBeenCalled();
    expect(emulatorElementOf(container).childElementCount).toBeGreaterThan(0);
    dispose.mockRestore();
  });
});
