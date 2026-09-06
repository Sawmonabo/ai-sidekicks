// Who owns a spawned Electron process, and when it dies.
//
// Every harness that spawns Electron had the same hole, and it was measured
// rather than reasoned about: four `Electron` processes carrying
// `--user-data-dir=.../sidekicks-gc-test-*` were found reparented to init, at
// 0% CPU, 25 minutes after the run that started them had finished. The shape
// that produced them is the one this module exists to make unreachable.
//
// THE HOLE, IN THREE PARTS
//
//   1. The only kill path lived INSIDE the spawn promise, as a `setTimeout`.
//      A timer is a claim on the worker that armed it. When Vitest's own
//      per-test timeout fires first, the test rejects, the file finishes, the
//      worker is torn down, and every pending timer in it is discarded — with
//      the child still running and nothing left that intended to kill it. So a
//      spawner's own deadline must fire BEFORE the enclosing per-test budget,
//      and the relation has to be stated rather than hoped for; that is
//      `TEST_TIMEOUT_SLACK_MS` below, and it is why every enclosing budget in
//      these harnesses is derived from its phases rather than written down.
//
//   2. A deadline is not the only way a test settles. It also passes, and it
//      also fails on an assertion, and neither runs a timer that was armed for
//      a stall. The child's lifetime therefore has to be bound to the TEST's
//      lifetime, not to any one outcome of it — which is what
//      `onTestFinished` is: a hook that runs on pass, on failure, and on
//      Vitest's own timeout kill alike.
//
//   3. `node_modules/.bin/electron` is a Node shim that spawns the real binary
//      and forwards only catchable signals. `child.kill("SIGKILL")` on that
//      handle is unforwardable by construction: it takes the shim down and
//      leaves the browser process running with the inherited stdout write end
//      open — reparented to init, which is precisely the orphan that was
//      found. The kill has to reach the process GROUP, and the group exists
//      only because the spawn below is detached.
//
// WHAT THIS MODULE IS NOT
//
// It is not a second terminator. `process-tree.ts` owns the platform facts
// about delivering a signal to a tree, and stays their home; this module
// owns WHEN that call is made and how many times. It asserts nothing, and the
// one test-framework symbol it imports is a teardown registrar rather than an
// assertion API — a helper that could fail a test would be a second place a
// spawn failure can come from.
//
// The registrar is a default and not a hard-wire, which is what makes the
// mechanism testable at all: a test proving that a settling test kills its
// child cannot itself be the settling test.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import process from "node:process";
import type { Readable } from "node:stream";

import { onTestFinished } from "vitest";

import { terminateProcessTree } from "./process-tree.js";

/**
 * Grace between the SIGTERM a deadline issues and the SIGKILL that backs it.
 *
 * The shim forwards SIGTERM, so the graceful pass lets Electron shut its
 * children down in order and close the inherited stdout write end this
 * harness's `close` event waits on. SIGKILL is the backstop for a tree that
 * ignores it — Electron does, when it is hung, which is the only case where a
 * deadline fires at all.
 */
export const TERMINATION_GRACE_MS = 2_000;

/**
 * The reserve every spawner keeps between its OWN deadline and Vitest's.
 *
 * The relation this constant states: an enclosing per-test budget is the sum of
 * the phases it contains plus this reserve, so the spawner's deadline always
 * fires first and the kill it schedules always runs. A test that lets Vitest's
 * timeout fire first is the bug — at that point the worker is being torn down,
 * every pending timer with it, and the child outlives the run.
 *
 * It covers the spawn itself, the `close` event after the escalation ladder,
 * and the temporary-profile removal — none of which is a phase with a budget of
 * its own, and all of which sit between the last bounded phase and the moment
 * the promise settles.
 */
export const TEST_TIMEOUT_SLACK_MS = 3_000;

/**
 * The child shape every spawn here produces: no stdin, both output streams piped.
 *
 * Named rather than inferred so callers keep the non-null `stdout` / `stderr`
 * the fixed `stdio` triple guarantees — a caller re-declaring the handle as the
 * general `ChildProcess` would have to null-check streams that cannot be null.
 */
export type ManagedChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/** What a harness hands over to be run when the test ends. */
export type SettleTimeDisposer = () => void | Promise<void>;

/**
 * How a settle-time disposer is registered with the runner.
 *
 * Injected so the mechanism can be driven by a test that is not itself
 * settling. The default is Vitest's `onTestFinished`, which runs on every
 * outcome a test has — pass, failure, and the runner's own timeout kill.
 */
export type SettleTimeRegistrar = (dispose: SettleTimeDisposer) => void;

/**
 * How a whole tree is signalled, and whether the signal landed.
 *
 * Injected for the same reason the registrar is, and it is the same shape of
 * reason: the case that matters is a tree that REFUSED the kill — a `taskkill`
 * that spawned and exited non-zero against a live Electron — and there is no
 * way to make a real platform refuse on demand. The default is the real one, so
 * every production caller signals a real tree.
 */
export type ProcessTreeTerminator = (processId: number, signal: NodeJS.Signals) => boolean;

/**
 * Bind a disposer to the end of the current test, however it ends.
 *
 * The door every Electron harness in this package walks through, including the
 * Playwright launcher, which spawns nothing here but has exactly the same hole:
 * its `close` runs in the body's own settlement, and a vitest timeout does not
 * run the body's settlement.
 *
 * A rejection is swallowed on purpose. By the time this runs the test has
 * already settled and its own outcome is what explains the run; a late cleanup
 * failure surfacing here would replace that outcome with a sentence about
 * teardown. Harnesses that need the cleanup verdict report it on their own
 * path, where it is still the caller's to see.
 */
export function disposeWhenTestFinishes(
  dispose: SettleTimeDisposer,
  register: SettleTimeRegistrar = onTestFinished,
): void {
  register(async () => {
    try {
      await dispose();
    } catch {
      // See above: the test's own outcome is the one that explains the run.
    }
  });
}

export interface ElectronChildSpawnOptions {
  /** The executable to run — the Electron launcher, or `xvfb-run` wrapping it. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Overrides the settle-time registrar. Tests of this module pass their own;
   * every production caller takes the default and must therefore be inside a
   * running test, which is where `onTestFinished` is legal.
   */
  readonly registerSettleTimeTermination?: SettleTimeRegistrar;
  /**
   * Overrides the tree terminator. Tests of this module pass a refusing one;
   * every production caller takes the default and signals a real tree.
   *
   * `undefined` is admitted explicitly, under `exactOptionalPropertyTypes`, so a
   * caller forwarding its own optional through reads the same as one that never
   * mentioned it — which is what a caller means by passing nothing.
   */
  readonly terminateProcessTree?: ProcessTreeTerminator | undefined;
}

/**
 * A spawned Electron process whose lifetime is bounded by the test that
 * spawned it.
 *
 * Three mechanisms, deliberately layered rather than alternatives:
 *
 *   • The process GROUP kill is the load-bearing one. It is the only form that
 *     reaches the browser process behind the launcher shim, and it is available
 *     only because the spawn leads its own group on POSIX.
 *   • The `AbortSignal` handed to `spawn` is the direct-handle backstop, for the
 *     one case the group kill cannot answer: a child that never received a pid,
 *     which is a spawn that failed outright.
 *   • The settle-time registration is what makes either of them run on an
 *     outcome nobody armed a timer for.
 *
 * A second kill is a no-op. Once SIGKILL has been delivered there is nothing
 * left to ask, and re-signalling a reaped pid on POSIX addresses whatever has
 * since been given that number.
 */
export class ManagedElectronChild {
  readonly #child: ManagedChildProcess;
  readonly #abortController: AbortController;
  readonly #terminateTree: ProcessTreeTerminator;
  #escalationTimer: NodeJS.Timeout | null = null;
  #killDelivered = false;

  constructor(
    child: ManagedChildProcess,
    abortController: AbortController,
    terminateTree: ProcessTreeTerminator = terminateProcessTree,
  ) {
    this.#child = child;
    this.#abortController = abortController;
    this.#terminateTree = terminateTree;
  }

  /** The spawned process, for stream wiring and event listeners. */
  get child(): ManagedChildProcess {
    return this.#child;
  }

  /** Whether a SIGKILL has already been DELIVERED to this child's tree. */
  get isKilled(): boolean {
    return this.#killDelivered;
  }

  /**
   * Signal this child's whole tree once, and say whether the signal landed.
   *
   * `true` also covers "there was nothing left to signal", which is the
   * ordinary outcome when the process exited between a deadline expiring and
   * the kill being issued — see `terminateProcessTree` for why that is a
   * success rather than a silent failure.
   *
   * THE MARKER RECORDS THE VERDICT, NEVER THE ATTEMPT. Setting it before the
   * call made a refused tree kill indistinguishable from a delivered one — the
   * `taskkill` that spawns, exits non-zero and leaves Electron running is
   * exactly the case `terminateProcessTree` reports `false` for — and from that
   * point `dispose` aborted the direct handle alone while every later disposer
   * returned early on the marker. The retry that settle-time cleanup exists to
   * perform therefore never ran, on the one path that needed it.
   */
  terminate(signal: NodeJS.Signals): boolean {
    if (this.#killDelivered) {
      return true;
    }
    const processId = this.#child.pid;
    // No pid means the spawn itself failed, so there is no group and no tree —
    // the direct handle is the only thing that can be addressed, and this is
    // the one question `terminateProcessTree` cannot be asked.
    const delivered =
      processId === undefined ? this.#child.kill(signal) : this.#terminateTree(processId, signal);
    if (signal === "SIGKILL" && delivered) {
      this.#killDelivered = true;
    }
    return delivered;
  }

  /**
   * Ask the tree to exit, and kill it if it does not.
   *
   * The ladder a deadline runs. SIGTERM first because the shim forwards it and
   * an ordered Electron shutdown closes the inherited stdout write end this
   * harness's `close` event is waiting on; SIGKILL after the grace because a
   * hung Electron ignores the first one, and a hung Electron is the only reason
   * a deadline fires.
   */
  terminateWithEscalation(graceMs: number = TERMINATION_GRACE_MS): void {
    this.terminate("SIGTERM");
    if (this.#killDelivered || this.#escalationTimer !== null) {
      return;
    }
    this.#escalationTimer = setTimeout(() => {
      this.#escalationTimer = null;
      this.terminate("SIGKILL");
    }, graceMs);
  }

  /**
   * Release everything this child holds, now. Idempotent.
   *
   * Registered as the settle-time disposer, and also called by a harness that
   * has finished with the child before the test has. The group kill runs first
   * and the abort second: the abort reaches the direct handle alone, so running
   * it first would take the shim down and orphan exactly the browser process
   * the group kill exists to reach.
   *
   * Idempotent in the sense that matters and not in the lazier one: a call
   * after a DELIVERED kill signals nothing, and a call after a REFUSED one asks
   * again, because the tree that refused is still there.
   */
  dispose(): void {
    if (this.#escalationTimer !== null) {
      clearTimeout(this.#escalationTimer);
      this.#escalationTimer = null;
    }
    this.terminate("SIGKILL");
    this.#abortController.abort();
  }
}

/**
 * Spawn Electron with its lifetime bound to the current test.
 *
 * The single spawn chokepoint for `apps/desktop/test/**`, enforced by
 * `test/console/architecture/electron-spawn-chokepoint.test.ts`: a second
 * `spawn` import anywhere under that tree is a red check, because a second
 * spawn site is a second lifetime nobody owns.
 *
 * Must be called from inside a running test — `onTestFinished` is not legal
 * anywhere else, and a spawn in a `beforeAll` would be a child whose lifetime
 * outlives the hook that could kill it. The throw is the right failure.
 */
export function spawnManagedElectronChild(
  options: ElectronChildSpawnOptions,
): ManagedElectronChild {
  const abortController = new AbortController();
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX: lead a NEW process group, which is what makes the negative-pid
    // form of the kill reach the shim, the browser, the zygote and every
    // renderer at once. Never on Windows, where the flag means a detached
    // console rather than a process group, and where `taskkill /t` walks the
    // descendant tree instead.
    detached: process.platform !== "win32",
    // The direct-handle backstop. Node kills the child with `killSignal` when
    // the signal aborts; SIGKILL rather than the default SIGTERM because a hung
    // Electron ignores SIGTERM, which is the state this path is reached in.
    signal: abortController.signal,
    killSignal: "SIGKILL",
  });
  const managed = new ManagedElectronChild(child, abortController, options.terminateProcessTree);
  disposeWhenTestFinishes(() => {
    managed.dispose();
  }, options.registerSettleTimeTermination);
  return managed;
}
