// The emulator wrapper, against the real library.
//
// Every case here drives `@xterm/xterm` itself — no stand-in, no mock terminal.
// A local fake would prove that the wrapper calls the methods the fake declares,
// which is the one thing worth nothing: the constraints this module exists to
// keep are all properties of the library's behaviour (a scrollback that evicts, a
// `disableStdin` that gates, an addon that throws without WebGL2), and a fake
// keeps whichever of them it was written to keep.
//
// WHAT THE ENVIRONMENT CAN AND CANNOT ANSWER. The DOM shim has no WebGL2, so
// every instance here settles on the DOM renderer — which is exactly the fallback
// path the pool's cap and the context-loss handler both lead to, so it is the arm
// worth exercising by default. The pool's own accounting is asserted directly,
// because it is arithmetic over ids rather than anything a renderer decides.

import { Terminal, type ILink, type ILinkProvider } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installFakeResizeObserver } from "../primitives/element-resize.test-support.js";
import { TERMINAL_DEFAULT_SCROLLBACK_LINES } from "../core/index.js";
import { TerminalRendererPool, type TerminalContextLease } from "./renderer-pool.js";
import { XtermTerminalAdapter } from "./xterm-adapter.js";

const liveAdapters: XtermTerminalAdapter[] = [];
const liveHosts: HTMLElement[] = [];

/**
 * The real ledger, with a note of which call each arm of the adapter made.
 *
 * A subclass and not a stand-in: every method runs the real accounting through
 * `super`, and the arrays only record that it was reached. They are what keeps
 * the churn case below from being vacuous — without them it would pass just as
 * well against an adapter that never asked for a context at all.
 */
class RecordingRendererPool extends TerminalRendererPool {
  public readonly acquiredTerminalIds: string[] = [];
  public readonly releasedTerminalIds: string[] = [];
  public readonly reclaimedTerminalIds: string[] = [];

  public override acquire(terminalId: string): TerminalContextLease | undefined {
    this.acquiredTerminalIds.push(terminalId);
    return super.acquire(terminalId);
  }

  public override release(lease: TerminalContextLease): void {
    this.releasedTerminalIds.push(lease.terminalId);
    super.release(lease);
  }

  public override reclaim(lease: TerminalContextLease): void {
    this.reclaimedTerminalIds.push(lease.terminalId);
    super.reclaim(lease);
  }
}

/** A host box in the live document, cleaned up with the rest after each case. */
function attachedHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  liveHosts.push(host);
  return host;
}

/** Every emulator element inside one host. The library's own root class. */
function emulatorElementsIn(host: HTMLElement): NodeListOf<Element> {
  return host.querySelectorAll(".xterm");
}

function mountedAdapter(
  options: Partial<ConstructorParameters<typeof XtermTerminalAdapter>[0]> = {},
): { adapter: XtermTerminalAdapter; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.append(host);
  liveHosts.push(host);
  const adapter = new XtermTerminalAdapter({
    terminalId: "session-terminal",
    pool: new TerminalRendererPool(),
    ...options,
  });
  liveAdapters.push(adapter);
  adapter.attach(host);
  return { adapter, host };
}

/** Write and wait for the parser to drain, which is the only honest way to read after. */
async function writeLines(adapter: XtermTerminalAdapter, lineCount: number): Promise<void> {
  const chunk = Array.from(
    { length: lineCount },
    (_unused, index) => `line ${String(index)}\n`,
  ).join("");
  await writeText(adapter, chunk);
}

/** One write, awaited through the library's own completion callback. */
async function writeText(adapter: XtermTerminalAdapter, text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    adapter.write(text, resolve);
  });
}

afterEach(() => {
  for (const adapter of liveAdapters.splice(0)) {
    adapter.dispose();
  }
  for (const host of liveHosts.splice(0)) {
    host.remove();
  }
  vi.unstubAllGlobals();
});

describe("the emulator wrapper", () => {
  it("builds nothing until it is attached, and is live after", () => {
    const pool = new TerminalRendererPool();
    const adapter = new XtermTerminalAdapter({ terminalId: "t", pool });
    liveAdapters.push(adapter);
    expect(adapter.isEmulatorLive).toBe(false);
    const host = document.createElement("div");
    document.body.append(host);
    liveHosts.push(host);
    adapter.attach(host);
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

describe("the renderer mode, as something a surface can follow", () => {
  it("delivers the current mode on subscribe, before an emulator exists", () => {
    // Read-then-subscribe is the bug this shape removes: a consumer that copied
    // the mode and subscribed afterwards would hold a value from before its own
    // subscription. The mode a fresh adapter reports is the fallback, because
    // nothing has been selected yet.
    const adapter = new XtermTerminalAdapter({
      terminalId: "unattached",
      pool: new TerminalRendererPool(),
    });
    liveAdapters.push(adapter);
    const observed: string[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));
    expect(observed).toStrictEqual(["dom"]);
  });

  it("says nothing further on a host that never had a context to lose", () => {
    // This environment has no WebGL2, so the selection settles on the mode the
    // instance was constructed with. Announcing that would report a fallback that
    // never happened — the change the emulator's own context loss makes is
    // `webgl-context-loss.test.tsx`'s subject.
    const { adapter } = mountedAdapter({ terminalId: "no-context" });
    const observed: string[] = [];
    adapter.subscribeToRendererMode((mode) => observed.push(mode));
    adapter.dispose();
    expect(observed).toStrictEqual(["dom"]);
  });
});

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
    const adapter = new XtermTerminalAdapter({ terminalId: "later", pool });
    liveAdapters.push(adapter);
    expect(adapter.isStdinDisabled).toBeUndefined();
    const host = document.createElement("div");
    document.body.append(host);
    liveHosts.push(host);
    adapter.attach(host);
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
    // in `webgl-context-loss.test.tsx` where one does.
    expect(pool.releasedTerminalIds).toStrictEqual([]);
    expect(pool.reclaimedTerminalIds).toStrictEqual(["torn-down"]);
  });
});

/**
 * Every link provider the adapter registers on its own terminal, in order.
 *
 * The library's public `registerLinkProvider` is the only door an addon has, and
 * xterm.js registers its own OSC 8 provider through an internal service rather
 * than through it — so what this records is exactly what the ADAPTER registered,
 * and against the old adapter it records nothing. The original is still called, so
 * the emulator behaves as it does in the shell; this only watches the door.
 */
function recordLinkProvidersRegisteredBy(build: () => XtermTerminalAdapter): ILinkProvider[] {
  const registered: ILinkProvider[] = [];
  const register = Terminal.prototype.registerLinkProvider;
  const watch = vi.spyOn(Terminal.prototype, "registerLinkProvider").mockImplementation(function (
    this: Terminal,
    linkProvider: ILinkProvider,
  ) {
    registered.push(linkProvider);
    return register.call(this, linkProvider);
  });
  try {
    build();
  } finally {
    watch.mockRestore();
  }
  return registered;
}

/** The links one provider offers for one buffer row. `y` is one-based, as xterm counts. */
function linksOnRow(linkProvider: ILinkProvider, row: number): ILink[] {
  let offered: ILink[] = [];
  linkProvider.provideLinks(row, (links) => {
    offered = links ?? [];
  });
  return offered;
}

describe("printed URLs, not just the hyperlinks a program marked", () => {
  /**
   * Write one line and hand back the links the adapter's provider offers for it.
   *
   * The whole path, through the real emulator: the text goes through the parser,
   * lands in the buffer, and the provider reads it back out of that buffer — which
   * is what makes this a claim about a shell printing a URL rather than about a
   * regular expression.
   */
  async function linksPrintedBy(
    line: string,
    onActivateLink: (url: string) => void,
  ): Promise<ILink[]> {
    const host = document.createElement("div");
    document.body.append(host);
    liveHosts.push(host);
    const [linkProvider] = recordLinkProvidersRegisteredBy(() => {
      const adapter = new XtermTerminalAdapter({
        terminalId: "links",
        pool: new TerminalRendererPool(),
        onActivateLink,
      });
      liveAdapters.push(adapter);
      adapter.attach(host);
      return adapter;
    });
    if (linkProvider === undefined) {
      // Raised rather than answered with an empty list, so the refusal cases below
      // cannot pass vacuously. This is the old adapter's state for every case in
      // this block: `linkHandler` governs OSC 8 hyperlinks and registers no
      // provider, so printed text was offered as a link through no path at all.
      throw new Error("the adapter registered no link provider");
    }
    const adapter = liveAdapters.at(-1);
    if (adapter === undefined) {
      throw new Error("no adapter was built");
    }
    await writeText(adapter, `${line}\n`);
    return linksOnRow(linkProvider, 1);
  }

  it("offers a printed https URL as an activatable link", async () => {
    const opened = vi.fn();
    const links = await linksPrintedBy("see https://example.test/a for details", opened);
    expect(links).toHaveLength(1);
    expect(links[0]?.text).toBe("https://example.test/a");

    links[0]?.activate(new MouseEvent("click"), links[0].text);
    expect(opened).toHaveBeenCalledWith("https://example.test/a");
  });

  it("hands the opener the PARSED href, so the guard is on the path", async () => {
    const opened = vi.fn();
    const links = await linksPrintedBy("http://example.test", opened);
    links[0]?.activate(new MouseEvent("click"), links[0]?.text ?? "");
    // The printed text has no trailing slash and the parsed href does. A handler
    // that forwarded the matched text untouched would answer without one, so this
    // is evidence the allow-list ran rather than that a callback fired.
    expect(opened).toHaveBeenCalledWith("http://example.test/");
  });

  it("offers no link at all for a scheme the allow-list refuses", async () => {
    const opened = vi.fn();
    // A terminal renders whatever a process writes, so this line is what an
    // attacker-controlled program prints. Nothing is decorated, so there is nothing
    // to click — the guard is the second gate and not the only one.
    const links = await linksPrintedBy("javascript:alert(1) file:///etc/passwd", opened);
    expect(links).toStrictEqual([]);
    expect(opened).not.toHaveBeenCalled();
  });

  it("registers no provider for a surface with nowhere to send a link", async () => {
    // An underlined URL whose click does nothing is an affordance that lies, so the
    // provider is gated on the sink the way `onData` is gated on the writer.
    const host = document.createElement("div");
    document.body.append(host);
    liveHosts.push(host);
    const registered = recordLinkProvidersRegisteredBy(() => {
      const adapter = new XtermTerminalAdapter({
        terminalId: "no-link-sink",
        pool: new TerminalRendererPool(),
      });
      liveAdapters.push(adapter);
      adapter.attach(host);
      return adapter;
    });
    expect(registered).toStrictEqual([]);
  });

  it("negative control: the recorder sees nothing when no provider is registered", async () => {
    // Which is also the old adapter's behaviour for every case above — printed text
    // reached `onActivateLink` through no path, because no provider existed to
    // offer it. Without this the cases above could pass against a recorder that
    // reported a provider the adapter never registered.
    const opened = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    liveHosts.push(host);
    const adapter = new XtermTerminalAdapter({
      terminalId: "unwatched",
      pool: new TerminalRendererPool(),
      onActivateLink: opened,
    });
    liveAdapters.push(adapter);
    const registered = recordLinkProvidersRegisteredBy(() => adapter);
    expect(registered).toStrictEqual([]);
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
    const host = document.createElement("div");
    document.body.append(host);
    liveHosts.push(host);
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
