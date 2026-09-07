// The ledger's phase-one write queue — the half of the scroll chokepoint that
// belongs to a FRAME rather than to a gesture.
//
// `scroll-chokepoint.ts` owns what a write IS: the closed caller union, the clamp,
// the learned quantization, the geometry it publishes. This module owns WHEN a
// reactive write happens, which is a different question with a different answer, and
// the split is where it stops being buried in the controller: a gesture writes in the
// frame the person acted in, and a reaction to geometry writes in phase one of the
// next frame, against that frame's one clean sample.
//
// THREE DECISIONS THIS MODULE MAKES:
//
//   • **The sample is taken once, before any of the frame's writes.** Every reactive
//     caller in one frame computes against the same geometry. Re-reading the surface
//     per caller would hand the second caller a height the first one moved, which is
//     the disagreement that makes a follower and an anchor fight over one frame.
//   • **Coalesced per CALLER, on the union the chokepoint already closes.** A follower
//     that asked twice in one frame wants the second answer; two different callers
//     still both get a turn, in submission order. Coalescing per anything coarser
//     would silently drop one subsystem's write, which is the failure the caller union
//     exists to make impossible to do by accident.
//   • **A request refuses rather than degrading to an immediate write.** With no
//     coordinator adopted there is no frame to be ordered inside, and an unordered
//     fallback would be exactly the path the coordinator exists to close — available,
//     silently, to whichever composition forgot to wire the frame.

import { type LedgerFrameCoordinator } from "../coordinator/frame-coordinator.js";
import { type LedgerGeometry } from "../measurement/index.js";
import { type LedgerScrollCaller } from "./scroll-callers.js";

/**
 * What a phase-one caller computes: the offset it wants, from the frame's one clean
 * geometry sample. `undefined` withdraws the request, which is how a caller whose
 * reason has passed by the time the frame runs writes nothing at all.
 */
export type LedgerScrollTargetComputation = (geometry: LedgerGeometry) => number | undefined;

/**
 * The narrow port back into the chokepoint.
 *
 * Two members, deliberately: this module decides WHEN and the controller decides
 * WHAT, so anything wider would let the frame queue reach into the clamp, the
 * quantization, or the publication — every one of which is the controller's.
 */
export interface LedgerScrollWriteSurface {
  /** The last published sample, or `undefined` before the first attach. */
  readonly lastGeometry: LedgerGeometry | undefined;
  /** Perform the write. The controller's one `scrollTop` write path. */
  readonly glide: (caller: LedgerScrollCaller, targetScrollTop: number) => void;
}

/** Reactive scroll writes, held for phase one of the next frame. */
export class LedgerScrollFrameWrites {
  readonly #writeSurface: LedgerScrollWriteSurface;
  readonly #taskKeyByCaller = new Map<LedgerScrollCaller, string>();
  readonly #pendingByCaller = new Map<LedgerScrollCaller, LedgerScrollTargetComputation>();

  #frameCoordinator: LedgerFrameCoordinator | undefined;
  #released = false;

  public constructor(writeSurface: LedgerScrollWriteSurface) {
    this.#writeSurface = writeSurface;
  }

  /**
   * Join a frame.
   *
   * Single-shot and idempotent. Adopting a second, different coordinator would put
   * one controller's writes in two frames, which is the split being ordered at all
   * exists to end — so it throws rather than picking one.
   */
  public adopt(frameCoordinator: LedgerFrameCoordinator): void {
    if (this.#released || this.#frameCoordinator === frameCoordinator) {
      return;
    }
    if (this.#frameCoordinator !== undefined) {
      throw new Error(
        "LedgerScrollFrameWrites: a second frame coordinator was adopted; one controller writes inside one frame",
      );
    }
    this.#frameCoordinator = frameCoordinator;
  }

  /** Whether a frame has been adopted. What `request` refuses on. */
  public get hasFrame(): boolean {
    return this.#frameCoordinator !== undefined;
  }

  /** Requests still waiting for phase one. */
  public get pendingCount(): number {
    return this.#pendingByCaller.size;
  }

  /**
   * Ask for a write in the next frame's phase one.
   *
   * Returns whether the request was taken, so a caller can tell "queued" from "this
   * controller is in no frame" rather than assuming the write is coming.
   */
  public request(
    caller: LedgerScrollCaller,
    computeTarget: LedgerScrollTargetComputation,
  ): boolean {
    const frameCoordinator = this.#frameCoordinator;
    if (frameCoordinator === undefined || this.#released) {
      return false;
    }
    this.#pendingByCaller.set(caller, computeTarget);
    frameCoordinator.scheduleScrollWrite(this.#taskKeyFor(frameCoordinator, caller), () => {
      this.#runPending(caller);
    });
    return true;
  }

  /** Terminal. Cancels every submitted task and drops every pending computation. */
  public release(): void {
    const frameCoordinator = this.#frameCoordinator;
    if (frameCoordinator !== undefined) {
      for (const taskKey of this.#taskKeyByCaller.values()) {
        frameCoordinator.cancel("scroll-writes", taskKey);
      }
    }
    this.#taskKeyByCaller.clear();
    this.#pendingByCaller.clear();
    this.#frameCoordinator = undefined;
    this.#released = true;
  }

  #runPending(caller: LedgerScrollCaller): void {
    const computeTarget = this.#pendingByCaller.get(caller);
    this.#pendingByCaller.delete(caller);
    if (computeTarget === undefined || this.#released) {
      return;
    }
    const geometry = this.#writeSurface.lastGeometry;
    if (geometry === undefined) {
      // No sample yet means no attached surface, so there is nothing to write to and
      // nothing to compute against. Silently dropping is right here and only here:
      // the request was for a frame this controller turned out not to have a box in.
      return;
    }
    const targetScrollTop = computeTarget(geometry);
    if (targetScrollTop === undefined) {
      return;
    }
    this.#writeSurface.glide(caller, targetScrollTop);
  }

  /** One key per caller per coordinator, so two callers never coalesce into one. */
  #taskKeyFor(frameCoordinator: LedgerFrameCoordinator, caller: LedgerScrollCaller): string {
    const existing = this.#taskKeyByCaller.get(caller);
    if (existing !== undefined) {
      return existing;
    }
    const taskKey = frameCoordinator.claimTaskKey(`ledger-scroll-${caller}`);
    this.#taskKeyByCaller.set(caller, taskKey);
    return taskKey;
  }
}
