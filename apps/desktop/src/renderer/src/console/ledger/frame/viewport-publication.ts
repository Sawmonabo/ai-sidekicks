// The one place the ledger frame tells React that something changed.
//
// WHY IT IS ITS OWN OBJECT. `viewport-controller.ts` is the wiring: it owns the four
// objects and decides when each is asked anything. Deciding whether the tree needs
// to hear about the result is a different job with its own state — the snapshot
// currently held, and the frame a burst of notifications is coalesced into — and
// every producer in that file ends by asking for it, which is exactly the shape a
// collaborator takes over so the wiring reads as wiring.
//
// TWO PROPERTIES THIS OBJECT EXISTS TO KEEP:
//
//   • **A snapshot is a value, recomputed on change.** `useSyncExternalStore`
//     demands a stable reference between changes, and recomputing one per render
//     would tear the tree. So the value is BUILT through the thunk this is
//     constructed with, held, and replaced only when it differs.
//   • **A notification that carries no change is not merely waste.** A render
//     re-runs the virtualizer's layout effects, which can move the offset, which
//     notifies again — so an unchanged publication is one turn of a loop that does
//     not settle. The comparison below is the thing that stops it.
//
// THE COMPARISON LIVES HERE RATHER THAN IN `viewport-snapshot.ts` BECAUSE IT IS NOT
// A FACT ABOUT THE VALUE. It encodes which members the controller REBUILDS on change
// and which it merely re-reads: the three arrays and the prune outcome are compared
// by identity because each is rebuilt exactly when it changes, and the three reading
// fields by value because they are copied off the anchor on every build. That is a
// property of the producer, and it belongs beside the producer's publication point.

import {
  Emitter,
  type ConsoleClock,
  type ScheduledHandle,
  type Unsubscribe,
} from "../../core/index.js";
import { type LedgerViewportSnapshot } from "./viewport-snapshot.js";

export interface LedgerViewportPublicationOptions {
  readonly clock: ConsoleClock;
  /** Rebuild the snapshot from the frame's objects. Called once per publication. */
  readonly build: () => LedgerViewportSnapshot;
}

/** Whether two snapshots say the same thing to a render. See this file's header. */
function sameViewportSnapshot(
  left: LedgerViewportSnapshot,
  right: LedgerViewportSnapshot,
): boolean {
  return (
    left.rows === right.rows &&
    left.rowKeys === right.rowKeys &&
    left.keyProjection === right.keyProjection &&
    left.lastPrune === right.lastPrune &&
    left.reading.mode === right.reading.mode &&
    left.reading.newRowCount === right.reading.newRowCount &&
    left.reading.pinnedRootCursor === right.reading.pinnedRootCursor
  );
}

export class LedgerViewportPublication {
  readonly #clock: ConsoleClock;
  readonly #build: () => LedgerViewportSnapshot;
  readonly #changeEmitter = new Emitter<void>("ledger viewport snapshot");

  #snapshot: LedgerViewportSnapshot;
  #frame: ScheduledHandle | undefined;
  #disposed = false;

  public constructor(options: LedgerViewportPublicationOptions) {
    this.#clock = options.clock;
    this.#build = options.build;
    this.#snapshot = options.build();
  }

  /** The stable value a render reads. Same reference until something changes. */
  public get current(): LedgerViewportSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changeEmitter.subscribe(sink);
  }

  /** Rebuild, and notify only if the rebuilt value differs from the held one. */
  public publish(): void {
    const next = this.#build();
    if (sameViewportSnapshot(next, this.#snapshot)) {
      return;
    }
    this.#snapshot = next;
    this.#changeEmitter.emit(undefined);
  }

  /** Coalesce a burst of notifications into one publication on the next frame. */
  public scheduleFrame(): void {
    if (this.#frame !== undefined || this.#disposed) {
      return;
    }
    this.#frame = this.#clock.scheduleFrame(() => {
      this.#frame = undefined;
      this.publish();
    });
  }

  /** Terminal. The armed frame is cancelled and every sink is dropped. */
  public dispose(): void {
    if (this.#frame !== undefined) {
      this.#clock.cancel(this.#frame);
      this.#frame = undefined;
    }
    this.#changeEmitter.clear();
    this.#disposed = true;
  }
}
