// The one place the transcript frame tells React something changed.
//   - A snapshot is a value rebuilt through `build` and replaced only when it differs, because
//     `useSyncExternalStore` needs a stable reference between changes.
//   - An unchanged publication must not notify: a render re-runs the virtualizer's layout
//     effects, which can move the offset and notify again, a loop that never settles.
// The comparison lives here rather than in `snapshot.ts` because it encodes which
// members the controller rebuilds on change (rows, row keys, key projection and prune outcome,
// compared by identity) and which it re-reads (the three reading fields, compared by value).

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

  public constructor(options: ViewportPublicationOptions) {
    this.#build = options.build;
    this.#snapshot = options.build();
  }

  /** The stable value a render reads. Same reference until something changes. */
  public get current(): ViewportSnapshot {
    return this.#snapshot;
  }

  /** Hear every change to the snapshot; an unchanged publication notifies nobody. */
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
    left.reading.mode === right.reading.mode &&
    left.reading.newRowCount === right.reading.newRowCount &&
    left.reading.pinnedRootCursor === right.reading.pinnedRootCursor
  );
}
