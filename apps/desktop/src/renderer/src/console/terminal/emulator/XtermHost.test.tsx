// The mount point: the chunk it waits for, one adapter per mount, and disposal.
//
// WHAT THIS FILE IS FOR AND WHAT IT IS NOT. The emulator's behaviour is
// `xterm-adapter.test.ts`'s subject; this one owns what the COMPONENT decides about the
// emulator's LIFE — that its code is fetched rather than statically linked, so the box
// stands in as a read-in-flight absence until it lands; that an adapter is built once
// per mount and never in a render pass; that unmounting disposes it, which is what gives
// up its hold on the renderer; that the lifetime belongs to the terminal id rather than
// to the identities of the callbacks the parent hands down; and that the one moment the
// component can build an emulator and never get a disposer — a parent whose
// `onRendererMode` throws inside the effect body — tears it down anyway.
//
// The write gate is `XtermHost.write-gate.test.tsx`'s and the renderer fallback is
// `XtermHost.renderer-mode.test.tsx`'s. The readers every one of them takes are in
// `XtermHost.test-support.tsx`.

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { XtermTerminalAdapter } from "./xterm-adapter.js";
import { TerminalRendererPool, terminalRendererPool } from "./renderer-pool.js";
import { XtermHost } from "./XtermHost.js";
import {
  COMPONENT_TERMINAL_IDS,
  mountHost,
  reclaimComponentHolds,
  settleEmulatorLoad,
  surfaceOf,
  typeOneCharacter,
} from "./XtermHost.test-support.js";

afterEach(() => {
  reclaimComponentHolds(COMPONENT_TERMINAL_IDS);
});

describe("the emulator's code is fetched, not linked", () => {
  it("stands the box in as a read-in-flight absence before the chunk lands", async () => {
    const { container } = render(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    // Synchronously after the mount there is no surface, because the module that
    // draws into one has not arrived. The box is still there and still says which
    // gate it is under — only its contents are absent.
    expect(container.querySelector(".meridian-terminal-host")).not.toBeNull();
    expect(container.querySelector(".meridian-terminal-host__surface")).toBeNull();
    const absence = container.querySelector(".meridian-nothing");
    expect(absence?.className).toContain("meridian-nothing--not-loaded");
    expect(absence?.className).toContain("meridian-nothing--block");

    await settleEmulatorLoad();

    // And once it lands the absence is replaced by the emulator rather than joined
    // by it: a skeleton left beside a live grid would read as a second terminal
    // still loading.
    expect(surfaceOf(container).childElementCount).toBeGreaterThan(0);
    expect(container.querySelector(".meridian-nothing")).toBeNull();
  });

  it("negative control: the absence is not the kind that would look finished", async () => {
    const { container } = render(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    // `empty` would claim the shell printed nothing and `not-checked` would claim
    // nobody asked. Both are claims about the SESSION made by a component that is
    // only waiting on its own bytes.
    const absence = container.querySelector(".meridian-nothing");
    expect(absence?.className).not.toContain("meridian-nothing--empty");
    expect(absence?.className).not.toContain("meridian-nothing--not-checked");
    await settleEmulatorLoad();
  });

  it("ignores an emulator that arrives after the pane closed", async () => {
    const observed = vi.fn();
    const { container, unmount } = render(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={observed}
      />,
    );
    // Closed inside the fetch. The promise is still in flight over a component
    // React has already dropped, and settling it into state would be a write
    // against a disposed host.
    unmount();
    await settleEmulatorLoad();
    expect(observed).not.toHaveBeenCalled();
    expect(container.querySelector(".meridian-terminal-host__surface")).toBeNull();
    // No adapter was built, so nothing took a slot that nothing will give back.
    expect(terminalRendererPool.holds("host-1")).toBe(false);
  });

  it("negative control: that same wait does build one for a host still mounted", async () => {
    // Without this the case above would pass against a wait too short for the
    // chunk to have arrived at all, which asserts nothing about the unmount.
    const observed = vi.fn();
    render(
      <XtermHost
        terminalId="host-1"
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
  it("builds an emulator into the host box on mount", async () => {
    const { container } = await mountHost(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    // The library writes its own grid into the box it was opened against, so a
    // non-empty surface is evidence a real emulator attached rather than that a
    // ref was set.
    expect(surfaceOf(container).childElementCount).toBeGreaterThan(0);
  });

  it("reports the renderer it settled on, so a surface can say which it got", async () => {
    const observed = vi.fn();
    await mountHost(
      <XtermHost
        terminalId="host-1"
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

  it("disposes on unmount, which is what gives the renderer slot back", async () => {
    const pool = new TerminalRendererPool();
    const { unmount, container } = await mountHost(
      <XtermHost terminalId="host-1" isWriteEnabled={false} label="Terminal output" />,
    );
    const surface = surfaceOf(container);
    expect(surface.childElementCount).toBeGreaterThan(0);
    unmount();
    // The adapter tore its own DOM down; nothing of the emulator is left behind in
    // a box React is about to drop.
    expect(surface.childElementCount).toBe(0);
    expect(pool.heldSlotCount).toBe(0);
    expect(terminalRendererPool.holds("host-1")).toBe(false);
  });
});

describe("the emulator outlives the parent's callback identities", () => {
  it("keeps the same instance when a parent hands it fresh callbacks", async () => {
    const observedAtMount = vi.fn();
    const { container, rerender } = await mountHost(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={() => undefined}
        onActivateLink={() => undefined}
        onRendererMode={observedAtMount}
      />,
    );
    const emulatorBefore = surfaceOf(container).firstElementChild;

    const observedAfterRerender = vi.fn();
    act(() => {
      rerender(
        <XtermHost
          terminalId="host-1"
          isWriteEnabled
          label="Terminal output"
          onKeystroke={() => undefined}
          onActivateLink={() => undefined}
          onRendererMode={observedAfterRerender}
        />,
      );
    });

    // Three new functions and the same terminal. A mount effect that depended on
    // their identities would have disposed this emulator and built another, taking
    // the operator's scrollback and everything the shell had printed with it.
    expect(surfaceOf(container).firstElementChild).toBe(emulatorBefore);
    expect(observedAtMount).toHaveBeenCalledTimes(1);
    expect(observedAfterRerender).not.toHaveBeenCalled();
  });

  it("sends a keystroke to the callback the parent passed most recently", async () => {
    const firstKeystrokeHandler = vi.fn();
    const latestKeystrokeHandler = vi.fn();
    const { container, rerender } = await mountHost(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled
        label="Terminal output"
        onKeystroke={firstKeystrokeHandler}
      />,
    );
    act(() => {
      rerender(
        <XtermHost
          terminalId="host-1"
          isWriteEnabled
          label="Terminal output"
          onKeystroke={latestKeystrokeHandler}
        />,
      );
    });

    typeOneCharacter(surfaceOf(container));

    // Keeping the emulator is only half of it: an adapter still holding the mount
    // pass's function would send keystrokes to a handler the parent has replaced,
    // which is a keystroke silently going nowhere.
    expect(latestKeystrokeHandler).toHaveBeenCalledWith("a");
    expect(firstKeystrokeHandler).not.toHaveBeenCalled();
  });

  it("negative control: a different terminal DOES get a different emulator", async () => {
    // Without this the first case would pass against a component whose mount
    // effect never re-ran at all, which is a different bug and not a fix.
    const { container, rerender } = await mountHost(
      <XtermHost terminalId="host-1" isWriteEnabled label="Terminal output" />,
    );
    const emulatorBefore = surfaceOf(container).firstElementChild;
    act(() => {
      rerender(<XtermHost terminalId="host-2" isWriteEnabled label="Terminal output" />);
    });
    expect(surfaceOf(container).firstElementChild).not.toBe(emulatorBefore);
  });

  it("negative control: a watcher's keystroke reaches nobody", async () => {
    // And without this the case above would pass against a wrapper that forwarded
    // every keystroke regardless of the gate the adapter reads.
    const watcherKeystrokeHandler = vi.fn();
    const { container } = await mountHost(
      <XtermHost
        terminalId="host-2"
        isWriteEnabled={false}
        label="Terminal output"
        onKeystroke={watcherKeystrokeHandler}
      />,
    );
    typeOneCharacter(surfaceOf(container));
    expect(watcherKeystrokeHandler).not.toHaveBeenCalled();
  });
});

// The one moment the component can construct an emulator and never get a disposer.
//
// `subscribeToRendererMode` delivers the settled mode SYNCHRONOUSLY, inside the
// effect body and before its cleanup exists. A parent whose `onRendererMode` throws
// therefore threw out of the effect with the adapter already attached and its slot
// already taken, and React had nothing to dispose: the terminal, its observers, and
// its renderer allocation outlived the tree that made them.
//
// The adapter class is the real one the loader resolves — the spy observes it rather
// than standing in for it — so the claim is about what the component does to the
// emulator it actually built.
describe("a renderer-mode consumer that throws during the first delivery", () => {
  it("disposes the adapter, leaves no slot held, and still raises the failure", async () => {
    const dispose = vi.spyOn(XtermTerminalAdapter.prototype, "dispose");
    const consumerFailure = new Error("the renderer-mode consumer refused the delivery");
    render(
      <XtermHost
        terminalId="host-1"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={() => {
          throw consumerFailure;
        }}
      />,
    );

    await expect(settleEmulatorLoad()).rejects.toThrow(consumerFailure);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(terminalRendererPool.heldSlotCount).toBe(0);
    dispose.mockRestore();
  });

  it("negative control: a consumer that returns leaves the emulator running", async () => {
    // Without this, a component that disposed the adapter on every mount would
    // satisfy the case above and would tear the terminal down the moment it
    // reported which renderer it had settled on.
    const dispose = vi.spyOn(XtermTerminalAdapter.prototype, "dispose");
    const modes: string[] = [];
    const { container } = await mountHost(
      <XtermHost
        terminalId="host-2"
        isWriteEnabled={false}
        label="Terminal output"
        onRendererMode={(mode) => modes.push(mode)}
      />,
    );

    expect(modes.length).toBeGreaterThan(0);
    expect(dispose).not.toHaveBeenCalled();
    expect(surfaceOf(container).childElementCount).toBeGreaterThan(0);
    dispose.mockRestore();
  });
});
