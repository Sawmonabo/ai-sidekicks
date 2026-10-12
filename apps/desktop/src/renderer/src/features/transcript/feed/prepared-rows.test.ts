// The gate that lists a row only once it draws whole, over a real store's window: a held row stays
// out while the rows below it are listed, joins once its work lands, and its preparation is
// withdrawn when the window lets it go; a page read back above the list waits with its last held
// row; the store keeps a held page's events through a prune that lets the window's head go; and a
// listed command output parsing in slices draws only what is parsed, its last version while a
// changed one parses; and an output is parsed only while the viewport's band or a waiting landing
// reaches its row, which the band draws again only once it is whole, parsed at once in view, and
// the landing lands on only once it is whole.

import { renderHook } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { useReleaseOutsideWindow } from "../history/hooks/useReleaseOutsideWindow.js";
import { type TranscriptHistory } from "../history/hooks/useTranscriptHistory.js";
import {
  openPagedSessionStore,
  transcriptFixtureEventId,
  transcriptReadRowAt,
} from "../logs.test-support.js";
import { publishedTextOf } from "../reveal/published-text.js";
import { RevealTextRope } from "../reveal/text-rope.js";
import { AnsiLineChunks, chunkTextOf, type AnsiLineChunkList } from "../rows/ansi/lines/chunks.js";
import { PreparedBodies } from "../rows/prepared-bodies.js";
import { OffListTables } from "../rows/markdown/table-window/off-list.js";
import { prepareTranscriptRow } from "../rows/preparation.js";
import { type TranscriptRowPreparation, type TranscriptRowSources } from "../rows/renderer.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { SteppedTasks } from "#test/helpers/stepped-tasks.js";
import { TASKS_AT_ONCE } from "#test/helpers/tasks-at-once.js";
import { createCountingScrollContainer } from "#renderer/lib/scroll/container.test-support.js";
import { ViewportController } from "../viewport/controller.js";
import { CALM, NO_LINK } from "../viewport/controller.test-support.js";
import { type ViewportSnapshot } from "../viewport/snapshot.js";
import { type PruneOutcome } from "../viewport/window-cap.js";
import { deriveTranscriptWindow, type TranscriptWindowModel } from "../window/transcript-window.js";
import { PreparedRowGate, type FeedRowSources } from "./prepared-rows.js";

/** The gate never reads these: the stand-in preparation below decides every row itself. */
const SOURCES: FeedRowSources = {
  publishedTextFor: () => undefined,
  ownerWindow: window,
  diagramPictures: undefined,
  offListTables: new OffListTables(document, () => undefined),
  preparedBodies: new PreparedBodies(),
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
      isOutputReady: true,
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

/** Built from its code point: a raw control byte in source is invisible in a diff. */
const ESCAPE = String.fromCodePoint(0x1b);

/** A tool's result row, as the store's first row stands, with the stored body `body` if given. */
function toolRow(body?: string): TranscriptEventRow {
  const row = transcriptReadRowAt(0);
  return row.kind === "general"
    ? {
        ...row,
        type: "tool.result",
        ...(body === undefined ? {} : { content: { status: "available", body } }),
      }
    : expect.fail("the store's first row is a general row");
}

/** The store's window of its first row alone, standing as `row`. */
function windowOf(row: TranscriptEventRow): TranscriptWindowModel {
  const snapshot = openPagedSessionStore(0, 0).snapshot();
  const model = deriveTranscriptWindow(snapshot.transcript, snapshot.partitions.run);
  expect(keysOf(model.viewportRows)).toEqual([row.id]);
  return { ...model, rows: [row] };
}

/** `count` lines of a program's output, each in a color of its own, every seventh set bold. */
function coloredLines(first: number, count: number): string {
  return Array.from({ length: count }, (_unused, offset) => {
    const index = first + offset;
    const bold = index % 7 === 0 ? `${ESCAPE}[1m` : "";
    return `${ESCAPE}[3${String(index % 8)}m${bold}line ${String(index)} built${ESCAPE}[0m\n`;
  }).join("");
}

/** The text of every chunk, joined. */
function chunksTextOf(chunks: AnsiLineChunkList): string {
  return Array.from({ length: chunks.count }, (_unused, index) =>
    chunkTextOf(chunks.chunkAt(index)),
  ).join("");
}

describe("PreparedRowGate", () => {
  it("lists the rows below a held row at once, the held row once its work lands, and refreshes the listed", () => {
    const store = openPagedSessionStore(0, 5);
    const model = deriveTranscriptWindow(
      store.snapshot().transcript,
      store.snapshot().partitions.run,
    );
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
    const tailSnapshot = openPagedSessionStore(6, 9).snapshot();
    const tail = deriveTranscriptWindow(tailSnapshot.transcript, tailSnapshot.partitions.run);
    const heldRowId = transcriptFixtureEventId(2);
    const preparations = new HeldPreparations([heldRowId]);
    gate.filter(tail, preparations.prepareRow, SOURCES);

    // The page of rows 0 to 5 arrives above the listed rows; row 2 still waits on its work.
    const pagedSnapshot = openPagedSessionStore(0, 9).snapshot();
    const withPage = deriveTranscriptWindow(pagedSnapshot.transcript, pagedSnapshot.partitions.run);
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
    const model = deriveTranscriptWindow(
      store.snapshot().transcript,
      store.snapshot().partitions.run,
    );
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
    const unfurledWindow = deriveTranscriptWindow(
      store.snapshot().transcript,
      store.snapshot().partitions.run,
    );
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

    // The release runs in a task of its own, which happy-dom schedules none of.
    vi.stubGlobal("scheduler", TASKS_AT_ONCE.scheduler);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    renderHook(() => {
      useReleaseOutsideWindow({
        history: {} as TranscriptHistory,
        sessionStore: store,
        snapshot,
        unfurledWindow,
        transcriptWindow: prepared.window,
        preparingRows: prepared.preparingRows,
        callWindowOf: () => undefined,
      });
    });

    expect(store.snapshot().transcript.map((event) => event.id)).toEqual(
      expect.arrayContaining(heldPage),
    );

    // Without the held page the same prune lets the head go through the rows it cut.
    renderHook(() => {
      useReleaseOutsideWindow({
        history: {} as TranscriptHistory,
        sessionStore: store,
        snapshot,
        unfurledWindow,
        transcriptWindow: prepared.window,
        preparingRows: [],
        callWindowOf: () => undefined,
      });
    });
    expect(store.snapshot().transcript.map((event) => event.id)).toEqual(
      [6, 7, 8, 9].map((index) => transcriptFixtureEventId(index)),
    );
  });
});

describe("PreparedRowGate over a command output", () => {
  it("draws a listed output from its parse alone: each slice's lines as it grows, its last while a change parses", async () => {
    const tasks = new SteppedTasks();
    const preparedBodies = new PreparedBodies();
    let liveText: RevealTextRope | undefined = new RevealTextRope("call");
    const sources: FeedRowSources = {
      ...SOURCES,
      publishedTextFor: () => liveText,
      ownerWindow: tasks.window,
      preparedBodies,
    };
    const gate = new PreparedRowGate();
    const firstLines = coloredLines(0, 10);
    liveText.append(firstLines);
    liveText.advance(firstLines.length);
    const streamedRow = toolRow();
    const streamed = windowOf(streamedRow);
    // Its parse waits its turn, a task of its own.
    expect(gate.filter(streamed, prepareTranscriptRow, sources).window.rows).toEqual([]);
    expect(await tasks.runNext()).toBe(true);
    expect(gate.filter(streamed, prepareTranscriptRow, sources).window.rows).toEqual([streamedRow]);
    const streamedChunks = preparedBodies.chunksOf(streamedRow.id);
    expect(streamedChunks === undefined ? "" : chunksTextOf(streamedChunks)).not.toContain(ESCAPE);

    // Lines far past one slice arrive in one revision: the row stays listed, drawing each slice's
    // parse, every escape read as style, never the raw text.
    const grownLines = coloredLines(10, 60_000);
    liveText.append(grownLines);
    liveText.advance(grownLines.length);
    const whole = new AnsiLineChunks().read(publishedTextOf(firstLines + grownLines), () => true);
    const wholeText = chunksTextOf(whole.chunks);
    gate.refresh();
    let drawnLength = 0;
    let sliceCount = 1;
    for (;;) {
      expect(gate.filter(streamed, prepareTranscriptRow, sources).window.rows).toEqual([
        streamedRow,
      ]);
      const drawn = preparedBodies.chunksOf(streamedRow.id) ?? expect.fail("an output is drawn");
      const drawnText = chunksTextOf(drawn);
      expect(drawnText).not.toContain(ESCAPE);
      expect(wholeText.startsWith(drawnText)).toBe(true);
      expect(drawnText.length).toBeGreaterThan(drawnLength);
      drawnLength = drawnText.length;
      if (gate.isPrepared(streamedRow.id)) {
        break;
      }
      expect(await tasks.runNext()).toBe(true);
      sliceCount += 1;
    }
    expect(sliceCount).toBeGreaterThan(2);
    expect(drawnLength).toBe(wholeText.length);

    // The lane retires into the stored body, under a handle of its own: the row changed, so its
    // last version stays listed, drawing its last parse, until the new one is parsed whole.
    const drawnBefore = preparedBodies.chunksOf(streamedRow.id);
    liveText = undefined;
    const storedRow = toolRow(firstLines + grownLines);
    const stored = windowOf(storedRow);
    const heard = vi.fn();
    gate.subscribe(heard);
    expect(gate.filter(stored, prepareTranscriptRow, sources).window.rows).toEqual([streamedRow]);
    sliceCount = 1;
    while (heard.mock.calls.length === 0) {
      expect(preparedBodies.chunksOf(storedRow.id)).toBe(drawnBefore);
      expect(await tasks.runNext()).toBe(true);
      sliceCount += 1;
    }
    expect(sliceCount).toBeGreaterThan(2);
    expect(gate.filter(stored, prepareTranscriptRow, sources).window.rows).toEqual([storedRow]);
    const drawnAfter = preparedBodies.chunksOf(storedRow.id) ?? expect.fail("an output is drawn");
    expect(drawnAfter).not.toBe(drawnBefore);
    expect(chunksTextOf(drawnAfter)).toBe(wholeText);
  });

  it("parses an output only within the band's reach, and draws a row coming back once parsed whole", async () => {
    const feed = await openFortyRowFeed();
    const { controller, gate, preparedBodies } = feed;

    // The band at the head: the last row leaves its reach and lets its parse go.
    expect(feed.drawnRowKeysAt(0, 1)).not.toContain(FAR_ROW_ID);
    expect(preparedBodies.chunksOf(FAR_ROW_ID)).toBeUndefined();
    expect(gate.isPrepared(FAR_ROW_ID)).toBe(false);

    // Back at the tail, in view: the row is parsed again, whole in the walk that draws it.
    expect(feed.drawnRowKeysAt(38, 39)).toContain(FAR_ROW_ID);
    const drawn = preparedBodies.chunksOf(FAR_ROW_ID) ?? expect.fail("an output is drawn");
    expect(chunksTextOf(drawn)).toBe(feed.longOutputText);
    controller.dispose();
    gate.dispose();
  });

  it("draws a row rewritten while out of view whole in the walk that brings it into view", async () => {
    const tasks = new SteppedTasks();
    const preparedBodies = new PreparedBodies();
    const liveText = new RevealTextRope("call");
    const sources: FeedRowSources = {
      ...SOURCES,
      publishedTextFor: () => liveText,
      ownerWindow: tasks.window,
      preparedBodies,
    };
    const gate = new PreparedRowGate();
    const firstLines = coloredLines(0, 60_000);
    liveText.append(firstLines);
    liveText.advance(firstLines.length);
    const row = toolRow();
    const window = windowOf(row);
    // Within the band, out of view: parsed whole in turn, then listed.
    gate.filter(window, prepareTranscriptRow, sources);
    gate.observeReach(new Set([row.id]), new Set());
    while (!gate.isOutputParsed(row.id)) {
      expect(await tasks.runNext()).toBe(true);
    }
    expect(gate.filter(window, prepareTranscriptRow, sources).window.rows).toEqual([row]);

    // Rewritten from its start while still out of view: its parse starts again, in turn.
    const rewrittenLines = coloredLines(1, 60_000);
    liveText.rebase(rewrittenLines, 0);
    liveText.advance(rewrittenLines.length);
    gate.refresh();
    expect(gate.isOutputParsed(row.id)).toBe(false);

    // The walk that brings it into view parses it whole, so the row is drawn in that walk.
    gate.observeReach(new Set([row.id]), new Set([row.id]));
    expect(gate.isOutputParsed(row.id)).toBe(true);
    const drawn = preparedBodies.chunksOf(row.id) ?? expect.fail("an output is drawn");
    expect(chunksTextOf(drawn)).toBe(
      chunksTextOf(new AnsiLineChunks().read(publishedTextOf(rewrittenLines), () => true).chunks),
    );
    gate.dispose();
  });

  it("lands on a row outside the band's reach only once its output is parsed whole", async () => {
    const feed = await openFortyRowFeed();
    const { controller, gate, preparedBodies, tasks } = feed;
    expect(feed.drawnRowKeysAt(0, 1)).not.toContain(FAR_ROW_ID);
    expect(preparedBodies.chunksOf(FAR_ROW_ID)).toBeUndefined();

    // A find step onto the last row: the landing hands its screen over as within reach and waits
    // on the row's parse, moving nothing until it is whole.
    controller.landing.landOnRow(FAR_ROW_ID, "find-match");
    let sliceCount = 0;
    while (!controller.landing.isPending) {
      expect(gate.isPrepared(FAR_ROW_ID)).toBe(false);
      expect(await tasks.runNext()).toBe(true);
      sliceCount += 1;
    }
    expect(sliceCount).toBeGreaterThan(2);
    const drawn = preparedBodies.chunksOf(FAR_ROW_ID) ?? expect.fail("an output is drawn");
    expect(chunksTextOf(drawn)).toBe(feed.longOutputText);
    controller.dispose();
    gate.dispose();
  });
});

/** The last of forty rows, whose output takes many slices to parse. */
const FAR_ROW_ID = "row-39";

/**
 * Forty tool rows through a real gate, every output parsed as the feed opens, and a viewport over
 * them whose band a case walks at a range of its own.
 */
async function openFortyRowFeed(): Promise<{
  readonly gate: PreparedRowGate;
  readonly controller: ViewportController;
  readonly tasks: SteppedTasks;
  readonly preparedBodies: PreparedBodies;
  /** The whole parse of the last row's output, as its chunks' text. */
  readonly longOutputText: string;
  /** Walks the band over the rows from `startIndex` to `endIndex` in view: the rows it draws. */
  readonly drawnRowKeysAt: (startIndex: number, endIndex: number) => string[];
}> {
  const tasks = new SteppedTasks();
  const preparedBodies = new PreparedBodies();
  const sources: FeedRowSources = { ...SOURCES, ownerWindow: tasks.window, preparedBodies };
  const gate = new PreparedRowGate();
  const longOutput = coloredLines(0, 60_000);
  const rows = Array.from({ length: 40 }, (_unused, index) => ({
    ...toolRow(index === 39 ? longOutput : coloredLines(index, 3)),
    id: `row-${String(index)}`,
  }));
  const model: TranscriptWindowModel = {
    ...windowOf(toolRow()),
    rows,
    viewportRows: rows.map((row) => ({ key: row.id, parentKey: undefined, rootCursor: row.id })),
    rowsByKey: new Map(rows.map((row) => [row.id, row])),
  };
  // The feed opens at its tail, where every row is within reach until the band is walked.
  while (gate.filter(model, prepareTranscriptRow, sources).preparingRows.length > 0) {
    expect(await tasks.runNext()).toBe(true);
  }
  const controller = new ViewportController({
    clock: new ManualClock(),
    isRowPrepared: gate.isPrepared,
    isRowHeldOut: gate.isHeldOut,
    holdsRowAfter: gate.holdsRowAfter,
    subscribeToRowWork: gate.subscribeToWork,
    rowOutputs: gate,
  });
  controller.attach(createCountingScrollContainer({ clientHeight: 400, scrollHeight: 10_000 }));
  controller.reconcile({ rows: model.viewportRows, ...CALM }, NO_LINK);
  const options = controller.virtualizerOptions;
  return {
    gate,
    controller,
    tasks,
    preparedBodies,
    longOutputText: chunksTextOf(
      new AnsiLineChunks().read(publishedTextOf(longOutput), () => true).chunks,
    ),
    drawnRowKeysAt: (startIndex, endIndex) =>
      options
        .rangeExtractor({ startIndex, endIndex, overscan: 0, count: rows.length })
        .map((index) => options.getItemKey(index)),
  };
}
