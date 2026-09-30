// The tie between one emulator and one mount element: the write gate and the size seam. The
// gate is applied twice (the `disableStdin` option and the check inside `onData`), because
// sending a keystroke nobody was allowed to send is the expensive mistake on a shared shell.
// A detached emulator has no box, so it reports the shut gate and re-opens it on the next
// mount element.

import { afterEach, describe, expect, it, vi } from "vitest";

import { installFakeResizeObserver } from "@test/helpers/element-resize.js";
import { TerminalRendererPool } from "./renderer-pool.js";

import {
  attachedMountElement,
  disposeLiveEmulators,
  mountedAdapter,
  unattachedAdapter,
} from "./xterm-adapter.test-support.js";

afterEach(disposeLiveEmulators);

// The grid re-fits when its mount element's box changes, through the console's one size seam.
// The environment has no `ResizeObserver`, so the fake in `tests/helpers/element-resize.ts` makes
// the seam reachable. `fitToMountPoint` is spied, not stubbed, so the assertions reach the real
// re-fit; the fit itself is the addon's and needs a measurable box.
describe("the grid's size source", () => {
  it("re-fits when a size change is delivered for its own mount element", () => {
    const resizeObserver = installFakeResizeObserver();
    const { adapter, mountElement } = mountedAdapter({ terminalId: "sized" });
    // One observer, on the mount element, armed by the attach rather than by a timer.
    expect(resizeObserver.observedCount()).toBe(1);
    const refit = vi.spyOn(adapter, "fitToMountPoint");

    resizeObserver.deliverFor(mountElement);

    expect(refit).toHaveBeenCalledTimes(1);
  });

  it("stops listening once the emulator is off screen", () => {
    const resizeObserver = installFakeResizeObserver();
    const { adapter, mountElement } = mountedAdapter({ terminalId: "detached" });
    const refit = vi.spyOn(adapter, "fitToMountPoint");

    adapter.detach();
    resizeObserver.deliverFor(mountElement);

    // Disconnected rather than merely ignored: an observer left armed over an element
    // a pane has dropped keeps that element reachable for as long as the adapter lives.
    expect(resizeObserver.liveObserverCount()).toBe(0);
    expect(refit).not.toHaveBeenCalled();
  });

  it("negative control: a size change somewhere else is not this terminal's", () => {
    // Without this the cases above would pass against an adapter that re-fitted on every
    // delivery in the document.
    const resizeObserver = installFakeResizeObserver();
    const { adapter } = mountedAdapter({ terminalId: "elsewhere" });
    const refit = vi.spyOn(adapter, "fitToMountPoint");

    resizeObserver.deliverFor(document.createElement("div"));

    expect(refit).not.toHaveBeenCalled();
  });
});

describe("the write gate — watch mode is the default", () => {
  it("starts unable to accept input", () => {
    const { adapter } = mountedAdapter();
    expect(adapter.isWriteEnabled).toBe(false);
  });

  it("moves the library's own gate, not just its own field", () => {
    const { adapter } = mountedAdapter();
    expect(adapter.isStdinDisabled).toBe(true);
    adapter.setWriteEnabled(true);
    expect(adapter.isWriteEnabled).toBe(true);
    expect(adapter.isStdinDisabled).toBe(false);
    adapter.setWriteEnabled(false);
    expect(adapter.isStdinDisabled).toBe(true);
  });

  it("takes a lease that was already open at construction, without a second call", () => {
    // The mount point builds a fresh emulator under a lease that did not move, so the answer
    // travels with the build; correcting the binding afterwards is briefly wrong.
    const { adapter } = mountedAdapter({ terminalId: "born-writable", isWriteEnabled: true });

    expect(adapter.isWriteEnabled).toBe(true);
    expect(adapter.isStdinDisabled).toBe(false);
  });

  it("opens the gate before the emulator exists and still starts it shut", () => {
    const pool = new TerminalRendererPool();
    const adapter = unattachedAdapter({ terminalId: "later", pool });
    expect(adapter.isStdinDisabled).toBeUndefined();
    adapter.attach(attachedMountElement());
    expect(adapter.isStdinDisabled).toBe(true);
  });

  it("shuts the gate while the emulator is off screen and re-opens it on the next mount element", () => {
    // The write state belongs to the tie: a detached emulator has no box to click, so an open
    // gate there accepts input nobody can see, and the next mount element gets the lease's
    // answer without being told again.
    const { adapter, mountElement } = mountedAdapter({ terminalId: "gated-by-mount" });
    adapter.setWriteEnabled(true);
    expect(adapter.isStdinDisabled).toBe(false);

    adapter.detach();

    expect(adapter.isWriteEnabled).toBe(false);
    expect(adapter.isStdinDisabled).toBe(true);

    adapter.attach(mountElement);

    expect(adapter.isWriteEnabled).toBe(true);
    expect(adapter.isStdinDisabled).toBe(false);
  });

  it("negative control: a mount element does not open a gate the lease never opened", () => {
    // Without it the case above would pass against a binding that opened stdin on every attach.
    const { adapter, mountElement } = mountedAdapter({ terminalId: "watcher-remount" });

    adapter.detach();
    adapter.attach(mountElement);

    expect(adapter.isWriteEnabled).toBe(false);
    expect(adapter.isStdinDisabled).toBe(true);
  });

  it("negative control: a wrapper that mirrored the field would pass the reading and not the gate", () => {
    const { adapter } = mountedAdapter();
    adapter.setWriteEnabled(true);
    // The two are read from different places on purpose. If `setWriteEnabled` only
    // wrote the private field, this pair would disagree.
    expect(adapter.isWriteEnabled).toBe(true);
    expect(adapter.isStdinDisabled).not.toBe(true);
  });
});
