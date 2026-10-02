// The object that owns one spawned child's fate. The spawner, `electron-child.ts`, constructs it.
//
// The child is gone at `close`, not `exit`: `node_modules/.bin/electron` is a shim that hands the
// browser its stdout, so the shim can exit while the browser runs and holds the pipe. Releasing a
// resource at `exit` races that browser, and by `close` the pid is reaped and reissuable, so a
// kill sent then could reach a stranger. One field, set by this child's own `close` handler,
// answers both: `dispose` signals nothing once it is set, and `electron-child-teardown.ts` waits
// for it before releasing what the child held.

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { terminateProcessTree } from "./process-tree/termination.js";
import { SpawnedTreeRecord } from "./spawned-tree-record.js";

/**
 * Grace between the SIGTERM a deadline issues and the SIGKILL that backs it. The shim forwards
 * SIGTERM, so the graceful pass lets Electron shut down in order and close the inherited stdout
 * write end that `close` waits on. SIGKILL backs a hung tree, the only case a deadline fires.
 */
export const TERMINATION_GRACE_MS = 2_000;

/**
 * How many times a refused disposal asks again before it gives the child up. The first call is
 * the ordinary one, the second exists for a tree that refused one kill and takes the next, and
 * past that the tree is unkillable by this process. It lives beside `disposeUntilKillDelivered`,
 * which spends it; `bounded-cleanup.ts` and `electron-child-teardown.ts` import it so no second
 * copy of the bound exists.
 */
export const DISPOSAL_ATTEMPTS = 3;

/**
 * The child shape every spawn here produces (no stdin, both outputs piped), named so callers keep
 * the non-null `stdout` and `stderr` instead of null-checking a general `ChildProcess`.
 */
export type ManagedChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * A spawned Electron process whose lifetime is bounded by the test that spawned it.
 *
 * Three layered mechanisms. The process-group kill is load-bearing: it alone reaches the browser
 * behind the launcher shim, and exists because the spawn leads its own group on POSIX. The
 * `AbortSignal` given to `spawn` is the direct-handle backstop for a child that never received a
 * pid. The settle-time registration makes either run on an outcome nobody armed a timer for. A
 * second kill is a no-op: after SIGKILL is delivered, re-signaling a reaped pid on POSIX would
 * address whatever now holds that number.
 *
 * The tree's identity is captured while the pid is unambiguously this tree's, and the platform
 * arm re-verifies it before signaling (`SpawnedTreeIdentity`). The capture is a call the owner
 * makes, not part of construction, because it is a blocking `spawnSync` that would otherwise sit
 * between the spawn and the settle-time registration. The descendant set is recorded through
 * `captureTreeDescendants` while the child is up, since an Electron has no children at spawn and
 * by disposal the root is gone; the root's `exit` may only narrow it (`spawned-tree-record.ts`).
 */
export class ManagedElectronChild {
  readonly #child: ManagedChildProcess;
  readonly #abortController: AbortController;
  readonly #treeRecord: SpawnedTreeRecord = new SpawnedTreeRecord();
  #escalationTimer: NodeJS.Timeout | null = null;
  #killDelivered = false;
  #closeDelivered = false;

  constructor(child: ManagedChildProcess, abortController: AbortController) {
    this.#child = child;
    this.#abortController = abortController;
    // After the root exits its number is no longer this tree's, so this may only remove members
    // from what was recorded while the child was up: a listing from a reaped pid can carry rows a
    // new holder fathered.
    child.once("exit", () => {
      this.#treeRecord.narrowAtRootExit();
    });
    // Registered here so it is attached before anything can be delivered and runs before every
    // listener a caller adds, so a caller awaiting its own `close` sees `hasClosed` already true.
    child.once("close", () => {
      this.#closeDelivered = true;
    });
  }

  /**
   * Take this tree's root identity, now. Idempotent, and a no-op without a pid.
   *
   * Separate from construction so ownership comes first: it is a blocking host query, and a stall
   * between the spawn and the registration that kills it blocks the thread vitest's timeout runs
   * on. Idempotent because a later call would replace a capture made at the spawn with one made
   * when the pid may no longer be this tree's.
   */
  captureTreeIdentity(): void {
    this.#treeRecord.captureRoot(this.#child.pid);
  }

  /**
   * Record the tree below this root, once, while this child is still running.
   *
   * The owner calls it because it learns the child is up by hearing from it, the one moment the
   * descendant set both exists and is safely readable (`spawned-tree-record.ts`). It costs one
   * blocking host listing per child, so every enclosing per-test budget reserves it. A child that
   * already reported an exit records nothing rather than whatever now holds its number.
   */
  captureTreeDescendants(): void {
    this.#treeRecord.captureDescendants(
      this.#child.exitCode === null && this.#child.signalCode === null,
    );
  }

  /** The spawned process, for stream wiring and event listeners. */
  get child(): ManagedChildProcess {
    return this.#child;
  }

  /**
   * Whether this child's `close` has been delivered: the process has ended and every inherited
   * stdio stream is released, which no exit code can say. It never goes back to false.
   */
  get hasClosed(): boolean {
    return this.#closeDelivered;
  }

  /**
   * Signal this child's whole tree once, and say whether the signal landed. `true` also covers
   * "nothing left to signal" (see `terminateProcessTree`).
   *
   * The marker records the verdict, not the attempt. Set before the call, a refused tree kill (a
   * `taskkill` that exits non-zero and leaves Electron running) would look delivered, `dispose`
   * would abort the direct handle alone, and later disposers would return early, so the retry
   * would never run.
   */
  terminate(signal: NodeJS.Signals): boolean {
    if (this.#killDelivered) {
      return true;
    }
    const processId = this.#child.pid;
    // No pid means the spawn failed: there is no group or tree, so the direct handle is the only
    // thing addressable.
    // The root identity is read at the call because its capture lands after construction.
    const delivered =
      processId === undefined
        ? this.#child.kill(signal)
        : terminateProcessTree(processId, signal, this.#treeRecord.identityFor(processId));
    if (signal === "SIGKILL" && delivered) {
      this.#killDelivered = true;
    }
    return delivered;
  }

  /**
   * Ask the tree to exit, and kill it if it does not. SIGTERM goes first because the shim forwards
   * it and an ordered shutdown closes the inherited stdout write end `close` waits on; SIGKILL
   * follows after the grace because a hung Electron ignores the first.
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
   * It is the settle-time disposer, and a harness that finishes with the child early also calls it.
   *
   * Once `close` has fired it signals nothing. The smoke-probe and gc-probe harnesses call it from
   * the child's own `close` handler, when the pid is reaped and reissuable, so a kill would deliver
   * SIGKILL to `-pid` and `pid` and hit a group or process this test never started. The escalation
   * timer is still released.
   *
   * The abort is not a second attempt at the tree; it reaches the direct handle alone. After a
   * refused tree kill it would destroy the root the retry walks the descendants from, leaving
   * nothing that can name them. After a delivered one it re-signals a gone pid, and Node emits
   * `AbortError` on the handle, an unhandled exception for a caller with no `error` listener. So
   * the group kill is the whole mechanism whenever there is a group, and the abort runs only for a
   * spawn that never received a pid.
   *
   * A call after a delivered kill signals nothing; after a refused one it asks again, because the
   * tree that refused is still there.
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

  /**
   * Dispose, and ask again while the platform says the kill was refused.
   *
   * The one home for the kill retry: `electron-child-teardown.ts` retries around a wait for
   * `close`, while the spawner's misuse recovery is synchronous and cannot await, and a second
   * loop would be a second bound. What separates the asks is the ask's own cost: where a refusal
   * is transient it is `taskkill` spawning and failing again, a real second attempt; where it is
   * `EPERM`, nothing changes and the loop costs three syscalls. It stops when a kill was
   * delivered, `close` arrived or the child has no pid, so an ordinary disposal is one call.
   */
  disposeUntilKillDelivered(): void {
    for (let attempt = 0; attempt < DISPOSAL_ATTEMPTS; attempt += 1) {
      this.dispose();
      if (this.#killDelivered || this.#closeDelivered || this.#child.pid === undefined) {
        return;
      }
    }
  }
}
