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
//
// A command output is parsed only while its row is within the drawn band's reach, which the
// viewport hands over each time it walks the band with the rows in view, and only while its call is
// open. A row leaving the reach lets its parse go, and the viewport mounts a row coming into it
// only once its output is parsed whole again. A row that has never been listed is within reach as
// the listed row it joins after is; one outside is listed at once, unparsed. A folded call opens
// once its output is parsed whole, so it draws formatted on the frame it opens.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { type OutputReach } from "../rows/ansi/preparation.js";
import {
  type TranscriptRowPreparation,
  type TranscriptRowPreparer,
  type TranscriptRowSources,
} from "../rows/renderer.js";
import { type ViewportRow } from "../viewport/snapshot.js";
import { holdsSameObjects } from "../window/row-positions.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";

/** What the feed hands the gate for its rows to read: everything but what the gate itself says. */
export type FeedRowSources = Omit<TranscriptRowSources, "reachOf" | "isCallFolded">;

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
  /**
   * How near the viewport each row within the drawn band's reach stands, by id, a row outside it
   * absent: a listed row as the viewport last walked the band, and a row joining the list as the
   * pass decided until then.
   */
  readonly #reachByRowId = new Map<string, Exclude<OutputReach, "outside">>();
  /** The calls a person folded, as the feed last handed them over. */
  #foldedCallRowIds: ReadonlySet<string> = new Set<string>();
  /**
   * The folded calls opening, read as open so their outputs are parsed, each with its press while
   * it waits on the parse and `undefined` once pressed, until the folds handed over open it.
   */
  readonly #openingCallRowIds = new Map<string, (() => void) | undefined>();
  /** The feed's sources last handed over, and the ones its rows read with the gate's answers. */
  #rowSources: { readonly feed: FeedRowSources; readonly row: TranscriptRowSources } | undefined;
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

  /**
   * Hands over the rows within the drawn band's reach and, among them, the rows in view, by key,
   * each time the viewport walks the band: a listed row coming into it is parsed, at once in view,
   * and one leaving it lets its parse go.
   */
  public readonly observeReach = (
    rowKeys: ReadonlySet<string>,
    viewRowKeys: ReadonlySet<string>,
  ): void => {
    for (const rowId of this.#reachByRowId.keys()) {
      // A row still held out keeps what its pass decided.
      if (!rowKeys.has(rowId) && !this.#heldOutRowIds.has(rowId)) {
        this.#setReach(rowId, "outside");
      }
    }
    for (const rowKey of rowKeys) {
      this.#setReach(rowKey, viewRowKeys.has(rowKey) ? "view" : "band");
    }
  };

  /**
   * Whether a row's command output, if it draws one, is parsed whole as the row would draw now: a
   * row the viewport mounts only once it is.
   */
  public readonly isOutputParsed = (rowKey: string): boolean => {
    const held = this.#preparations.get(rowKey);
    return held === undefined || (held.drawn ?? held).preparation.isOutputReady;
  };

  /**
   * Runs `press`, a press on a call's chevron: at once on an open call, which it folds, and on a
   * folded one once its output is parsed whole, so the call opens formatted.
   */
  public readonly toggleCall = (rowId: string, press: () => void): void => {
    const held = this.#preparations.get(rowId);
    if (!this.#foldedCallRowIds.has(rowId) || held === undefined) {
      press();
      return;
    }
    this.#openingCallRowIds.set(rowId, press);
    held.preparation.refresh();
    this.#openOnceReady(rowId, held.preparation);
  };

  /** How near the viewport a row stands; see `TranscriptRowSources.reachOf`. */
  public readonly reachOf = (rowId: string): OutputReach =>
    this.#reachByRowId.get(rowId) ?? "outside";

  /** Whether a call is folded and not opening; see `TranscriptRowSources.isCallFolded`. */
  public readonly isCallFolded = (rowId: string): boolean =>
    this.#foldedCallRowIds.has(rowId) && !this.#openingCallRowIds.has(rowId);

  /** Whether `dispose` has run; a disposed gate prepares nothing and is replaced. */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /**
   * Hands over the calls a person folded: a call folding lets its parse go, and one opening any
   * other way than `toggleCall` starts it. Called with each pass, before `filter`.
   */
  public observeFolds(foldedCallRowIds: ReadonlySet<string>): void {
    const lastFoldedCallRowIds = this.#foldedCallRowIds;
    if (foldedCallRowIds === lastFoldedCallRowIds) {
      return;
    }
    this.#foldedCallRowIds = foldedCallRowIds;
    for (const [rowId, press] of this.#openingCallRowIds) {
      if (press === undefined && !foldedCallRowIds.has(rowId)) {
        this.#openingCallRowIds.delete(rowId);
      }
    }
    for (const rowId of foldedCallRowIds) {
      if (!lastFoldedCallRowIds.has(rowId)) {
        this.#preparations.get(rowId)?.preparation.refresh();
      }
    }
    for (const rowId of lastFoldedCallRowIds) {
      if (!foldedCallRowIds.has(rowId)) {
        this.#preparations.get(rowId)?.preparation.refresh();
      }
    }
  }

  /** One pass over the drawn window: every row that draws whole, and the rows still held. */
  public filter(
    model: TranscriptWindowModel,
    prepareRow: TranscriptRowPreparer,
    feedSources: FeedRowSources,
  ): PreparedRows {
    const last = this.#last;
    if (
      last !== undefined &&
      last.model === model &&
      last.prepareRow === prepareRow &&
      last.sources === feedSources &&
      last.readiness === this.#readiness
    ) {
      return last.output;
    }
    const sources = this.#rowSourcesOf(feedSources);
    this.#reachUnlistedRows(model.rows);
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
    this.#last = { model, prepareRow, sources: feedSources, readiness: this.#readiness, output };
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

  /** The sources the rows read: the feed's, with the gate's answers on reach and folds. */
  #rowSourcesOf(feedSources: FeedRowSources): TranscriptRowSources {
    if (this.#rowSources?.feed !== feedSources) {
      this.#rowSources = {
        feed: feedSources,
        row: {
          ...feedSources,
          reachOf: this.reachOf,
          isCallFolded: this.isCallFolded,
        },
      };
    }
    return this.#rowSources.row;
  }

  /**
   * Decides, for each row not listed last pass, whether it is within reach: as the listed row it
   * joins after is, or above every listed row, as the first of them is. With none listed, the
   * feed is opening at its tail, and every row is.
   */
  #reachUnlistedRows(rows: readonly TranscriptEventRow[]): void {
    const firstListedRow = rows.find((row) => this.#listedRowIds.has(row.id));
    let isWithinReach = firstListedRow === undefined || this.#reachByRowId.has(firstListedRow.id);
    for (const row of rows) {
      if (this.#listedRowIds.has(row.id)) {
        isWithinReach = this.#reachByRowId.has(row.id);
      } else {
        this.#setReach(row.id, isWithinReach ? "band" : "outside");
      }
    }
  }

  /**
   * Moves a row to `reach`, reading its preparation again: one coming within reach starts its
   * parse, at once in view, and one leaving lets its parse go, the last version drawn while a
   * change of it was prepared included, so the next pass lists the changed row.
   */
  #setReach(rowId: string, reach: OutputReach): void {
    if (this.reachOf(rowId) === reach) {
      return;
    }
    if (reach === "outside") {
      this.#reachByRowId.delete(rowId);
    } else {
      this.#reachByRowId.set(rowId, reach);
    }
    const held = this.#preparations.get(rowId);
    if (held === undefined) {
      return;
    }
    held.preparation.refresh();
    if (reach === "outside" && held.drawn !== undefined) {
      held.drawn.preparation.release();
      this.#preparations.set(rowId, { ...held, drawn: undefined });
      this.#readiness += 1;
      // Told once the walk ends: the viewport walks the band while it renders.
      queueMicrotask(() => {
        this.#tellReadiness();
      });
    }
  }

  /** Opens an opening call whose press waits, once its output is parsed whole. */
  #openOnceReady(rowId: string, preparation: TranscriptRowPreparation): void {
    const press = this.#openingCallRowIds.get(rowId);
    if (press !== undefined && preparation.isReady) {
      this.#openingCallRowIds.set(rowId, undefined);
      press();
    }
  }

  #tellReadiness(): void {
    for (const listener of this.#listeners) {
      listener();
    }
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
      this.#openOnceReady(row.id, current.preparation);
      // A listed row drawn as itself is not held, so the list has nothing to change for it.
      if (this.#listedRowIds.has(row.id) && current.drawn === undefined) {
        return;
      }
      this.#readiness += 1;
      this.#tellReadiness();
    });
    if (preparation === undefined) {
      drawn?.preparation.release();
      return row;
    }
    // A row outside the reach is not mounted, so its last version need not be drawn meanwhile.
    if (preparation.isReady || drawn === undefined || !this.#reachByRowId.has(row.id)) {
      drawn?.preparation.release();
      this.#preparations.set(row.id, { row, preparation, drawn: undefined });
      return wasListed || this.#isListable(row.id, preparation) ? row : undefined;
    }
    this.#preparations.set(row.id, { row, preparation, drawn });
    return drawn.row;
  }

  /** What a row held since the last pass is listed as, letting its last version go once whole. */
  #settledRowOf(held: HeldPreparation, wasListed: boolean): TranscriptEventRow | undefined {
    if (held.drawn === undefined) {
      return wasListed || this.#isListable(held.row.id, held.preparation) ? held.row : undefined;
    }
    if (!held.preparation.isReady) {
      return held.drawn.row;
    }
    held.drawn.preparation.release();
    this.#preparations.set(held.row.id, { ...held, drawn: undefined });
    return held.row;
  }

  /** Whether a row not listed before joins the list: once it draws whole, or outside the reach. */
  #isListable(rowId: string, preparation: TranscriptRowPreparation): boolean {
    return preparation.isReady || !this.#reachByRowId.has(rowId);
  }

  #withdraw(rowId: string, held: HeldPreparation): void {
    this.#preparations.delete(rowId);
    this.#reachByRowId.delete(rowId);
    this.#openingCallRowIds.delete(rowId);
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
  readonly sources: FeedRowSources;
  readonly readiness: number;
  readonly output: PreparedRows;
}

const NO_ROWS: readonly ViewportRow[] = Object.freeze([]);
