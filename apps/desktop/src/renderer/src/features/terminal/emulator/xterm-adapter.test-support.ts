// One live-emulator registry and the builders every suite here mounts through. The suites drive
// the real `@xterm/xterm`, because what they check (scrollback eviction, `disableStdin` gating,
// an addon that throws without WebGL2) is library behavior a fake would only mirror. The DOM
// shim has no WebGL2, so instances settle on the DOM renderer; `webgl-fallback.test-support.ts`
// stands in an activating one.

import { vi } from "vitest";

import { TerminalRendererPool, type TerminalContextLease } from "./renderer-pool.js";
import { XtermTerminalAdapter } from "./xterm-adapter.js";

const liveAdapters: XtermTerminalAdapter[] = [];
const liveMountElements: HTMLElement[] = [];

/**
 * The real ledger, recording which call each adapter arm made, so the churn case cannot pass
 * against an adapter that never asked for a context.
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

/** A mount element in the live document, cleaned up with the rest after each case. */
export function attachedMountElement(): HTMLElement {
  const mountElement = document.createElement("div");
  document.body.append(mountElement);
  liveMountElements.push(mountElement);
  return mountElement;
}

/** Every emulator element inside one mount element. The library's own root class. */
export function emulatorElementsIn(mountElement: HTMLElement): NodeListOf<Element> {
  return mountElement.querySelectorAll(".xterm");
}

/** An adapter attached to nothing, for what a wrapper reports before it has a mount element. */
export function unattachedAdapter(options: AdapterOptions = {}): XtermTerminalAdapter {
  return trackAdapter(
    new XtermTerminalAdapter({
      terminalId: "session-terminal",
      pool: new TerminalRendererPool(),
      ...options,
    }),
  );
}

/** An adapter attached to a fresh mount element in the document. */
export function mountedAdapter(options: AdapterOptions = {}): {
  adapter: XtermTerminalAdapter;
  mountElement: HTMLElement;
} {
  const adapter = unattachedAdapter(options);
  const mountElement = attachedMountElement();
  adapter.attach(mountElement);
  return { adapter, mountElement };
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
  for (const mountElement of liveMountElements.splice(0)) {
    mountElement.remove();
  }
  vi.unstubAllGlobals();
}

type AdapterOptions = Partial<ConstructorParameters<typeof XtermTerminalAdapter>[0]>;
