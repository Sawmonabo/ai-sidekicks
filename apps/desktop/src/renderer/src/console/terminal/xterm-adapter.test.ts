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

import { afterEach, describe, expect, it } from "vitest";

import { TERMINAL_DEFAULT_SCROLLBACK_LINES } from "./constants.js";
import { TerminalRendererPool } from "./renderer-pool.js";
import {
  TERMINAL_LINK_SCHEMES,
  XtermTerminalAdapter,
  allowedTerminalLinkHref,
} from "./xterm-adapter.js";

const liveAdapters: XtermTerminalAdapter[] = [];
const liveHosts: HTMLElement[] = [];

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

describe("the link scheme guard", () => {
  it("closes the allow-list at the two schemes a terminal link may open", () => {
    expect([...TERMINAL_LINK_SCHEMES]).toStrictEqual(["http:", "https:"]);
  });

  it("passes an ordinary web link through, normalized", () => {
    expect(allowedTerminalLinkHref("https://example.test/a")).toBe("https://example.test/a");
    expect(allowedTerminalLinkHref("http://example.test")).toBe("http://example.test/");
  });

  it("refuses the schemes a program can print to attack the shell that renders it", () => {
    // A terminal renders whatever a process writes, so the printed text is
    // attacker-controlled whenever the process is.
    expect(allowedTerminalLinkHref("javascript:alert(1)")).toBeUndefined();
    expect(allowedTerminalLinkHref("file:///etc/passwd")).toBeUndefined();
    expect(allowedTerminalLinkHref("data:text/html,<script>x</script>")).toBeUndefined();
  });

  it("negative control: an unparseable string is refused rather than passed through", () => {
    // A guard that only checked for a banned prefix would let this reach an opener.
    expect(allowedTerminalLinkHref("not a url at all")).toBeUndefined();
    expect(allowedTerminalLinkHref("")).toBeUndefined();
  });
});
