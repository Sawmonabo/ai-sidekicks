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
// It is not a second terminator. `process-tree/` owns the platform facts
// about delivering a signal to a tree and stays their home; `ManagedElectronChild`
// in `managed-electron-child.ts` owns WHEN that call is made and how many times,
// and what a child's terminal events mean. This file is the DOOR: the one place
// under `test/` that reaches `spawn`, which is the property
// `apps/desktop/eslint.config.mjs` enforces. It asserts nothing, and
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

import { OrderedChildTeardown, type ChildRelease } from "./electron-child-teardown.js";
import {
  ManagedElectronChild,
  TERMINATION_GRACE_MS,
  type ProcessTreeTerminator,
} from "./managed-electron-child.js";
import { type SpawnedTreeIdentityCapture } from "./spawned-tree-record.js";

export type { ChildRelease } from "./electron-child-teardown.js";

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
 * What a settle-time disposal's own failure does to the run.
 *
 * Two dispositions and not a flag: `"swallowed"` keeps the test's own outcome the
 * one a reader sees, and `"fails-the-test"` lets the disposal's failure become
 * the outcome. Which one a disposer takes is stated where it is registered.
 */
export type DisposalFailureDisposition = "swallowed" | "fails-the-test";

/**
 * Bind a disposer to the end of the current test, however it ends.
 *
 * The door every Electron harness in this package walks through, including the
 * Playwright launcher, which spawns nothing here but has exactly the same hole:
 * its `close` runs in the body's own settlement, and a vitest timeout does not
 * run the body's settlement.
 *
 * A rejection is swallowed by DEFAULT, and the default is the judgment rather
 * than the mechanism. By the time this runs the test has already settled and its
 * own outcome is what explains the run; a late cleanup failure surfacing here
 * would replace that outcome with a sentence about teardown. Harnesses that need
 * the cleanup verdict report it on their own path, where it is still the
 * caller's to see.
 *
 * `"fails-the-test"` is for the disposal whose failure IS the run's outcome, and
 * there is exactly one class of those: a disposal that could not stop a process.
 * The Playwright launcher's settle-time close reaches it — that close is the ONLY
 * path on a vitest timeout, its own bounded retries are already spent by the time
 * it raises, and an Electron tree nothing could kill outlives the worker and
 * every launch after it. Swallowing there does not keep a teardown sentence off a
 * reader's screen; it reports a run as clean that left a browser running. The
 * disposition is named at the call site rather than inferred from the error,
 * because which failures a caller can afford to lose is the caller's question.
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
  /**
   * Overrides how the spawned tree's root identity is captured.
   *
   * Injected so the capture's own FAILURE is drivable: it reads this host with a
   * blocking `spawnSync`, and the property that matters here is that a child
   * spawned before a read that throws is still owned by the test — which cannot
   * be shown without a reader that throws.
   */
  readonly captureRootIdentity?: SpawnedTreeIdentityCapture | undefined;
  /**
   * What to release once this child's LAST termination attempt has settled.
   *
   * A spawn argument rather than a second settle-time registration a caller
   * makes afterwards, and that is the whole ordering property: the door arms
   * exactly one disposer, so the release cannot be sequenced before an attempt
   * that some other disposer is still going to make. `OrderedChildTeardown`
   * below has the leak that shape closes.
   */
  readonly releaseAfterTermination?: ChildRelease | undefined;
  /**
   * How long each termination attempt is given to produce a `close`.
   *
   * Injected for the reason the registrar is: a case that has to EXHAUST the
   * attempt bound against a permanently refusing platform cannot afford three
   * production graces, and no platform can be asked to refuse a kill on demand.
   */
  readonly terminationExitWaitMs?: number | undefined;
}

/**
 * Spawn Electron with its lifetime bound to the current test.
 *
 * The single spawn chokepoint for `apps/desktop/test/**`, enforced by
 * `no-restricted-imports` and `no-restricted-syntax` in
 * `apps/desktop/eslint.config.mjs`: a second `spawn` reach anywhere under that
 * tree — static, dynamic `import()`, or `require` — is a red check, because a
 * second spawn site is a second lifetime nobody owns.
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
  const managed = new ManagedElectronChild(
    child,
    abortController,
    options.terminateProcessTree,
    options.captureRootIdentity,
  );
  // OWNERSHIP FIRST, THEN THE HOST QUERY, and the order is the whole of it.
  // Constructing the handle reads nothing; capturing the tree's identity spawns
  // `ps` or PowerShell and BLOCKS this thread until it answers. Performed before
  // the registration below, that query sat in a window where the process was
  // already running and nothing anywhere had been registered to kill it — and a
  // query that stalls blocks the very thread vitest's own timeout runs on, so
  // the worker is torn down with a detached Electron tree and no kill path. A
  // query that THROWS leaves the same state by the shorter route. Registering
  // first costs nothing and closes both: the identity is captured an instant
  // later, which is still before anything this spawn started can have exited.
  const teardown = new OrderedChildTeardown(
    managed,
    options.terminationExitWaitMs ?? TERMINATION_GRACE_MS,
    options.releaseAfterTermination,
  );
  try {
    // EXACTLY ONE settle-time registration per spawned child, which is what
    // makes the teardown's ordering a property of the code rather than of the
    // order the runner happens to pick. A caller's resource travels INTO this
    // registration as `releaseAfterTermination`, so there is never a second
    // disposer whose kill could land after the release.
    disposeWhenTestFinishes(async () => {
      await teardown.settle();
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
    // AND IT ASKS AS MANY TIMES AS THE SETTLE-TIME PATH DOES. A single ask was
    // the whole disposal this arm ever made, and it is the ONLY one that will
    // ever be made: no disposer was registered — the registrar is what just
    // refused — and the caller never receives the handle, so a platform that
    // refused that one kill left a detached tree with nothing anywhere that
    // could name it again. The bound is `ManagedElectronChild`'s own, spent
    // through its `disposeUntilKillDelivered`, so this arm cannot drift from the
    // retry the ordinary settlement performs.
    //
    // A failure inside the disposal is deliberately not swallowed, to preserve
    // the refusal below it: a tree kill that itself threw means the child's fate
    // is unknown, which is the more urgent of the two things to say.
    managed.disposeUntilKillDelivered();
    throw registrationRefusal;
  }
  // Deliberately OUTSIDE the try: a capture that fails is not a registration
  // refusal, and the child it describes is already owned by the test above. So
  // the throw propagates to the caller with the disposal already registered,
  // which is the state that makes the failure safe rather than the one that
  // makes it silent — the tree kill still runs when the test settles, through
  // the unverified reading `ManagedElectronChild` falls back to.
  managed.captureTreeIdentity();
  return managed;
}
