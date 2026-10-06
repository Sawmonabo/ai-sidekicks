// One live-emulator registry and the builders every suite here mounts through. The suites drive
// the real `@xterm/xterm`, because what they check (scrollback across a move, `disableStdin`
// gating) is library behavior a fake would only mirror. The DOM shim has no WebGL2, so instances
// settle on the DOM renderer; `webgl-fallback.test-support.ts` stands in an activating one.

import { vi } from "vitest";

import { TerminalRendererPool } from "../renderer-pool.js";
import { XtermTerminalAdapter } from "./adapter.js";

const liveAdapters: XtermTerminalAdapter[] = [];
const liveMountElements: HTMLElement[] = [];

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

/**
 * One write, awaited through the library's own completion callback, which is the only honest
 * way to read after.
 */
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

/** An adapter attached to nothing yet. */
function unattachedAdapter(options: AdapterOptions = {}): XtermTerminalAdapter {
  return trackAdapter(
    new XtermTerminalAdapter({
      terminalId: "session-terminal",
      pool: new TerminalRendererPool(),
      ...options,
    }),
  );
}

type AdapterOptions = Partial<ConstructorParameters<typeof XtermTerminalAdapter>[0]>;
