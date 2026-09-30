// Who owns a spawned Electron process, and when it dies.
//
// Measured, not reasoned about: four `Electron` processes with
// `--user-data-dir=.../sidekicks-gc-test-*` were found reparented to init at 0% CPU 25 minutes
// after the run that started them had finished. Three causes:
//
//   1. The only kill path was a `setTimeout` inside the spawn promise. When Vitest's per-test
//      timeout fires first, the worker is torn down and its pending timers are discarded with the
//      child still running. So a spawner's deadline must fire before the enclosing per-test
//      budget (`TEST_TIMEOUT_SLACK_MS`), and every enclosing budget is derived from its phases.
//   2. A test also passes or fails on an assertion, and neither runs a timer armed for a stall.
//      The child's lifetime is bound to the test's with `onTestFinished`, which runs on pass,
//      failure and Vitest's own timeout kill.
//   3. `node_modules/.bin/electron` is a Node shim that forwards only catchable signals, so
//      `child.kill("SIGKILL")` takes the shim down and leaves the browser running with the
//      inherited stdout open. The kill must reach the process group, which exists only because
//      the spawn is detached.
//
// This is not a second terminator: `process-tree/` owns delivering a signal to a tree, and
// `ManagedElectronChild` owns when that happens and what a child's terminal events mean. This file
// is the spawner, the one place under `tests/` that reaches `spawn` (enforced in
// `apps/desktop/eslint.config.mjs`). It asserts nothing, since a helper that could fail a test
// would be a second source of spawn failures. The registrar is injectable so a test proving that a
// settling test kills its child need not itself be the settling test.

import { spawn } from "node:child_process";
import process from "node:process";

import { onTestFinished } from "vitest";

import { OrderedChildTeardown, type ChildRelease } from "./electron-child-teardown.js";
import {
  ManagedElectronChild,
  TERMINATION_GRACE_MS,
  type ProcessTreeTerminator,
} from "./managed-electron-child.js";
import { type SpawnedTreeIdentityCapture } from "./spawned-tree-record.js";

export type { ChildRelease } from "./electron-child-teardown.js";

/**
 * The reserve every spawner keeps between its own deadline and Vitest's.
 *
 * An enclosing per-test budget is the sum of its phases plus this reserve, so the spawner's
 * deadline fires first and the kill it schedules runs; if Vitest's timeout fires first the worker
 * is torn down with every pending timer and the child outlives the run. It covers the spawn, the
 * `close` event after the escalation ladder, and the temporary-profile removal, which have no
 * budget of their own.
 */
export const TEST_TIMEOUT_SLACK_MS = 3_000;

/** What a harness hands over to be run when the test ends. */
export type SettleTimeDisposer = () => void | Promise<void>;

/**
 * How a settle-time disposer is registered with the runner.
 *
 * Injected so a test that is not itself settling can drive the mechanism. The default is Vitest's
 * `onTestFinished`, which runs on pass, failure and the runner's own timeout kill.
 */
export type SettleTimeRegistrar = (dispose: SettleTimeDisposer) => void;

/**
 * What a settle-time disposal's own failure does to the run.
 *
 * `"swallowed"` keeps the test's own outcome the one a reader sees; `"fails-the-test"` lets the
 * disposal's failure become the outcome. The registration site states which.
 */
export type DisposalFailureDisposition = "swallowed" | "fails-the-test";

/**
 * Binds a disposer to the end of the current test, however it ends.
 *
 * The one settle-time registration every Electron harness here uses, including the Playwright
 * launcher, whose `close` runs in the body's settlement and so is skipped by a vitest timeout.
 * A rejection is swallowed by default: the test has already settled and its own outcome explains
 * the run, so a late teardown failure must not replace it. `"fails-the-test"` is for a disposal
 * that could not stop a process, where swallowing would report clean a run that left a browser
 * running. The disposition is named at the call site, not inferred from the error.
 */
export function disposeWhenTestFinishes(
  dispose: SettleTimeDisposer,
  register: SettleTimeRegistrar = onTestFinished,
  disposalFailure: DisposalFailureDisposition = "swallowed",
): void {
  register(async () => {
    if (disposalFailure === "fails-the-test") {
      await dispose();
      return;
    }
    try {
      await dispose();
    } catch {
      // Swallowed by default: the test's own outcome is the one that explains the run.
    }
  });
}

/** What the spawner needs to start one Electron child, and the seams tests inject. */
export interface ElectronChildSpawnOptions {
  /** The executable to run — the Electron launcher, or `xvfb-run` wrapping it. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Overrides the settle-time registrar; production callers take the default and must be inside
   * a running test, where `onTestFinished` is legal.
   */
  readonly registerSettleTimeTermination?: SettleTimeRegistrar;
  /**
   * Overrides the tree terminator; tests pass a refusing one.
   *
   * `undefined` is admitted explicitly under `exactOptionalPropertyTypes` so a caller forwarding
   * its own optional reads the same as one passing nothing.
   */
  readonly terminateProcessTree?: ProcessTreeTerminator | undefined;
  /**
   * Overrides how the spawned tree's root identity is captured.
   *
   * Injected so a capture that throws (it runs a blocking `spawnSync`) can be driven: the child
   * spawned before it must still be owned by the test.
   */
  readonly captureRootIdentity?: SpawnedTreeIdentityCapture | undefined;
  /**
   * What to release once this child's last termination attempt has settled.
   *
   * A spawn argument, not a second registration, so the release cannot run before an attempt
   * another disposer still makes; see `OrderedChildTeardown`.
   */
  readonly releaseAfterTermination?: ChildRelease | undefined;
  /**
   * How long each termination attempt is given to produce a `close`.
   *
   * Injected so a case can exhaust the attempt bound against a refusing platform without paying
   * three production graces.
   */
  readonly terminationExitWaitMs?: number | undefined;
}

/**
 * Spawns Electron with its lifetime bound to the current test.
 *
 * The single spawn chokepoint for `apps/desktop/tests/**`: a second `spawn` reach there (static,
 * dynamic `import()` or `require`) is a lint error, since a second spawn site is a second lifetime
 * nobody owns. Must be called inside a running test, where `onTestFinished` is legal. If the
 * registrar refuses, the child is already running and detached, so the call disposes it before
 * rethrowing.
 */
export function spawnManagedElectronChild(
  options: ElectronChildSpawnOptions,
): ManagedElectronChild {
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
  const managed = new ManagedElectronChild(
    child,
    abortController,
    options.terminateProcessTree,
    options.captureRootIdentity,
  );
  // Register ownership before the host query: capturing the tree identity spawns `ps` or
  // PowerShell and blocks this thread, and a stall or throw ahead of the registration would leave
  // a running process with no kill path.
  const teardown = new OrderedChildTeardown(
    managed,
    options.terminationExitWaitMs ?? TERMINATION_GRACE_MS,
    options.releaseAfterTermination,
  );
  try {
    // Exactly one settle-time registration per child, so the teardown order is a property of the
    // code; a caller's resource travels in as `releaseAfterTermination`.
    disposeWhenTestFinishes(async () => {
      await teardown.settle();
    }, options.registerSettleTimeTermination);
  } catch (registrationRefusal: unknown) {
    // The registrar refused (`onTestFinished` outside a running test, such as a spawn from
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
