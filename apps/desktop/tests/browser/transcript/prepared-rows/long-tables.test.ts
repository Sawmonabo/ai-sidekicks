// A reply read back holding a long table joins the list drawing its window from its first frame,
// laid out as it was measured off the list, and no painted frame shows it over the row below. The
// file's first case runs while the app's markdown worker has not yet loaded its parser, as at the
// app's start or after the worker's idle stop: every row, the opening ones too, joins only once
// its parse lands, so the list starts empty. A listed reply whose large body is opened keeps
// drawing as it stood until the body it read draws whole.

import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiagramPictures } from "#renderer/components/Markdown/diagram/pictures.js";
import { startDiagramWorker } from "#renderer/components/Markdown/diagram/worker/connection.js";
import { transcriptFixtureEventId } from "#renderer/features/transcript/logs.test-support.js";
import { type TranscriptBodyRead } from "#renderer/services/daemon/transcript/body.js";
import { letFramesPass, nextFrame } from "#test/helpers/animation-frame.js";
import { endWorkersWithTest } from "#test/helpers/worker-start.js";
import {
  SAME_LENGTH_TOLERANCE_PX,
  benchTable,
  headWidthsOf,
  replyWith,
} from "../windowed/long-table.js";
import { ROW_SELECTOR } from "../long-tool-feed.js";
import {
  CASE_TIMEOUT_MS,
  PICTURE_CACHE_BYTE_CAP,
  PaintedOverlapRecorder,
  SAMPLE_FRAME_SELECTOR,
  SETTLING_PARAGRAPHS,
  WholeRowRecorder,
  formulaAndDiagramReply,
  heldHistoryRead,
  holdImageDecodes,
  mountFeed,
} from "./feed.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A reply in the first page read back holding a long table, prose after it settling its block. */
const LONG_TABLE_INDEX = 33;
/** A reply in the first page read back whose body is too large to travel with it. */
const LARGE_BODY_INDEX = 34;
const LONG_TABLE_ROW_COUNT = 300;
/**
 * A cell only the table's last rows hold: drawn in a sample of its widest rows, never on screen.
 */
const SAMPLE_ONLY_TEXT = "読者位置表";

/**
 * Selects the whole page at each change that leaves a sample frame holding `SAMPLE_ONLY_TEXT` in
 * it, and records each selection that took the sample's copy of it.
 */
class SampleSelectionRecorder {
  readonly leaks: string[] = [];
  sampledCount = 0;
  readonly #observer: MutationObserver;

  public constructor() {
    this.#observer = new MutationObserver(() => {
      const frames = document.querySelectorAll(SAMPLE_FRAME_SELECTOR);
      if (![...frames].some((frame) => frame.textContent.includes(SAMPLE_ONLY_TEXT))) {
        return;
      }
      this.sampledCount += 1;
      const selection = document.getSelection() ?? expect.fail("a selection");
      selection.selectAllChildren(document.body);
      const selectedCount = selection.toString().split(SAMPLE_ONLY_TEXT).length - 1;
      selection.removeAllRanges();
      // A row the reader's selection reaches is drawn for real, and is the only copy it may take.
      const drawnCount = [...document.querySelectorAll("td")].filter(
        (cell) =>
          cell.closest(SAMPLE_FRAME_SELECTOR) === null &&
          cell.textContent.includes(SAMPLE_ONLY_TEXT),
      ).length;
      if (selectedCount > drawnCount) {
        const where = [...frames]
          .map((frame) =>
            frame.closest(".meridian-measuring-frames") === null ? "on screen" : "off the list",
          )
          .join(", ");
        this.leaks.push(`a selection of the page took a sample row drawn ${where}`);
      }
    });
    this.#observer.observe(document.body, { subtree: true, childList: true });
  }

  public stop(): void {
    this.#observer.disconnect();
  }
}

describe("a reply read back holding a long table", () => {
  it(
    "joins the list drawing its window from the first frame, laid out as measured on screen",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const pictures = new DiagramPictures(
        PICTURE_CACHE_BYTE_CAP,
        endWorkersWithTest(startDiagramWorker),
        () => undefined,
      );
      const history = heldHistoryRead(
        new Map([
          [
            LONG_TABLE_INDEX,
            `${replyWith(benchTable(LONG_TABLE_ROW_COUNT))}\n\n${SETTLING_PARAGRAPHS}`,
          ],
        ]),
      );
      const container = await mountFeed(history.read, pictures);
      await document.fonts.ready;
      const replyId = transcriptFixtureEventId(LONG_TABLE_INDEX);
      await waitFor(() => {
        expect(history.requests.length).toBeGreaterThan(0);
      });

      // The worker is still loading its parser, so no row is listed yet, the opening ones neither:
      // the recorders start before the list draws its first row.
      expect(container.querySelector(ROW_SELECTOR)).toBe(null);
      const selections = new SampleSelectionRecorder();
      const recorder = new WholeRowRecorder(container, [replyId]);
      const overlaps = new PaintedOverlapRecorder();
      await act(async () => {
        history.release();
        await nextFrame();
      });
      await waitFor(
        () => {
          expect(recorder.rowOf(replyId)?.querySelector("table[aria-rowcount]") ?? null).not.toBe(
            null,
          );
        },
        { timeout: CASE_TIMEOUT_MS / 2 },
      );
      await letFramesPass(2);
      recorder.stop();
      overlaps.stop();
      expect(recorder.halfMade).toEqual([]);
      expect(overlaps.overlaps).toEqual([]);

      // Measured again on screen, as after a font loads, the table keeps the same columns.
      const row = recorder.rowOf(replyId) ?? expect.fail("the reply is listed");
      const table =
        row.querySelector<HTMLTableElement>("table[aria-rowcount]") ??
        expect.fail("the listed reply draws no windowed table");
      const preparedWidths = headWidthsOf(table);
      act(() => {
        document.fonts.dispatchEvent(new Event("loadingdone"));
      });
      await waitFor(() => {
        expect(row.querySelector(SAMPLE_FRAME_SELECTOR)).not.toBe(null);
      });
      await waitFor(
        () => {
          expect(row.querySelector(SAMPLE_FRAME_SELECTOR)).toBe(null);
        },
        { timeout: CASE_TIMEOUT_MS / 2 },
      );
      await letFramesPass(1);
      selections.stop();
      const measuredWidths = headWidthsOf(table);
      expect(measuredWidths).toHaveLength(preparedWidths.length);
      for (const [column, widthPx] of measuredWidths.entries()) {
        expect(
          Math.abs(widthPx - (preparedWidths[column] ?? 0)),
          `column ${String(column)}: on screen ${String(widthPx)}, off the list ${String(preparedWidths[column])}`,
        ).toBeLessThanOrEqual(SAME_LENGTH_TOLERANCE_PX);
      }
      // Both the frame off the list and the one on screen were drawn, and neither was selected.
      expect(selections.sampledCount).toBeGreaterThan(1);
      expect(selections.leaks).toEqual([]);
    },
  );
});

describe("a listed reply whose large body is opened", () => {
  it(
    "draws as it stood, the read under way, until the body it read draws whole",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const pictures = new DiagramPictures(
        PICTURE_CACHE_BYTE_CAP,
        endWorkersWithTest(startDiagramWorker),
        () => undefined,
      );
      const largeBody =
        formulaAndDiagramReply("read") + replyWith(benchTable(LONG_TABLE_ROW_COUNT));
      const history = heldHistoryRead(new Map(), new Map([[LARGE_BODY_INDEX, largeBody]]));
      const replyId = transcriptFixtureEventId(LARGE_BODY_INDEX);
      const readBody: TranscriptBodyRead = async () => ({
        status: "served",
        value: { status: "available", body: largeBody },
      });
      const container = await mountFeed(history.read, pictures, readBody);
      await waitFor(() => {
        expect(history.requests.length).toBeGreaterThan(0);
      });
      await act(async () => {
        history.release();
        await nextFrame();
      });
      const control = await waitFor(
        () =>
          container.querySelector<HTMLButtonElement>(
            `[data-row-id="${replyId}"] .meridian-full-output`,
          ) ?? expect.fail("the reply offers its full output"),
        { timeout: CASE_TIMEOUT_MS / 2 },
      );

      const decodes = holdImageDecodes();
      const recorder = new WholeRowRecorder(container, [replyId]);
      await act(async () => {
        control.click();
        await nextFrame();
      });
      // The body is read and its picture drawn, but not decoded: the reply still stands as it was.
      await waitFor(
        () => {
          expect(decodes.heldCount()).toBeGreaterThan(0);
        },
        { timeout: CASE_TIMEOUT_MS / 2 },
      );
      await letFramesPass(2);
      expect(recorder.rowOf(replyId)?.textContent).toContain("Loading the full output…");
      decodes.release();
      await waitFor(
        () => {
          expect(
            recorder.rowOf(replyId)?.querySelector(".meridian-diagram__picture") ?? null,
          ).not.toBe(null);
        },
        { timeout: CASE_TIMEOUT_MS / 2 },
      );
      await letFramesPass(2);
      recorder.stop();

      expect(recorder.halfMade).toEqual([]);
      const row = recorder.rowOf(replyId) ?? expect.fail("the reply is listed");
      expect(row.querySelector(".meridian-math--display")).not.toBe(null);
      expect(row.querySelector("table[aria-rowcount]")).not.toBe(null);
      expect(row.querySelector(".meridian-full-output")).toBe(null);
    },
  );
});
