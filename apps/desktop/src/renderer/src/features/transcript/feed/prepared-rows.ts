// The rows the feed lists only once they draw whole, and the rest kept ready to scroll to. After
// the drawn-row filter, a row whose first frame still waits on work (a finished diagram's picture,
// the formula typesetter) is held out of the viewport's list until that work lands or fails, so no
// frame draws it half-made. Each row is held on its own, so a row below a held one is listed at
// once and the tail keeps following; but rows arriving above every listed row, as a page read back
// toward the head brings them, wait with the last of them still held, so it joins at the head of
// the list, above the reader, never between rows on screen. A listed row stays listed while the
// window holds it, so no row leaves from above the reader; its preparation is kept and refreshed as
// its text grows, so a row the virtualizer has not mounted has its pictures ready before a scroll
// or a jump reaches it. A listed row that changes, as one does when its large body is read in
// full, is drawn as it last stood until the changed row draws whole, so the change lands formatted
// on its first frame. A row the window lets go is prepared again when it comes back.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import {
  type TranscriptRowPreparation,
  type TranscriptRowPreparer,
  type TranscriptRowSources,
} from "../rows/renderer.js";
import { type ViewportRow } from "../viewport/snapshot.js";
import { holdsSameObjects } from "../window/row-positions.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";

/** One pass's answer: the window the viewport draws, and the rows still held out of it. */
export interface PreparedRows {
  /**
   * The drawn window less the rows still being prepared. It keeps the input's maps, which are
   * read by a key the list or a link hands over, as the drawn-row filter's window does.
   */
  readonly window: TranscriptWindowModel;
  /**
   * The rows held out, in log order. They wait to be listed, so the store keeps their events
   * however the window's edges move.
   */
  readonly preparingRows: readonly ViewportRow[];
}

/**
 * Holds each drawn row out of the window until its renderer says it draws whole, keeps every row's
 * preparation while the window holds it, and publishes a new pass whenever a held row becomes
 * ready. Disposed with the feed that minted it, which withdraws every preparation still running.
 */
export class PreparedRowGate {
  readonly #listeners = new Set<() => void>();
  /** Hear any row's work landing, listed or held. */
  readonly #workListeners = new Set<() => void>();
  /** The rows listed by the last pass, by id: each stays listed while the input holds it. */
  #listedRowIds: ReadonlySet<string> = new Set<string>();
  /** The rows the last pass held out, by id. */
  #heldOutRowIds: ReadonlySet<string> = new Set<string>();
  /**
   * The listed rows the last pass held a row out right after, by key; `undefined` stands for a
   * row held out before the first listed one.
   */
  #listedKeysBeforeHeldRows: ReadonlySet<string | undefined> = new Set<string | undefined>();
  /** Every row's preparation the window holds, listed or held, by row id. */
  readonly #preparations = new Map<string, HeldPreparation>();
  /** Raised each time a held row becomes ready: what a pass is memoized on beside its inputs. */
  #readiness = 0;
  #last: GatePass | undefined;
  #isDisposed = false;

  /** Hear each held row becoming ready. Returns the unsubscribe. */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** A number that changes each time a held row becomes ready. */
  public readonly readReadiness = (): number => this.#readiness;

  /**
   * Whether a row the window holds draws whole if mounted now: true for a row with nothing to
   * wait on, false for a held row and for a listed one whose newly settled work is still out.
   */
  public readonly isPrepared = (rowKey: string): boolean => {
    const held = this.#preparations.get(rowKey);
    // A changed row's last version is what draws while the change is prepared.
    return held === undefined || (held.drawn ?? held).preparation.isReady;
  };

  /** Whether the last pass held this row out of the list, so it joins the list later. */
  public readonly isHeldOut = (rowKey: string): boolean => this.#heldOutRowIds.has(rowKey);

  /**
   * Whether the last pass held a row out right after the listed row `rowKey`, or before the first
   * listed row for `undefined`: where a held row joins the list once it is ready.
   */
  public readonly holdsRowAfter = (rowKey: string | undefined): boolean =>
    this.#listedKeysBeforeHeldRows.has(rowKey);

  /** Hear each time any row's work lands, so a landing waiting on it can ask again. */
  public readonly subscribeToWork = (listener: () => void): (() => void) => {
    this.#workListeners.add(listener);
    return () => {
      this.#workListeners.delete(listener);
    };
  };

  /** Whether `dispose` has run; a disposed gate prepares nothing and is replaced. */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /** One pass over the drawn window: every row that draws whole, and the rows still held. */
  public filter(
    model: TranscriptWindowModel,
    prepareRow: TranscriptRowPreparer,
    sources: TranscriptRowSources,
  ): PreparedRows {
    const last = this.#last;
    if (
      last !== undefined &&
      last.model === model &&
      last.prepareRow === prepareRow &&
      last.sources === sources &&
      last.readiness === this.#readiness
    ) {
      return last.output;
    }
    const viewportRows: ViewportRow[] = [];
    const rows: TranscriptEventRow[] = [];
    const preparingRows: ViewportRow[] = [];
    const listedRowIds = new Set<string>();
    const heldRowIds = new Set<string>();
    const heldOutRowIds = new Set<string>();
    const listedKeysBeforeHeldRows = new Set<string | undefined>();
    // What each row is listed as, its last version while a change of it is prepared.
    const listedRowById = new Map<string, TranscriptEventRow | undefined>();
    const lastVersionById = new Map<string, TranscriptEventRow>();
    for (const row of model.rows) {
      listedRowById.set(row.id, this.#listedRowOf(row, prepareRow, sources));
    }
    const lastHeadHeldRowId = this.#lastHeldBeforeListedRows(model.rows, listedRowById);
    let isInHeadHold = lastHeadHeldRowId !== undefined;
    let rowPosition = 0;
    // The window lists each row's identity in the rows' own order, a header standing before a run
    // group's first row; a header names no row, so it is always listed.
    for (const identity of model.viewportRows) {
      const row = model.rows[rowPosition];
      if (row === undefined || row.id !== identity.key) {
        viewportRows.push(identity);
        continue;
      }
      rowPosition += 1;
      heldRowIds.add(row.id);
      const listedRow = isInHeadHold ? undefined : listedRowById.get(row.id);
      if (row.id === lastHeadHeldRowId) {
        isInHeadHold = false;
      }
      if (listedRow !== undefined) {
        listedRowIds.add(row.id);
        viewportRows.push(identity);
        rows.push(listedRow);
        if (listedRow !== row) {
          lastVersionById.set(row.id, listedRow);
        }
      } else {
        preparingRows.push(identity);
        heldOutRowIds.add(row.id);
        listedKeysBeforeHeldRows.add(viewportRows.at(-1)?.key);
      }
    }
    // A row the window let go is withdrawn: it is prepared again if it returns.
    for (const [rowId, held] of this.#preparations) {
      if (!heldRowIds.has(rowId)) {
        this.#withdraw(rowId, held);
      }
    }
    this.#listedRowIds = listedRowIds;
    this.#heldOutRowIds = heldOutRowIds;
    this.#listedKeysBeforeHeldRows = listedKeysBeforeHeldRows;
    const output: PreparedRows =
      preparingRows.length === 0 && lastVersionById.size === 0
        ? { window: model, preparingRows: NO_ROWS }
        : {
            window: {
              ...model,
              viewportRows:
                preparingRows.length === 0
                  ? model.viewportRows
                  : last !== undefined &&
                      holdsSameObjects(viewportRows, last.output.window.viewportRows)
                    ? last.output.window.viewportRows
                    : viewportRows,
              rows,
              rowsByKey:
                lastVersionById.size === 0
                  ? model.rowsByKey
                  : new Map([...model.rowsByKey, ...lastVersionById]),
            },
            preparingRows:
              preparingRows.length === 0
                ? NO_ROWS
                : last !== undefined && holdsSameObjects(preparingRows, last.output.preparingRows)
                  ? last.output.preparingRows
                  : preparingRows,
          };
    this.#last = { model, prepareRow, sources, readiness: this.#readiness, output };
    return output;
  }

  /**
   * Reads every listed row's text again and starts what its newly finished blocks wait on, without
   * holding the row: called on each frame the reveal drained and each palette change. A row whose
   * text did not change costs a lookup.
   */
  public refresh(): void {
    for (const [rowId, held] of this.#preparations) {
      if (this.#listedRowIds.has(rowId)) {
        held.preparation.refresh();
      }
    }
  }

  /** Withdraw every preparation still running. */
  public dispose(): void {
    this.#isDisposed = true;
    for (const [rowId, held] of this.#preparations) {
      this.#withdraw(rowId, held);
    }
    this.#listeners.clear();
    this.#workListeners.clear();
  }

  /**
   * The last row still held among the rows that arrived before every row listed last pass, as a
   * page read back toward the head brings them, or `undefined` for none. The rows before it wait
   * with it, so it joins at the list's head, above the reader, where the reading position is held,
   * rather than between rows on screen.
   */
  #lastHeldBeforeListedRows(
    rows: readonly TranscriptEventRow[],
    listedRowById: ReadonlyMap<string, TranscriptEventRow | undefined>,
  ): string | undefined {
    let lastHeldRowId: string | undefined;
    for (const row of rows) {
      if (this.#listedRowIds.has(row.id)) {
        return lastHeldRowId;
      }
      if (listedRowById.get(row.id) === undefined) {
        lastHeldRowId = row.id;
      }
    }
    // With no row listed last pass, the feed is opening, and each row is held on its own.
    return undefined;
  }

  /**
   * What `row` is listed as, or `undefined` while it waits: itself once listed before, ready now
   * or ready since its preparation began, and the version of it last listed while a change of a
   * listed row is still being prepared.
   */
  #listedRowOf(
    row: TranscriptEventRow,
    prepareRow: TranscriptRowPreparer,
    sources: TranscriptRowSources,
  ): TranscriptEventRow | undefined {
    const wasListed = this.#listedRowIds.has(row.id);
    const held = this.#preparations.get(row.id);
    if (held?.row === row) {
      return this.#settledRowOf(held, wasListed);
    }
    // The row changed, so what it waits on may have too; the version drawn now stays drawn.
    const drawn = held?.drawn ?? (wasListed ? held : undefined);
    if (held !== undefined && held !== drawn) {
      held.preparation.release();
    }
    this.#preparations.delete(row.id);
    if (this.#isDisposed) {
      drawn?.preparation.release();
      return wasListed ? row : undefined;
    }
    // Declared ahead of the call, since a preparation may answer before it returns.
    let preparation: TranscriptRowPreparation | undefined = undefined;
    preparation = prepareRow(row, sources, () => {
      const current = this.#preparations.get(row.id);
      // A pass under way reads the readiness itself.
      if (current === undefined || current.preparation !== preparation) {
        return;
      }
      for (const listener of this.#workListeners) {
        listener();
      }
      // A listed row drawn as itself is not held, so the list has nothing to change for it.
      if (this.#listedRowIds.has(row.id) && current.drawn === undefined) {
        return;
      }
      this.#readiness += 1;
      for (const listener of this.#listeners) {
        listener();
      }
    });
    if (preparation === undefined) {
      drawn?.preparation.release();
      return row;
    }
    if (preparation.isReady || drawn === undefined) {
      drawn?.preparation.release();
      this.#preparations.set(row.id, { row, preparation, drawn: undefined });
      return wasListed || preparation.isReady ? row : undefined;
    }
    this.#preparations.set(row.id, { row, preparation, drawn });
    return drawn.row;
  }

  /** What a row held since the last pass is listed as, letting its last version go once whole. */
  #settledRowOf(held: HeldPreparation, wasListed: boolean): TranscriptEventRow | undefined {
    if (held.drawn === undefined) {
      return wasListed || held.preparation.isReady ? held.row : undefined;
    }
    if (!held.preparation.isReady) {
      return held.drawn.row;
    }
    held.drawn.preparation.release();
    this.#preparations.set(held.row.id, { ...held, drawn: undefined });
    return held.row;
  }

  #withdraw(rowId: string, held: HeldPreparation): void {
    this.#preparations.delete(rowId);
    held.preparation.release();
    held.drawn?.preparation.release();
  }
}

/** One row's preparation, the row object it was started for, and the version drawn meanwhile. */
interface HeldPreparation {
  readonly row: TranscriptEventRow;
  readonly preparation: TranscriptRowPreparation;
  /** The row's last listed version, drawn while this changed one is prepared. */
  readonly drawn: HeldPreparation | undefined;
}

/** One pass's inputs and what it published. */
interface GatePass {
  readonly model: TranscriptWindowModel;
  readonly prepareRow: TranscriptRowPreparer;
  readonly sources: TranscriptRowSources;
  readonly readiness: number;
  readonly output: PreparedRows;
}

const NO_ROWS: readonly ViewportRow[] = Object.freeze([]);
