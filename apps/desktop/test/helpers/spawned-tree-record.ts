// WHEN a spawned tree's identity is recorded, as the owner's own bookkeeping.
//
// Split out of `managed-electron-child.ts` beside it rather than left inside it
// because that module owns a child's FATE — what is signalled, how many times,
// and what its terminal events mean — while this owns a question about TIME: at
// which moments this process may write down what the tree is made of, and which
// moments are too late. `process-tree/identity.ts` owns the readings themselves
// and the rules they obey; nothing here reads a host directly.
//
// THE MOMENTS, AND WHY THEY ARE THREE AND NOT ONE
//
//   • THE ROOT, at the spawn. A pid is a name the operating system hands out
//     again, so the number a tree is addressed through is only that tree's while
//     the process holding it is running. The stamp taken here is what every later
//     signal re-verifies against.
//   • THE DESCENDANTS, while the child is up. An Electron has no children in the
//     instant it starts, so this cannot ride the spawn — and it must not ride the
//     root's exit, which is where the whole class of defect lives.
//   • THE INTERSECTION, at the root's exit. It may only REMOVE.
//
// WHY THE EXIT IS TOO LATE TO RECORD ANYTHING
//
// By the `exit` event the process has been reaped: Node has closed the handle it
// held on it, and from that instant the operating system may hand the number to
// something else. A listing taken from there can carry rows a NEW holder of the
// number fathered inside the window the listing itself takes, and nothing in the
// row separates them from this tree's — same parent pid, and a start stamp after
// the original root's, so the ancestry proof admits them. Handed to `taskkill /t`
// that is an unrelated tree this package never spawned.
//
// WHAT MAKES THE LIVE MOMENT SOUND IS THE HANDLE AND NOT OPTIMISM. Node holds the
// spawned process's own handle open until it reports `exit`, Windows will not
// reissue a pid while a handle to that process is open, and the listing is a
// blocking `spawnSync` — so the event loop cannot deliver that `exit` while the
// query runs. An owner that has not yet seen `exit` therefore holds the number
// for the whole duration of the reading, which is exactly the property the exit
// listener has already lost.
//
// AND THE LIVE CAPTURE IS TAKEN ONCE. It is a host query that blocks this thread,
// and an owner that took one per output chunk would spend an enclosing test's
// whole reserved ceiling many times over. Once is what `budget.ts` reserves and
// what `DESCENDANT_LISTINGS_PER_CHILD` counts.

import { SpawnedTreeIdentity } from "./process-tree/identity.js";
import { type CapturedTreeMember } from "./process-tree/start-stamps.js";

/**
 * How a tree's root identity is captured, as one injectable act.
 *
 * A seam for one reason and it is the whole property: the capture has to happen
 * at the SPAWN and not at the kill, and "it happened before anything could have
 * exited" is a claim about WHEN rather than about what came back. Handed a
 * recording factory, a test can read the moment; handed the real one, every
 * production caller captures.
 * It is also the seam that makes the capture's own FAILURE drivable: it reads
 * the host with a `spawnSync`, and a test proving that a child spawned before a
 * failed read is still killed cannot arrange a broken `ps` any other way.
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
   * Take this tree's root identity, now. Idempotent, and a no-op without a pid.
   *
   * Idempotent because "the identity was taken at the spawn" is the property: a
   * second call minutes later would replace a capture made when that was true
   * with one made when it may not be.
   */
  captureRoot(processId: number | undefined): void {
    if (processId === undefined || this.#identity !== undefined) {
      return;
    }
    this.#identity = this.#captureRootIdentity(processId);
  }

  /**
   * Record the tree below this root, once, while its owner still holds the pid.
   *
   * `rootIsHeld` is the caller's own evidence and never a guess — a child whose
   * `exit` has not been delivered is a process whose handle this runtime still
   * has open, which is the module header's mechanism. A caller that cannot say
   * that passes `false` and nothing is recorded, which is the honest outcome:
   * the set stays whatever the last live reading made it.
   */
  captureDescendants(rootIsHeld: boolean): void {
    if (this.#descendantsCaptured || !rootIsHeld || this.#identity === undefined) {
      return;
    }
    this.#descendantsCaptured = true;
    this.#identity.captureLiveDescendants();
  }

  /**
   * The last act on this tree's own number: drop what is no longer itself.
   *
   * Run from the root's `exit`, where nothing may be ADDED — the module header
   * has why — and where an intersection is still sound because it asks nothing of
   * a row the capture does not already name.
   */
  narrowAtRootExit(): void {
    this.#identity?.narrowCapturedDescendants();
  }

  /**
   * The identity a signal is re-verified against, captured or honestly unverified.
   *
   * A tree signalled before its root was ever captured — the misuse path, where
   * the settle-time registrar refused — falls back to the unverified reading,
   * which is the honest one for a tree whose identity was never taken.
   */
  identityFor(processId: number): SpawnedTreeIdentity {
    return this.#identity ?? SpawnedTreeIdentity.unverified(processId);
  }
}
