// The object that owns one spawned child's fate, and how it learns that fate.
//
// Split out of `electron-child.ts` rather than left inside it because that
// module is the SPAWN door — the one file under `test/` allowed to reach
// `spawn`, which `electron-spawn-chokepoint.test.ts` enforces by name — and the
// lifetime object beside it had become a second job in the same file.
//
// `EXIT` IS NOT `CLOSE`, AND THE DIFFERENCE IS THE WHOLE POINT
//
// `exit` says the process has ended. `close` says that AND that every stdio
// stream inherited from it has been released — a different moment whenever a
// descendant inherited one, and here a descendant always does:
// `node_modules/.bin/electron` is a shim that spawns the real browser process
// with the shim's own stdout, so the shim can be gone, `exitCode` set, while
// the browser it started still holds that pipe and still runs.
//
// A reader that takes a non-null `exitCode` for "the child is gone" is
// therefore wrong twice over, in opposite directions. RELEASING a resource on
// it races descendants that still hold the resource — on Windows a live handle
// inside a Chromium profile directory makes the removal fail outright and the
// directory survives the run. SIGNALLING on it is worse: by `close` the pid has
// been reaped and the number is the operating system's to hand out again, so a
// kill addressed to it, or to the group it led, reaches whatever holds it now.
//
// One field answers both questions. It is set from this child's own `close`
// handler, registered in the constructor so it runs ahead of every listener a
// caller adds, and it is read in exactly two places: `dispose` below, which
// signals nothing once it is true, and `electron-child-cleanup.ts`, which waits
// for it to become true before releasing what the child was holding.

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { terminateProcessTree } from "./process-tree.js";

/**
 * Grace between the SIGTERM a deadline issues and the SIGKILL that backs it.
 *
 * The shim forwards SIGTERM, so the graceful pass lets Electron shut its
 * children down in order and close the inherited stdout write end this
 * package's `close` events wait on. SIGKILL is the backstop for a tree that
 * ignores it — Electron does, when it is hung, which is the only case where a
 * deadline fires at all.
 */
export const TERMINATION_GRACE_MS = 2_000;

/**
 * The child shape every spawn here produces: no stdin, both output streams piped.
 *
 * Named rather than inferred so callers keep the non-null `stdout` / `stderr`
 * the fixed `stdio` triple guarantees — a caller re-declaring the handle as the
 * general `ChildProcess` would have to null-check streams that cannot be null.
 */
export type ManagedChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * How a whole tree is signalled, and whether the signal landed.
 *
 * Injected because the case that matters is a tree that REFUSED the kill — a
 * `taskkill` that spawned and exited non-zero against a live Electron — and
 * there is no way to make a real platform refuse on demand. The default is the
 * real one, so every production caller signals a real tree.
 */
export type ProcessTreeTerminator = (processId: number, signal: NodeJS.Signals) => boolean;

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
  #closeDelivered = false;

  constructor(
    child: ManagedChildProcess,
    abortController: AbortController,
    terminateTree: ProcessTreeTerminator = terminateProcessTree,
  ) {
    this.#child = child;
    this.#abortController = abortController;
    this.#terminateTree = terminateTree;
    // Registered HERE and not by a caller, for two reasons that are one reason.
    // It has to be attached before anything can be delivered, and the moment
    // after the spawn is the only point where that is guaranteed; and it has to
    // run before every listener a caller adds, which the arrival order of `once`
    // registrations gives for free — so a caller awaiting its own `close`
    // observes a `hasClosed` that is already true rather than one about to be.
    child.once("close", () => {
      this.#closeDelivered = true;
    });
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
   * Whether this child's `close` has been delivered.
   *
   * The one reading that means "the process has ended AND every stdio stream
   * inherited from it has been released", which is what both callers actually
   * need and what no exit code can say — the module header has the mechanism.
   * It never goes back to false: `close` is delivered at most once.
   */
  get hasClosed(): boolean {
    return this.#closeDelivered;
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
   * Whether the direct-handle backstop has been fired.
   *
   * The reading that makes the rule in `dispose` checkable rather than merely
   * asserted in prose. The abort kills the ROOT and nothing beneath it, and the
   * root is what a tree kill is addressed THROUGH — on Windows `taskkill /pid
   * <root> /t` rediscovers the descendants by walking from it, and this process
   * holds no other handle on them. So a child that has a pid must never see
   * this become `true`, refused kill or delivered one, and a test can ask.
   */
  get directHandleReleased(): boolean {
    return this.#abortController.signal.aborted;
  }

  /**
   * Release everything this child holds, now. Idempotent.
   *
   * Registered as the settle-time disposer, and also called by a harness that
   * has finished with the child before the test has.
   *
   * ONCE `close` HAS FIRED THIS SIGNALS NOTHING, and that is not caution — it
   * is the only correct answer. Two of this package's harnesses call `dispose`
   * from the child's OWN `close` handler (`electron-probe.ts`'s single settle
   * path, `lifecycle.gc.test.ts`'s cleanup), and by then the child has been
   * reaped and its pid is the operating system's to reissue. Asking for a kill
   * there does not re-signal a dead process: on POSIX it delivers SIGKILL to
   * `-pid` and `pid`, either of which may by then name a group or a process
   * this test never started. The escalation timer is still released, the
   * disposal still completes, and the caller's own resource-removal path still
   * runs — the wait for that is `electron-child-cleanup.ts`'s, and it is
   * already satisfied here.
   *
   * THE ABORT IS NOT A SECOND ATTEMPT AT THE TREE, and treating it as one was
   * the other hole. It reaches the direct handle ALONE, so it can do exactly two
   * things here and neither is a backstop:
   *
   *   • After a REFUSED tree kill it destroys the only thing the retry has to
   *     work with. A tree is addressed THROUGH its root — `taskkill /pid <root>
   *     /t` walks the descendants from it, and this process holds no other
   *     handle on them — so answering a refusal by killing the root leaves the
   *     descendants running with nothing anywhere that can name them. The
   *     `#killDelivered` marker staying false is what SCHEDULES the retry;
   *     keeping the root alive is what gives the retry a tree to walk, and a
   *     marker without the root is a retry that runs, finds nothing, and
   *     reports success.
   *   • After a DELIVERED one it re-signals a pid that is already gone, and
   *     Node answers an abort by emitting `AbortError` on the handle — an
   *     UNHANDLED exception for any caller that attached no `error` listener,
   *     which is a failure invented by the cleanup rather than found by it.
   *
   * So the group kill is the whole mechanism whenever there is a group, and the
   * abort runs only in the case the group kill cannot be asked about at all: a
   * spawn that never received a pid, which leads no tree and has nothing but
   * the direct handle. That is the same one case the class header names.
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
    if (this.#closeDelivered) {
      return;
    }
    if (this.#child.pid === undefined) {
      this.#abortController.abort();
      return;
    }
    this.terminate("SIGKILL");
  }
}
