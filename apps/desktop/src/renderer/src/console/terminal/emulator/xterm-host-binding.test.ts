// The tie between one emulator and one host: the write gate, and the size seam.
//
// Both halves belong to the TIE rather than to the emulator. Watch mode is the
// default and the gate is applied twice on purpose — the `disableStdin` option and
// the check inside `onData` — because the expensive mistake on a shared shell is
// sending a keystroke nobody was allowed to send. And a detached emulator has no
// box to be measured against, so it reports the shut gate and re-opens it, without
// being told again, on the host that takes it next.
//
// Against the real library, and cleaned up through the directory's one live-emulator
// registry — see `xterm-adapter.test-support.ts` for both reasons.

import { afterEach, describe, expect, it, vi } from "vitest";

import { installFakeResizeObserver } from "../../primitives/element-resize.test-support.js";
import { TerminalRendererPool } from "./renderer-pool.js";

import {
  attachedHost,
  disposeLiveEmulators,
  mountedAdapter,
  unattachedAdapter,
} from "./xterm-adapter.test-support.js";

afterEach(disposeLiveEmulators);

// The grid re-fits when its host box changes, and it does so through the console's
// ONE size seam.
//
// The environment implements no `ResizeObserver`, so the fake is what makes the seam
// reachable here at all — and it is `primitives/element-resize.test-support.ts`'s,
// the same one three browser suites drive, because a second fake beside this one
// would be the duplication the hoist removed reappearing in the test tier.
//
// `fitToHost` is watched rather than stubbed: the spy calls through, so what the
// cases below assert is that a delivery reached the real re-fit. The fit ITSELF is
// the addon's and is exercised where a box can be measured; in this environment the
// host has no layout, so the addon's own division is undefined and the adapter
// swallows it by design.
describe("the grid's size source", () => {
  it("re-fits when a size change is delivered for its own host", () => {
    const resizeObserver = installFakeResizeObserver();
    const { adapter, host } = mountedAdapter({ terminalId: "sized" });
    // One observer, on the host, armed by the attach rather than by a timer.
    expect(resizeObserver.observedCount()).toBe(1);
    const refit = vi.spyOn(adapter, "fitToHost");

    resizeObserver.deliverFor(host);

    expect(refit).toHaveBeenCalledTimes(1);
  });

  it("stops listening once the emulator is off screen", () => {
    const resizeObserver = installFakeResizeObserver();
    const { adapter, host } = mountedAdapter({ terminalId: "detached" });
    const refit = vi.spyOn(adapter, "fitToHost");

    adapter.detach();
    resizeObserver.deliverFor(host);

    // Disconnected rather than merely ignored: an observer left armed over a host a
    // pane has dropped keeps that element reachable for as long as the adapter lives.
    expect(resizeObserver.liveObserverCount()).toBe(0);
    expect(refit).not.toHaveBeenCalled();
  });

  it("negative control: a size change somewhere else is not this terminal's", () => {
    // Without this the cases above would pass against an adapter that re-fitted on
    // every delivery in the document, which is a terminal that re-measures itself
    // whenever any other pane resizes.
    const resizeObserver = installFakeResizeObserver();
    const { adapter } = mountedAdapter({ terminalId: "elsewhere" });
    const refit = vi.spyOn(adapter, "fitToHost");

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
    // A surface builds a fresh emulator for every terminal id and every capability
    // change, under a lease that did not move with it. Correcting the binding after
    // construction is a binding that was briefly wrong and a correction a caller can
    // forget, so the answer travels with the build.
    const { adapter } = mountedAdapter({ terminalId: "born-writable", isWriteEnabled: true });

    expect(adapter.isWriteEnabled).toBe(true);
    expect(adapter.isStdinDisabled).toBe(false);
  });

  it("opens the gate before the emulator exists and still starts it shut", () => {
    const pool = new TerminalRendererPool();
    const adapter = unattachedAdapter({ terminalId: "later", pool });
    expect(adapter.isStdinDisabled).toBeUndefined();
    adapter.attach(attachedHost());
    expect(adapter.isStdinDisabled).toBe(true);
  });

  it("shuts the gate while the emulator is off screen and re-opens it on the next host", () => {
    // The write state belongs to the TIE. A detached emulator has no box to click
    // and no host to be measured against, so a gate left open there is an emulator
    // accepting input for a surface nobody can see — and the lease has not moved, so
    // the next host gets the answer the lease gave without being told again.
    const { adapter, host } = mountedAdapter({ terminalId: "gated-by-host" });
    adapter.setWriteEnabled(true);
    expect(adapter.isStdinDisabled).toBe(false);

    adapter.detach();

    expect(adapter.isWriteEnabled).toBe(false);
    expect(adapter.isStdinDisabled).toBe(true);

    adapter.attach(host);

    expect(adapter.isWriteEnabled).toBe(true);
    expect(adapter.isStdinDisabled).toBe(false);
  });

  it("negative control: a host does not open a gate the lease never opened", () => {
    // Without it the case above would pass against a binding that opened stdin on
    // every attach, which is watch mode failing open on the one surface where the
    // expensive mistake is sending a keystroke nobody was allowed to send.
    const { adapter, host } = mountedAdapter({ terminalId: "watcher-remount" });

    adapter.detach();
    adapter.attach(host);

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
