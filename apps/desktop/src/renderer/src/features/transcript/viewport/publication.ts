// The one place the transcript frame tells React something changed.
//   - A snapshot is a value rebuilt through `build` and replaced only when it differs, because
//     `useSyncExternalStore` needs a stable reference between changes.
//   - An unchanged publication must not notify: a render re-runs the virtualizer's layout
//     effects, which can move the offset and notify again, a loop that never settles.
//   - A publication made during a render notifies nobody: that render reads the new snapshot, and
//     React records what a store subscriber read only after the commit, so a notification before
//     then would render the tree again for a value it already drew.
// The comparison lives here rather than in `snapshot.ts` because it encodes which
// members the controller rebuilds on change (rows, row keys, key projection, prune outcome and
// held rows, the range extractor and the nested windows' band, compared by identity) and which it
// re-reads (the two reading fields and the head height, by value).

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { type ViewportSnapshot } from "./snapshot.js";

/** Dependencies of a `ViewportPublication`. */
export interface ViewportPublicationOptions {
  /** Rebuild the snapshot from the frame's objects. Called once per publication. */
  readonly build: () => ViewportSnapshot;
}

/** Holds the frame's stable snapshot and notifies subscribers only when it changes. */
export class ViewportPublication {
  readonly #build: () => ViewportSnapshot;
  readonly #changeEmitter = new Emitter<void>("transcript viewport snapshot");

  #snapshot: ViewportSnapshot;
  /** Whether a render is reading what the publications in `publishDuringRender` make. */
  #isRendering = false;

  public constructor(options: ViewportPublicationOptions) {
    this.#build = options.build;
    this.#snapshot = options.build();
  }

  /** The stable value a render reads. Same reference until something changes. */
  public get current(): ViewportSnapshot {
    return this.#snapshot;
  }

  /**
   * Hear every change to the snapshot made outside a render; an unchanged publication notifies
   * nobody, and a render's own reads its changes.
   */
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
    if (!this.#isRendering) {
      this.#changeEmitter.emit(undefined);
    }
  }

  /**
   * Runs `work`, which the render now drawing reads the result of, with every publication it makes
   * replacing the snapshot without notifying.
   */
  public publishDuringRender(work: () => void): void {
    this.#isRendering = true;
    try {
      work();
    } finally {
      this.#isRendering = false;
    }
  }

  /** Terminal. Every sink is dropped. */
  public dispose(): void {
    this.#changeEmitter.clear();
  }
}

/** Whether two snapshots say the same thing to a render. See this file's header. */
function sameViewportSnapshot(left: ViewportSnapshot, right: ViewportSnapshot): boolean {
  return (
    left.rows === right.rows &&
    left.rowKeys === right.rowKeys &&
    left.keyProjection === right.keyProjection &&
    left.lastPrune === right.lastPrune &&
    left.heldRowKeys === right.heldRowKeys &&
    left.rangeExtractor === right.rangeExtractor &&
    left.nestedBandScreenHeights === right.nestedBandScreenHeights &&
    left.reading.mode === right.reading.mode &&
    left.reading.newRowCount === right.reading.newRowCount &&
    left.headHeightPx === right.headHeightPx
  );
}
