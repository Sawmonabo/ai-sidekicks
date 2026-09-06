// The emulator wrapper's own life: built once, kept across a detach, disposed once.
//
// What the ADAPTER owns, as opposed to the three modules it composes: when the
// emulator comes into existence, which host element it is currently in, what its
// scrollback is capped at, what a teardown lets go of, and what it spends on the
// page's context ledger. The accessible view is here too, because
// `screenReaderMode` is an option this module constructs the terminal with.
//
// Against the real library, and cleaned up through the directory's one live-emulator
// registry — see `xterm-adapter.test-support.ts` for both reasons.

import { afterEach, describe, expect, it } from "vitest";

import { Terminal } from "@xterm/xterm";

import { TERMINAL_DEFAULT_SCROLLBACK_LINES } from "../../core/index.js";
import { TerminalRendererPool } from "./renderer-pool.js";

import {
  RecordingRendererPool,
  attachedHost,
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
    adapter.attach(attachedHost());
    expect(adapter.isEmulatorLive).toBe(true);
  });

  it("keeps the emulator across a detach, so a remount does not reallocate", async () => {
    const { adapter, host } = mountedAdapter();
    await writeLines(adapter, 3);
    const linesBefore = adapter.bufferLineCount;
    adapter.detach();
    expect(adapter.isEmulatorLive).toBe(true);
    adapter.attach(host);
    expect(adapter.bufferLineCount).toBe(linesBefore);
  });

  it("takes the emulator out of the host it is leaving", async () => {
    // The finding. Dropping the host reference and the size observer takes the
    // adapter off the box and takes nothing off the screen, so a detached pane went
    // on displaying a live grid whose data listener was still armed.
    const { adapter, host } = mountedAdapter({ terminalId: "moved-away" });
    await writeText(adapter, "printed before the move\n");
    expect(emulatorElementsIn(host)).toHaveLength(1);

    adapter.detach();

    expect(emulatorElementsIn(host)).toHaveLength(0);
  });

  it("re-appends that same emulator on the next host, scrollback and all", async () => {
    // The other half: the element leaves, and the EMULATOR does not. The pinned
    // library's `open()` returns early for a terminal it has already built one for,
    // so the re-append is the adapter's own — and a second `open()` that had built a
    // second element would show up here as two grids in the new host.
    const { adapter, host } = mountedAdapter({ terminalId: "moved-on" });
    await writeText(adapter, "printed before the move\n");
    const nextHost = attachedHost();

    adapter.detach();
    adapter.attach(nextHost);

    expect(emulatorElementsIn(host)).toHaveLength(0);
    expect(emulatorElementsIn(nextHost)).toHaveLength(1);
    expect(adapter.serialize()).toContain("printed before the move");
    expect(adapter.isEmulatorLive).toBe(true);
  });

  it("negative control: an attach to the host it is already on moves nothing", async () => {
    // Without this the cases above would pass against an adapter that tore the
    // element out and put it back on every re-fit, which would drop the operator's
    // scroll position and the focus with it.
    const { adapter, host } = mountedAdapter({ terminalId: "already-here" });
    const grid = emulatorElementsIn(host)[0];
    expect(grid).toBeDefined();

    adapter.attach(host);

    expect(emulatorElementsIn(host)[0]).toBe(grid);
  });

  it("caps the buffer at its scrollback rather than growing with the output", async () => {
    const { adapter } = mountedAdapter({ scrollbackLines: 200 });
    await writeLines(adapter, 2_000);
    // The ceiling is the scrollback plus the visible grid; the exact grid height
    // is the environment's, so the claim is the bound and not a magic total.
    expect(adapter.bufferLineCount).toBeGreaterThan(200);
    expect(adapter.bufferLineCount).toBeLessThanOrEqual(200 + 100);
  });

  it("negative control: an unbounded buffer would exceed that ceiling", async () => {
    // Same writes, a scrollback ten times smaller — if the ring were an appending
    // array the two readings would differ by the write count rather than by the cap.
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
  it("gives a disposed adapter's slot back", () => {
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
    const { adapter, host } = mountedAdapter();
    adapter.dispose();
    adapter.attach(host);
    expect(adapter.isEmulatorLive).toBe(false);
  });

  it("lets go of the addons, which is what lets go of the buffer", async () => {
    const { adapter } = mountedAdapter();
    await writeText(adapter, "a line the serializer can see\n");
    // Live: the addon surfaces answer, so the emulator behind them is reachable.
    expect(adapter.serialize()).toContain("a line the serializer can see");

    adapter.dispose();

    // Disposed: they answer their empty value rather than reaching a terminal
    // this object still holds. An addon kept as a field outlives `#terminal` and
    // holds the whole emulator through it — measured, before this was fixed, as
    // almost all of a full instance's bytes surviving a teardown, which is what
    // `test/console/endurance/terminal-endurance.test.ts` holds it to.
    expect(adapter.serialize()).toBe("");
    expect(adapter.findNext("a line the serializer can see")).toBe(false);
  });

  it("negative control: a live adapter DOES come back on attach", () => {
    const { adapter, host } = mountedAdapter();
    adapter.detach();
    adapter.attach(host);
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
    // The addon threw before it made a context, so there is nothing out there to
    // count — and a terminal opened after twenty cycles must still be able to take
    // one on a host that later has one to give.
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

    // The teardown adds no second hand-back of either kind. There is no context to
    // give up on this host — the selection already reclaimed the lease it was
    // granted, and a hand-back names the LEASE now, so there is nothing left to
    // name. Reclaiming again would spend the page's allowance twice for one
    // context that never existed.
    //
    // The other arm — a teardown of a terminal that really is holding one, which
    // releases and does not reclaim — needs a renderer that activates, so it lives
    // in `renderer-pool.context-loss.test.ts` where one does.
    expect(pool.releasedTerminalIds).toStrictEqual([]);
    expect(pool.reclaimedTerminalIds).toStrictEqual(["torn-down"]);
  });
});

describe("the accessible view of the grid", () => {
  it("builds the row list and the live region a screen reader reads", async () => {
    const { adapter, host } = mountedAdapter();
    await writeText(adapter, "the shell printed this\n");

    // The grid itself is a canvas under the WebGL renderer and positioned spans
    // under the DOM one, and neither is readable. This is the readable form, and
    // the library builds it only when it is asked to.
    expect(host.querySelector(".xterm-accessibility")).not.toBeNull();
    const rowList = host.querySelector(".xterm-accessibility-tree");
    expect(rowList?.getAttribute("role")).toBe("list");
    expect(rowList?.querySelectorAll('[role="listitem"]').length).toBeGreaterThan(0);
    expect(host.querySelector('[aria-live="assertive"]')).not.toBeNull();
  });

  it("negative control: the library builds none of it under its own default", () => {
    // Driven against the library directly, because the wrapper no longer has the
    // shape that produced this. `screenReaderMode` defaults to off, and with it
    // off a screen reader reaches the named group `XtermHost` renders and finds
    // nothing inside it to read.
    const host = attachedHost();
    const defaultOptionsTerminal = new Terminal({});
    try {
      defaultOptionsTerminal.open(host);
      expect(host.querySelector(".xterm-accessibility")).toBeNull();
      expect(host.querySelector(".xterm-accessibility-tree")).toBeNull();
      expect(host.querySelector('[aria-live="assertive"]')).toBeNull();
    } finally {
      defaultOptionsTerminal.dispose();
    }
  });
});
