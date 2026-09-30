// When a spawned tree's identity is written down. The root is stamped at the spawn, because a pid
// is reissued once its process is reaped. The descendants are captured once while the child is
// up, since an Electron has no children at start. The intersection at the root's exit may only
// remove rows. `process-tree/identity.ts` owns the readings themselves.
//
// The exit is too late to record: the process is reaped and the number may belong to a new
// holder, whose children would pass the ancestry proof and reach `taskkill /t`. While `exit` is
// undelivered Node still holds the handle, so the pid cannot be reissued (Windows does not reissue
// one with an open handle), and the blocking `spawnSync` listing keeps the event loop from
// delivering `exit`. The live capture runs once because it blocks this thread; `budget.ts`
// reserves exactly that many listings.

import { SpawnedTreeIdentity } from "./process-tree/identity.js";
import { type CapturedTreeMember } from "./process-tree/start-stamps.js";

/**
 * How a tree's root identity is captured, as an injectable act. The capture must happen at the
 * spawn, so a test reads the moment; it also lets a test drive a failed `ps` read.
 */
export type SpawnedTreeIdentityCapture = (processId: number) => SpawnedTreeIdentity;

/** The real capture, which every production spawn takes. */
const captureRealTreeIdentity: SpawnedTreeIdentityCapture = (processId) =>
  new SpawnedTreeIdentity(processId);

/** What one spawned tree's owner has written down about it, and when. */
export class SpawnedTreeRecord {
  readonly #captureRootIdentity: SpawnedTreeIdentityCapture;
  #identity: SpawnedTreeIdentity | undefined;
  #descendantsCaptured = false;

  constructor(captureRootIdentity: SpawnedTreeIdentityCapture = captureRealTreeIdentity) {
    this.#captureRootIdentity = captureRootIdentity;
  }

  /** The members recorded while the root was still alive, each with its stamp. */
  get members(): readonly CapturedTreeMember[] {
    return this.#identity?.capturedDescendants ?? [];
  }

  /**
   * Takes this tree's root identity now. Idempotent, so a later call cannot replace a capture made
   * at the spawn with one made when the pid may be reissued; a no-op without a pid.
   */
  captureRoot(processId: number | undefined): void {
    if (processId === undefined || this.#identity !== undefined) {
      return;
    }
    this.#identity = this.#captureRootIdentity(processId);
  }

  /**
   * Records the tree below the root once, while its owner still holds the pid. `rootIsHeld` is
   * the caller's evidence (its `exit` was not delivered); when false nothing is recorded.
   */
  captureDescendants(rootIsHeld: boolean): void {
    if (this.#descendantsCaptured || !rootIsHeld || this.#identity === undefined) {
      return;
    }
    this.#descendantsCaptured = true;
    this.#identity.captureLiveDescendants();
  }

  /** Drops rows that are no longer this tree, at the root's `exit`, where nothing may be added. */
  narrowAtRootExit(): void {
    this.#identity?.narrowCapturedDescendants();
  }

  /**
   * The identity a signal is re-verified against. A tree whose root was never captured (the
   * settle-time registrar refused) gets the unverified reading.
   */
  identityFor(processId: number): SpawnedTreeIdentity {
    return this.#identity ?? SpawnedTreeIdentity.unverified(processId);
  }
}
