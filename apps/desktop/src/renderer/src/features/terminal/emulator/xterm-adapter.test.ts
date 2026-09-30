// The emulator wrapper's own life: built once, kept across a detach, disposed once. Also its
// scrollback cap, what it spends on the page ledger, and the accessible view
// (`screenReaderMode` is set at construction).

import { afterEach, describe, expect, it } from "vitest";

import { Terminal } from "@xterm/xterm";

import { TERMINAL_DEFAULT_SCROLLBACK_LINES } from "../terminal-caps.js";
import { TerminalRendererPool } from "./renderer-pool.js";

import {
  RecordingRendererPool,
  attachedMountElement,
  disposeLiveEmulators,
  emulatorElementsIn,
  mountedAdapter,
  unattachedAdapter,
  writeLines,
  writeText,
} from "./xterm-adapter.test-support.js";

afterEach(disposeLiveEmulators);

describe("the emulator wrapper", () => {
  it("builds nothing until it is attached, and is live after", () => {
    const pool = new TerminalRendererPool();
    const adapter = unattachedAdapter({ terminalId: "t", pool });
    expect(adapter.isEmulatorLive).toBe(false);
    adapter.attach(attachedMountElement());
    expect(adapter.isEmulatorLive).toBe(true);
  });

  it("keeps the emulator across a detach, so a remount does not reallocate", async () => {
    const { adapter, mountElement } = mountedAdapter();
    await writeLines(adapter, 3);
    const linesBefore = adapter.bufferLineCount;
    adapter.detach();
    expect(adapter.isEmulatorLive).toBe(true);
    adapter.attach(mountElement);
    expect(adapter.bufferLineCount).toBe(linesBefore);
  });

  it("takes the emulator out of the mount element it is leaving", async () => {
    // The detached element leaves the screen with the tie; otherwise a live grid with an armed
    // data listener stays behind.
    const { adapter, mountElement } = mountedAdapter({ terminalId: "moved-away" });
    await writeText(adapter, "printed before the move\n");
    expect(emulatorElementsIn(mountElement)).toHaveLength(1);

    adapter.detach();

    expect(emulatorElementsIn(mountElement)).toHaveLength(0);
  });

  it("re-appends that same emulator on the next mount element, scrollback and all", async () => {
    // The element leaves and the emulator does not. `open()` returns early for a terminal that
    // already has an element, so the re-append is the adapter's own; a second element would
    // show up as two grids.
    const { adapter, mountElement } = mountedAdapter({ terminalId: "moved-on" });
    await writeText(adapter, "printed before the move\n");
    const nextMountElement = attachedMountElement();

    adapter.detach();
    adapter.attach(nextMountElement);

    expect(emulatorElementsIn(mountElement)).toHaveLength(0);
    expect(emulatorElementsIn(nextMountElement)).toHaveLength(1);
    expect(adapter.serialize()).toContain("printed before the move");
    expect(adapter.isEmulatorLive).toBe(true);
  });

  it("negative control: an attach to the mount element it is already on moves nothing", async () => {
    // Without this the cases above would pass against an adapter that removed and re-added the
    // element on every re-fit, dropping scroll position and focus.
    const { adapter, mountElement } = mountedAdapter({ terminalId: "already-here" });
    const grid = emulatorElementsIn(mountElement)[0];
    expect(grid).toBeDefined();

    adapter.attach(mountElement);

    expect(emulatorElementsIn(mountElement)[0]).toBe(grid);
  });

  it("caps the buffer at its scrollback rather than growing with the output", async () => {
    const { adapter } = mountedAdapter({ scrollbackLines: 200 });
    await writeLines(adapter, 2_000);
    // The ceiling is scrollback plus the visible grid; the grid height is the environment's,
    // so the claim is the bound.
    expect(adapter.bufferLineCount).toBeGreaterThan(200);
    expect(adapter.bufferLineCount).toBeLessThanOrEqual(200 + 100);
  });

  it("negative control: an unbounded buffer would exceed that ceiling", async () => {
    // Same writes, a scrollback ten times smaller: an appending array would differ by the
    // write count, not the cap.
    const { adapter } = mountedAdapter({ scrollbackLines: 20, terminalId: "small" });
    await writeLines(adapter, 2_000);
    expect(adapter.bufferLineCount).toBeLessThan(200);
  });

  it("defaults to the scrollback the budget was measured against", () => {
    const { adapter } = mountedAdapter();
    expect(adapter.scrollbackLines).toBe(TERMINAL_DEFAULT_SCROLLBACK_LINES);
  });
});

describe("teardown", () => {
  it("gives a disposed adapter's hold back", () => {
    const pool = new TerminalRendererPool();
    const { adapter } = mountedAdapter({ pool, terminalId: "pooled" });
    adapter.dispose();
    expect(pool.holds("pooled")).toBe(false);
  });

  it("is final and idempotent", () => {
    const { adapter } = mountedAdapter();
    adapter.dispose();
    expect(adapter.isDisposed).toBe(true);
    expect(adapter.isEmulatorLive).toBe(false);
    adapter.dispose();
    expect(adapter.isDisposed).toBe(true);
  });

  it("refuses to come back after disposal", () => {
    const { adapter, mountElement } = mountedAdapter();
    adapter.dispose();
    adapter.attach(mountElement);
    expect(adapter.isEmulatorLive).toBe(false);
  });

  it("lets go of the addons, which is what lets go of the buffer", async () => {
    const { adapter } = mountedAdapter();
    await writeText(adapter, "a line the serializer can see\n");
    // Live: the addon APIs answer, so the emulator behind them is reachable.
    expect(adapter.serialize()).toContain("a line the serializer can see");

    adapter.dispose();

    // Disposed: they answer their empty value. An addon kept as a field would outlive
    // `#terminal` and hold the whole emulator (measured: almost all of a full instance's bytes
    // survived a teardown; `tests/endurance/xterm-adapter.test.ts` holds it).
    expect(adapter.serialize()).toBe("");
    expect(adapter.findNext("a line the serializer can see")).toBe(false);
  });

  it("negative control: a live adapter DOES come back on attach", () => {
    const { adapter, mountElement } = mountedAdapter();
    adapter.detach();
    adapter.attach(mountElement);
    expect(adapter.isEmulatorLive).toBe(true);
  });

  it("negative control: a live adapter's serializer is not empty", async () => {
    // Without this the case above would pass against a serializer that always
    // returned the empty string.
    const { adapter } = mountedAdapter();
    await writeText(adapter, "still here\n");
    expect(adapter.serialize()).not.toBe("");
  });
});

describe("the context ledger, through the adapter", () => {
  /** A working day of opening and closing the pane, well past the page's cap. */
  const CHURN_CYCLES = 20;

  it("spends nothing on a host that has no WebGL2 to spend it on", () => {
    const pool = new RecordingRendererPool();
    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      const { adapter } = mountedAdapter({ pool, terminalId: `churn-${String(cycle)}` });
      adapter.dispose();
    }
    // The addon threw before making a context, so nothing counts; a terminal opened after
    // twenty cycles must still be able to take one on a host that later has one.
    expect(pool.createdContextCount).toBe(0);
    expect(pool.acquire("late-arrival")).toBeDefined();
  });

  it("negative control: the adapter did ask for one on every one of those cycles", () => {
    // Without this the case above would pass against an adapter that never
    // reached the ledger, which asserts nothing about how it hands one back.
    const pool = new RecordingRendererPool();
    for (let cycle = 0; cycle < CHURN_CYCLES; cycle += 1) {
      const { adapter } = mountedAdapter({ pool, terminalId: `asked-${String(cycle)}` });
      adapter.dispose();
    }
    expect(pool.acquiredTerminalIds).toHaveLength(CHURN_CYCLES);
    expect(pool.reclaimedTerminalIds).toHaveLength(CHURN_CYCLES);
  });

  it("gives up its hold on a teardown and does not reclaim the context", () => {
    const pool = new RecordingRendererPool();
    const { adapter } = mountedAdapter({ pool, terminalId: "torn-down" });
    // One reclaim already, from the renderer selection: this host has no WebGL2,
    // so the context was never created and the allowance went straight back.
    expect(pool.reclaimedTerminalIds).toStrictEqual(["torn-down"]);

    adapter.dispose();

    // The teardown adds no second hand-back: the selection already reclaimed the lease, so
    // reclaiming again would spend the allowance twice for a context that never existed. The
    // releasing arm needs an activating renderer and lives in `renderer-pool.context-loss.test.ts`.
    expect(pool.releasedTerminalIds).toStrictEqual([]);
    expect(pool.reclaimedTerminalIds).toStrictEqual(["torn-down"]);
  });
});

describe("the accessible view of the grid", () => {
  it("builds the row list and the live region a screen reader reads", async () => {
    const { adapter, mountElement } = mountedAdapter();
    await writeText(adapter, "the shell printed this\n");

    // The grid is a canvas (WebGL) or positioned spans (DOM), neither readable; this is the
    // readable form, which the library builds only when asked.
    expect(mountElement.querySelector(".xterm-accessibility")).not.toBeNull();
    const rowList = mountElement.querySelector(".xterm-accessibility-tree");
    expect(rowList?.getAttribute("role")).toBe("list");
    expect(rowList?.querySelectorAll('[role="listitem"]').length).toBeGreaterThan(0);
    expect(mountElement.querySelector('[aria-live="assertive"]')).not.toBeNull();
  });

  it("negative control: the library builds none of it under its own default", () => {
    // Driven against the library directly. `screenReaderMode` defaults to off, and off a screen
    // reader reaches the named group `XtermMountPoint` renders and finds nothing to read.
    const mountElement = attachedMountElement();
    const defaultOptionsTerminal = new Terminal({});
    try {
      defaultOptionsTerminal.open(mountElement);
      expect(mountElement.querySelector(".xterm-accessibility")).toBeNull();
      expect(mountElement.querySelector(".xterm-accessibility-tree")).toBeNull();
      expect(mountElement.querySelector('[aria-live="assertive"]')).toBeNull();
    } finally {
      defaultOptionsTerminal.dispose();
    }
  });
});
