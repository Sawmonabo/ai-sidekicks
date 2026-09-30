// Shared fake `NodePtyChild` for the `NodePtyHost` tests, so its `onExit` event shape stays in
// one place.

import { vi } from "vitest";

import type { NodePtyChild } from "../node-pty-host.js";

// Matches `NodePtyChild.onExit`'s event type. Under `exactOptionalPropertyTypes` the
// `| undefined` on `signal` also permits an explicit `{ signal: undefined }`.
type NodePtyExitEvent = { exitCode: number; signal?: number | undefined };

/**
 * Build a fake `NodePtyChild` that captures its `onExit` listener so a test can trigger an exit
 * with `triggerExit`, which throws if no listener is attached yet. `pid` defaults to 12345;
 * suites pass their own so the pid is distinctive in assertion failures.
 */
export function makeFakeChild(pid: number = 12345): {
  child: NodePtyChild;
  triggerExit: (exitCode: number, signal?: number) => void;
} {
  let exitListener: ((event: NodePtyExitEvent) => void) | null = null;
  const child: NodePtyChild = {
    pid,
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener) => {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    kill: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
  };
  return {
    child,
    triggerExit: (exitCode: number, signal?: number) => {
      if (exitListener === null) {
        throw new Error(
          "makeFakeChild.triggerExit: onExit listener not yet attached " +
            "(was the child spawned via NodePtyHost.spawn?)",
        );
      }
      const event: NodePtyExitEvent = signal === undefined ? { exitCode } : { exitCode, signal };
      exitListener(event);
    },
  };
}
