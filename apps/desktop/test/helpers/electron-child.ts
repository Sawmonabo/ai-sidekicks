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
// about delivering a signal to a tree and stays their home; `ManagedElectronChild`
// in `managed-electron-child.ts` owns WHEN that call is made and how many times,
// and what a child's terminal events mean. This file is the DOOR: the one place
// under `test/` that reaches `spawn`, which is the property
// `electron-spawn-chokepoint.test.ts` enforces by name. It asserts nothing, and
// the one test-framework symbol it imports is a teardown registrar rather than
// an assertion API — a helper that could fail a test would be a second place a
// spawn failure can come from.
//
// The registrar is a default and not a hard-wire, which is what makes the
// mechanism testable at all: a test proving that a settling test kills its
// child cannot itself be the settling test.

import { spawn } from "node:child_process";
import process from "node:process";

import { onTestFinished } from "vitest";

import { ManagedElectronChild, type ProcessTreeTerminator } from "./managed-electron-child.js";

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
 * Spawn Electron with its lifetime bound to the current test.
 *
 * The single spawn chokepoint for `apps/desktop/test/**`, enforced by
 * `test/console/architecture/electron-spawn-chokepoint.test.ts`: a second
 * `spawn` import anywhere under that tree is a red check, because a second
 * spawn site is a second lifetime nobody owns.
 *
 * Must be called from inside a running test — `onTestFinished` is not legal
 * anywhere else, and a spawn in a `beforeAll` would be a child whose lifetime
 * outlives the hook that could kill it. The throw is the right failure, and it
 * is not the whole response: by the time the registrar refuses, the child is
 * already running, already detached, and the only handle on it is about to be
 * discarded with this stack frame. So the misuse path disposes before it
 * rethrows — see below.
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
  try {
    disposeWhenTestFinishes(() => {
      managed.dispose();
    }, options.registerSettleTimeTermination);
  } catch (registrationRefusal: unknown) {
    // THE REGISTRAR ITSELF REFUSED, which is what `onTestFinished` outside a
    // running test does — a spawn from `beforeAll`, the shape this module's own
    // header calls out. Every other failure in this function happens before the
    // spawn; this one happens after it, and without this arm the caller gets a
    // clear diagnostic while a detached child it was never handed keeps running
    // with no kill path anywhere. Registering BEFORE the spawn was the other
    // way out and is worse: the disposer would then have to read a slot that is
    // empty until the spawn returns, and an empty-slot teardown is a branch
    // nothing ever drives. Disposing here is driven on every run by the case in
    // `electron-child-lifetime.test.ts`.
    //
    // A failure inside `dispose` is deliberately not swallowed to preserve the
    // refusal below it: a tree kill that itself threw means the child's fate is
    // unknown, which is the more urgent of the two things to say.
    managed.dispose();
    throw registrationRefusal;
  }
  return managed;
}
