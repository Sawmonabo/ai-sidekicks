// The gate that lists a row only once it draws whole, over a real store's window: a held row stays
// out while the rows below it are listed, joins once its work lands, and its preparation is
// withdrawn when the window lets it go; a page read back above the list waits with its last held
// row; and the store keeps a held page's events through a prune that lets the window's head go.

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { useReleaseOutsideWindow } from "../history/hooks/useReleaseOutsideWindow.js";
import { type TranscriptHistory } from "../history/hooks/useTranscriptHistory.js";
import { openPagedSessionStore, transcriptFixtureEventId } from "../logs.test-support.js";
import { OffListTables } from "../rows/markdown/table-window/off-list.js";
import { type TranscriptRowPreparation, type TranscriptRowSources } from "../rows/renderer.js";
import { type ViewportSnapshot } from "../viewport/snapshot.js";
import { type PruneOutcome } from "../viewport/window-cap.js";
import { deriveTranscriptWindow } from "../window/transcript-window.js";
import { PreparedRowGate } from "./prepared-rows.js";

/** The gate never reads these: the stand-in preparation below decides every row itself. */
const SOURCES: TranscriptRowSources = {
  publishedTextFor: () => undefined,
  ownerWindow: window,
  diagramPictures: undefined,
  offListTables: new OffListTables(document, () => undefined),
};

/**
 * A preparation for every row: the named rows wait until a case lands their work, a case may start
 * more work on any row, and every row counts the refreshes it was asked for and records its
 * release.
 */
class HeldPreparations {
  readonly #heldRowIds: ReadonlySet<string>;
  readonly landByRowId = new Map<string, () => void>();
  readonly startWorkByRowId = new Map<string, () => void>();
  readonly refreshedRowIds: string[] = [];
  readonly releasedRowIds: string[] = [];

  public readonly prepareRow = (
    row: TranscriptEventRow,
    _sources: TranscriptRowSources,
    onReady: () => void,
  ): TranscriptRowPreparation => {
    let isReady = !this.#heldRowIds.has(row.id);
    this.landByRowId.set(row.id, () => {
      isReady = true;
      onReady();
    });
    this.startWorkByRowId.set(row.id, () => {
      isReady = false;
    });
    return {
      get isReady() {
        return isReady;
      },
      refresh: () => {
        this.refreshedRowIds.push(row.id);
      },
      release: () => {
        this.releasedRowIds.push(row.id);
      },
    };
  };

  public constructor(heldRowIds: readonly string[]) {
    this.#heldRowIds = new Set(heldRowIds);
  }
}

function keysOf(rows: readonly { readonly key: string }[]): string[] {
  return rows.map((row) => row.key);
}

describe("PreparedRowGate", () => {
  it("lists the rows below a held row at once, the held row once its work lands, and refreshes the listed", () => {
    const store = openPagedSessionStore(0, 5);
    const model = deriveTranscriptWindow(store.snapshot().transcript);
    const heldRowId = transcriptFixtureEventId(2);
    const preparations = new HeldPreparations([heldRowId]);
    const gate = new PreparedRowGate();
    const heard = vi.fn();
    gate.subscribe(heard);

    const held = gate.filter(model, preparations.prepareRow, SOURCES);
    expect(keysOf(held.window.viewportRows)).toEqual(
      [0, 1, 3, 4, 5].map((index) => transcriptFixtureEventId(index)),
    );
    expect(held.window.rows.map((row) => row.id)).not.toContain(heldRowId);
    expect(keysOf(held.preparingRows)).toEqual([heldRowId]);
    // The held row joins right after the listed row it follows.
    expect(gate.isHeldOut(heldRowId)).toBe(true);
    expect(gate.holdsRowAfter(transcriptFixtureEventId(1))).toBe(true);
    expect(gate.holdsRowAfter(transcriptFixtureEventId(3))).toBe(false);
    // Nothing changed, so the pass is the same one.
    expect(gate.filter(model, preparations.prepareRow, SOURCES)).toBe(held);
    // A held row waits on the work it had when it arrived; only listed rows read their text again.
    gate.refresh();
    expect(preparations.refreshedRowIds).toEqual(
      [0, 1, 3, 4, 5].map((index) => transcriptFixtureEventId(index)),
    );

    preparations.landByRowId.get(heldRowId)?.();
    expect(heard).toHaveBeenCalledTimes(1);
    const listed = gate.filter(model, preparations.prepareRow, SOURCES);
    expect(keysOf(listed.window.viewportRows)).toEqual(keysOf(model.viewportRows));
    expect(listed.preparingRows).toEqual([]);
    expect(gate.isHeldOut(heldRowId)).toBe(false);
    expect(gate.holdsRowAfter(transcriptFixtureEventId(1))).toBe(false);
    // A listed row keeps its preparation, to be refreshed as its text grows.
    expect(preparations.releasedRowIds).toEqual([]);
    // A listed row whose newly settled work is out stays listed and is not prepared; its work
    // landing is news to a landing waiting on it, never to the list.
    const listedRowId = transcriptFixtureEventId(0);
    const workHeard = vi.fn();
    gate.subscribeToWork(workHeard);
    preparations.startWorkByRowId.get(listedRowId)?.();
    expect(gate.isPrepared(listedRowId)).toBe(false);
    preparations.landByRowId.get(listedRowId)?.();
    expect(gate.isPrepared(listedRowId)).toBe(true);
    expect(workHeard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("holds a page read back above the list with its last held row, so that row joins at the head", () => {
    const gate = new PreparedRowGate();
    const tail = deriveTranscriptWindow(openPagedSessionStore(6, 9).snapshot().transcript);
    const heldRowId = transcriptFixtureEventId(2);
    const preparations = new HeldPreparations([heldRowId]);
    gate.filter(tail, preparations.prepareRow, SOURCES);

    // The page of rows 0 to 5 arrives above the listed rows; row 2 still waits on its work.
    const withPage = deriveTranscriptWindow(openPagedSessionStore(0, 9).snapshot().transcript);
    const held = gate.filter(withPage, preparations.prepareRow, SOURCES);
    expect(keysOf(held.preparingRows)).toEqual(
      [0, 1, 2].map((index) => transcriptFixtureEventId(index)),
    );
    expect(keysOf(held.window.viewportRows)).toEqual(
      [3, 4, 5, 6, 7, 8, 9].map((index) => transcriptFixtureEventId(index)),
    );
    expect(gate.holdsRowAfter(undefined)).toBe(true);

    preparations.landByRowId.get(heldRowId)?.();
    const listed = gate.filter(withPage, preparations.prepareRow, SOURCES);
    expect(keysOf(listed.window.viewportRows)).toEqual(keysOf(withPage.viewportRows));
  });

  it("withdraws a row's preparation when the window lets the row go, and keeps the rest", () => {
    const store = openPagedSessionStore(0, 5);
    const model = deriveTranscriptWindow(store.snapshot().transcript);
    const heldRowId = transcriptFixtureEventId(1);
    const preparations = new HeldPreparations([heldRowId]);
    const gate = new PreparedRowGate();
    gate.filter(model, preparations.prepareRow, SOURCES);
    expect(preparations.releasedRowIds).toEqual([]);

    // The window lets its first two rows go; the rest are the same row objects.
    const later = gate.filter(
      { ...model, viewportRows: model.viewportRows.slice(2), rows: model.rows.slice(2) },
      preparations.prepareRow,
      SOURCES,
    );
    expect(preparations.releasedRowIds).toEqual([transcriptFixtureEventId(0), heldRowId]);
    expect(later.preparingRows).toEqual([]);
  });

  it("keeps a held page's events through a prune that lets the window's head go", () => {
    // A jump read the page of rows 0 to 2, which waits on a diagram, while the window still holds
    // rows 6 to 9 and lets rows 3 to 5 go above the reader.
    const store = openPagedSessionStore(0, 9);
    const unfurledWindow = deriveTranscriptWindow(store.snapshot().transcript);
    const heldPage = [0, 1, 2].map((index) => transcriptFixtureEventId(index));
    const prepared = new PreparedRowGate().filter(
      unfurledWindow,
      new HeldPreparations(heldPage).prepareRow,
      SOURCES,
    );
    const prune: PruneOutcome = {
      applied: true,
      deferredBecause: undefined,
      owedBecause: undefined,
      prunedKeys: [3, 4, 5].map((index) => transcriptFixtureEventId(index)),
      prunedAboveKeys: [3, 4, 5].map((index) => transcriptFixtureEventId(index)),
    };
    // The hook reads only the rows the window holds and its last prune.
    const snapshot = {
      rows: prepared.window.viewportRows.slice(3),
      lastPrune: prune,
    } as unknown as ViewportSnapshot;

    renderHook(() => {
      useReleaseOutsideWindow({
        history: {} as TranscriptHistory,
        sessionStore: store,
        snapshot,
        unfurledWindow,
        transcriptWindow: prepared.window,
        preparingRows: prepared.preparingRows,
      });
    });

    expect(store.snapshot().transcript.map((event) => event.id)).toEqual(
      expect.arrayContaining(heldPage),
    );
  });
});
