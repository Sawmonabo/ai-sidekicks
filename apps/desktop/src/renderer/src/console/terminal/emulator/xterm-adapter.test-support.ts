// One live-emulator registry, and the builders every suite in this directory mounts
// through.
//
// Every case in this directory drives `@xterm/xterm` itself — no stand-in, no mock
// terminal. A local fake would prove that the wrapper calls the methods the fake
// declares, which is the one thing worth nothing: the constraints these modules exist
// to keep are all properties of the library's behaviour (a scrollback that evicts, a
// `disableStdin` that gates, an addon that throws without WebGL2), and a fake keeps
// whichever of them it was written to keep.
//
// So every suite has the same two obligations — dispose the emulators it built and
// take its host boxes out of the document — and an emulator left live is a WebGL
// context, a data listener, and a scrollback ring surviving into the next case. One
// registry here rather than a copy per suite: parallel teardown loops drift into
// several ideas of what "cleaned up" means, and the suite whose loop is weaker leaks
// into its neighbour. The number of consumers is deliberately not stated — it moves
// with every case file the directory adds, and a count in prose is a claim nothing
// checks.
//
// WHAT THE ENVIRONMENT CAN AND CANNOT ANSWER. The DOM shim has no WebGL2, so every
// instance built here settles on the DOM renderer — which is exactly the fallback path
// the pool's cap and the context-loss handler both lead to, so it is the arm worth
// exercising by default. The one path it cannot reach is a renderer that ACTIVATES,
// and that is `webgl-fallback.test-support.ts`'s, which stands the addon in.

import { vi } from "vitest";

import { TerminalRendererPool, type TerminalContextLease } from "./renderer-pool.js";
import { XtermTerminalAdapter } from "./xterm-adapter.js";

const liveAdapters: XtermTerminalAdapter[] = [];
const liveHosts: HTMLElement[] = [];

/**
 * The real ledger, with a note of which call each arm of the adapter made.
 *
 * A subclass and not a stand-in: every method runs the real accounting through
 * `super`, and the arrays only record that it was reached. They are what keeps the
 * churn case from being vacuous — without them it would pass just as well against an
 * adapter that never asked for a context at all.
 */
export class RecordingRendererPool extends TerminalRendererPool {
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

/** Hold an adapter for the teardown below. Returned, so a case reads as one line. */
export function trackAdapter(adapter: XtermTerminalAdapter): XtermTerminalAdapter {
  liveAdapters.push(adapter);
  return adapter;
}

/** A host box in the live document, cleaned up with the rest after each case. */
export function attachedHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  liveHosts.push(host);
  return host;
}

/** Every emulator element inside one host. The library's own root class. */
export function emulatorElementsIn(host: HTMLElement): NodeListOf<Element> {
  return host.querySelectorAll(".xterm");
}

type AdapterOptions = Partial<ConstructorParameters<typeof XtermTerminalAdapter>[0]>;

/**
 * An adapter that exists and is attached to nothing, for the cases about what a
 * wrapper reports BEFORE it has a host.
 */
export function unattachedAdapter(options: AdapterOptions = {}): XtermTerminalAdapter {
  return trackAdapter(
    new XtermTerminalAdapter({
      terminalId: "session-terminal",
      pool: new TerminalRendererPool(),
      ...options,
    }),
  );
}

export function mountedAdapter(options: AdapterOptions = {}): {
  adapter: XtermTerminalAdapter;
  host: HTMLElement;
} {
  const adapter = unattachedAdapter(options);
  const host = attachedHost();
  adapter.attach(host);
  return { adapter, host };
}

/** Write and wait for the parser to drain, which is the only honest way to read after. */
export async function writeLines(adapter: XtermTerminalAdapter, lineCount: number): Promise<void> {
  const chunk = Array.from(
    { length: lineCount },
    (_unused, index) => `line ${String(index)}\n`,
  ).join("");
  await writeText(adapter, chunk);
}

/** One write, awaited through the library's own completion callback. */
export async function writeText(adapter: XtermTerminalAdapter, text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    adapter.write(text, resolve);
  });
}

/** Every suite's `afterEach`. An emulator left live outlives the case that built it. */
export function disposeLiveEmulators(): void {
  for (const adapter of liveAdapters.splice(0)) {
    adapter.dispose();
  }
  for (const host of liveHosts.splice(0)) {
    host.remove();
  }
  vi.unstubAllGlobals();
}
