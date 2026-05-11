// Shared test fakes for `NodePtyHost` tests.
//
// Both `node-pty-host.kill-translation.test.ts` and
// `node-pty-host.tree-kill.test.ts` need a fake `NodePtyChild` whose
// `onExit` listener can be triggered manually. Keeping a single
// definition here avoids drift (the production `NodePtyChild.onExit`
// event shape is `{ exitCode: number; signal?: number | undefined }`
// per `node-pty-host.ts:85`; under `exactOptionalPropertyTypes: true`
// the `| undefined` is semantically load-bearing and must appear in
// every consumer of the shape).
//
// The default pid is parameterized at the call site so each test file
// keeps its distinctive value (12345 in kill-translation, 67890 in
// tree-kill) for assertion readability.
//
// Refs: T-024-2-2 R3 review POLISH-2 (helper deduplication) +
// POLISH-3 (production-type alignment).

import { vi } from "vitest";

import type { NodePtyChild } from "../node-pty-host.js";

/**
 * Event shape passed to `NodePtyChild.onExit` listeners — re-declared
 * here so the test fakes capture the exact production type, including
 * the `| undefined` on the optional `signal` field. Under
 * `exactOptionalPropertyTypes: true` the `?` and the `| undefined`
 * differ semantically: the former permits omitting the key entirely;
 * the latter permits both omission AND explicit `{ signal: undefined }`.
 * Production `NodePtyChild.onExit` types its event as the latter, so
 * the test helpers must match — otherwise a future change that emits
 * `{ exitCode: 0, signal: undefined }` literally would typecheck in
 * production but trip the test fake's listener signature.
 */
export type NodePtyExitEvent = { exitCode: number; signal?: number | undefined };

/**
 * Build a fake `NodePtyChild` whose handlers (`onData`, `onExit`)
 * capture the listener so the test can manually trigger an exit (used
 * by the idempotency and synthetic-cache cases). `pid` defaults to
 * 12345; tree-kill tests override to 67890 so the per-suite pid is
 * distinctive in assertion failures.
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
