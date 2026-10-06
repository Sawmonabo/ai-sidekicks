// Who owns a spawned child process, Electron or the background service, and when it dies.
//
// A child must not outlive the run that spawned it. Three rules hold that:
//
//   1. A spawner's own deadline fires before the enclosing per-test budget
//      (`TEST_TIMEOUT_SLACK_MS`): when Vitest's timeout fires first, the worker is torn down with
//      its pending timers and the child keeps running.
//   2. The child's lifetime is bound to the test's with `onTestFinished`, which runs on a pass, a
//      failure and Vitest's own timeout kill; a timer armed for a stall runs on none of the first
//      two.
//   3. The kill reaches the process group, because `node_modules/.bin/electron` is a Node shim
//      that forwards only catchable signals, so `child.kill("SIGKILL")` takes the shim down and
//      leaves the browser running with the inherited stdout open.
//
// `process-tree/` delivers a signal to a tree and `ManagedChild` decides when; this file is the
// spawner, the one place under `tests/` that reaches `spawn` (enforced in
// `apps/desktop/eslint.config.mjs`). Playwright's `_electron.launch` starts the other Electron
// these tests run, and its process is owned by `BoundedCleanup` in `electron/harness.ts`, because
// Playwright cannot be handed a child it did not spawn.

import { spawn } from "node:child_process";
import process from "node:process";

import { onTestFinished } from "vitest";

import { OrderedChildTeardown, type ChildRelease } from "./teardown.js";
import { ManagedChild } from "./managed.js";

/**
 * The reserve every spawner keeps between its own deadline and Vitest's.
 *
 * An enclosing per-test budget is the sum of its phases plus this reserve, so the spawner's
 * deadline fires first and the kill it schedules runs. It covers the spawn, the `close` event after
 * the escalation ladder, and the temporary-profile removal, which have no budget of their own.
 */
export const TEST_TIMEOUT_SLACK_MS = 3_000;

/** What the spawner needs to start one child process. */
export interface ChildSpawnOptions {
  /** The executable to run: the Electron launcher, `xvfb-run` wrapping it, or Node. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /**
   * What to release once this child's last termination attempt has settled.
   *
   * A spawn argument, not a second registration, so the release cannot run before an attempt
   * another disposer still makes; see `OrderedChildTeardown`.
   */
  readonly releaseAfterTermination?: ChildRelease | undefined;
}

/**
 * Spawns a child process with its lifetime bound to the current test.
 *
 * The single spawn chokepoint for `apps/desktop/tests/**`: a second `spawn` reach there (static,
 * dynamic `import()` or `require`) is a lint error, since a second spawn site is a second lifetime
 * nobody owns. Must be called inside a running test, where `onTestFinished` is legal. If
 * `onTestFinished` refuses, the child is already running and detached, so the call disposes it
 * before rethrowing.
 */
export function spawnManagedChild(options: ChildSpawnOptions): ManagedChild {
  const abortController = new AbortController();
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX: lead a new process group so the negative-pid kill reaches the shim, browser, zygote
    // and renderers at once. Never on Windows, where the flag means a detached console and
    // `taskkill /t` walks the descendant tree.
    detached: process.platform !== "win32",
    // Direct-handle backstop: Node kills with `killSignal` on abort, and SIGKILL because a hung
    // Electron ignores SIGTERM.
    signal: abortController.signal,
    killSignal: "SIGKILL",
  });
  const managed = new ManagedChild(child, abortController);
  // Register ownership before the host query: capturing the tree identity spawns `ps` or
  // PowerShell and blocks this thread, and a stall or throw ahead of the registration would leave
  // a running process with no kill path.
  const teardown = new OrderedChildTeardown(managed, options.releaseAfterTermination);
  try {
    // Exactly one settle-time registration per child, so the teardown order is a property of the
    // code; a caller's resource travels in as `releaseAfterTermination`.
    onTestFinished(async () => {
      await teardown.settle();
    });
  } catch (registrationRefusal: unknown) {
    // `onTestFinished` refused (it was called outside a running test, such as a spawn from
    // `beforeAll`). The child is already running and the caller never receives its handle, so this
    // is the only disposal it will get: it asks as many times as the settle-time path, through
    // `disposeUntilKillDelivered`. A failure inside the disposal is not swallowed, since a tree
    // kill that threw leaves the child's fate unknown, which is more urgent than the refusal.
    managed.disposeUntilKillDelivered();
    throw registrationRefusal;
  }
  // Outside the try: a capture that fails is not a registration refusal, and the disposal is
  // already registered, so the kill still runs at settle time through the unverified reading.
  managed.captureTreeIdentity();
  return managed;
}
