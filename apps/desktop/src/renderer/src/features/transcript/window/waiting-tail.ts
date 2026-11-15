// The person's waiting messages joined after a window of the log. They stand after every row the
// log holds and inside no run group, so they are kept out of the log's derivation and of the run
// group fold: an event the log grows by reaches both as an appended stretch, and the waiting rows
// join each stage's answer after it. A waiting row is projected once per event it is drawn as.

import {
  type ProjectedSessionEvent,
  type ProjectedTranscriptRow,
} from "#renderer/store/session/entities/vocabulary.js";
import { TranscriptRowProjector } from "../projection/rows.js";
import { type ViewportRow } from "../viewport/snapshot.js";
import { JoinedMap } from "./map-views.js";
import { holdsSameObjects } from "./row-positions.js";
import { type TranscriptWindowModel } from "./transcript-window.js";

/**
 * Joins one session's waiting rows after any window of its log, the same joined window for the
 * same window and rows, so a stage reading it reads an unchanged input as unchanged.
 */
export class WaitingTailJoin {
  readonly #rowByEvent = new WeakMap<ProjectedSessionEvent, ProjectedTranscriptRow>();
  #tail: readonly ProjectedSessionEvent[] = [];
  #rows: readonly ProjectedTranscriptRow[] = [];
  #identities: readonly ViewportRow[] = [];
  #rowsByKey: ReadonlyMap<string, ProjectedTranscriptRow> = new Map();
  /** The joined window each window was last answered with, and the rows it joined. */
  readonly #joined = new WeakMap<
    TranscriptWindowModel,
    { readonly rows: readonly ProjectedTranscriptRow[]; readonly window: TranscriptWindowModel }
  >();

  /** `model` with the rows `tail`, the waiting events in the order drawn, after its own. */
  public join(
    model: TranscriptWindowModel,
    tail: readonly ProjectedSessionEvent[],
  ): TranscriptWindowModel {
    this.#adopt(tail);
    if (this.#rows.length === 0) {
      return model;
    }
    const held = this.#joined.get(model);
    if (held?.rows === this.#rows) {
      return held.window;
    }
    const window: TranscriptWindowModel = {
      ...model,
      viewportRows: [...model.viewportRows, ...this.#identities],
      rows: [...model.rows, ...this.#rows],
      rowsByKey: new JoinedMap(model.rowsByKey, this.#rowsByKey),
    };
    this.#joined.set(model, { rows: this.#rows, window });
    return window;
  }

  #adopt(tail: readonly ProjectedSessionEvent[]): void {
    if (tail === this.#tail) {
      return;
    }
    this.#tail = tail;
    const rows = new TranscriptRowProjector(this.#rowByEvent).project(tail).rows;
    if (holdsSameObjects(rows, this.#rows)) {
      return;
    }
    const identityByKey = new Map(this.#identities.map((identity) => [identity.key, identity]));
    this.#rows = rows;
    this.#identities = rows.map(
      (row) =>
        identityByKey.get(row.id) ?? { key: row.id, parentKey: undefined, rootCursor: row.id },
    );
    this.#rowsByKey = new Map(rows.map((row) => [row.id, row]));
  }
}
