// A reply holding a finished formula and a diagram is drawn whole on the first frame it appears
// in, in the engine that lays the rows out and paints them. The feed reads a page of history whose
// replies already hold their text, and the diagram worker's answers are held back, so a reply is
// ready only once they land: until then it is not in the list, and the rows beside it are. A
// diagram that cannot be drawn lets its reply in as its failure. Each reply's body arrives on its
// row in the page read, as the daemon serves history, and the reply is prepared from it before it
// is listed. The pictures' decodes are held too, so a reply whose picture is drawn but not decoded
// is seen still out of the list. A session opening on calls whose colored output stands in the box
// is first shown with each output formatted where it stays.

import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CONTENT_PAYLOAD_PLAINTEXT_MAX } from "@ai-sidekicks/contracts/event/declared-variants";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import { DiagramPictures } from "#renderer/components/Markdown/diagram/pictures.js";
import {
  startDiagramWorker,
  type DiagramWorkerPort,
} from "#renderer/components/Markdown/diagram/worker/connection.js";
import type {
  DiagramWorkerReply,
  DiagramWorkerRequest,
} from "#renderer/components/Markdown/diagram/worker/messages.js";
import {
  openPagedSessionStore,
  pagedSessionEventAt,
  transcriptFixtureEventId,
} from "#renderer/features/transcript/logs.test-support.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { changeLayout, letFramesPass, nextFrame } from "#test/helpers/animation-frame.js";
import { ESCAPE, coloredOutputEventAt } from "../colored-output-event.js";
import { ROW_SELECTOR } from "../long-tool-feed.js";
import { PaintedFrameReader } from "../painted-frames.js";
import { readerScrollsTo } from "#test/helpers/transcript/reader-scroll.js";
import { endWorkersWithTest } from "#test/helpers/worker-start.js";
import {
  CASE_TIMEOUT_MS,
  LOG_ROW_COUNT,
  PICTURE_CACHE_BYTE_CAP,
  PaintedOverlapRecorder,
  SETTLING_PARAGRAPHS,
  WholeRowRecorder,
  formulaAndDiagramReply,
  heldHistoryRead,
  holdImageDecodes,
  mountFeed,
} from "./feed.js";

/** A reply in the first page read back, holding a formula and a diagram. */
const FORMULA_AND_DIAGRAM_INDEX = 30;
/** A reply in the same page whose diagram merman refuses. */
const REFUSED_DIAGRAM_INDEX = 32;
/** How long the diagram worker's answers are held back, under its own deadline. */
const ANSWER_DELAY_MS = 400;

const REFUSED_DIAGRAM_REPLY = `\`\`\`mermaid\nflowchart TD\n  A --> B\n  B --> [Fix it\n\`\`\`\n\n${SETTLING_PARAGRAPHS}`;

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The real diagram worker, its drawings' answers held back `delayMs`: the page and the worker
 * otherwise speak as they do in the app, labels measured and all.
 */
class DelayedDiagramWorker implements DiagramWorkerPort {
  public onmessage: ((event: MessageEvent<DiagramWorkerReply>) => void) | null = null;
  public onerror: ((event: ErrorEvent) => void) | null = null;
  public onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly #worker = startDiagramWorker();

  public constructor(delayMs: number) {
    this.#worker.onmessage = (event) => {
      const isDrawing = event.data.status === "settled" || event.data.status === "unmeasured";
      if (isDrawing) {
        setTimeout(() => this.onmessage?.(event), delayMs);
      } else {
        this.onmessage?.(event);
      }
    };
    this.#worker.onerror = (event) => this.onerror?.(event);
    this.#worker.onmessageerror = (event) => this.onmessageerror?.(event);
  }

  public postMessage(request: DiagramWorkerRequest): void {
    this.#worker.postMessage(request);
  }

  public terminate(): void {
    this.#worker.terminate();
  }
}

describe("a reply read back with a finished formula and diagram", () => {
  it(
    "joins the list only once drawn whole, its neighbors at once, a refused diagram as its failure",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const pictures = new DiagramPictures(
        PICTURE_CACHE_BYTE_CAP,
        endWorkersWithTest(() => new DelayedDiagramWorker(ANSWER_DELAY_MS)),
        () => undefined,
      );
      const history = heldHistoryRead(
        new Map([
          [FORMULA_AND_DIAGRAM_INDEX, formulaAndDiagramReply("store")],
          [REFUSED_DIAGRAM_INDEX, REFUSED_DIAGRAM_REPLY],
        ]),
      );
      const decodes = holdImageDecodes();
      const container = await mountFeed(history.read, pictures);
      const replyId = transcriptFixtureEventId(FORMULA_AND_DIAGRAM_INDEX);
      const refusedId = transcriptFixtureEventId(REFUSED_DIAGRAM_INDEX);
      const neighborId = transcriptFixtureEventId(FORMULA_AND_DIAGRAM_INDEX + 1);
      await waitFor(() => {
        expect(history.requests.length).toBeGreaterThan(0);
      });

      const recorder = new WholeRowRecorder(container, [replyId, refusedId, neighborId]);
      const releasedAtMs = performance.now();
      await act(async () => {
        history.release();
        await nextFrame();
      });
      // The reply's picture is drawn and decoding: the refused diagram's reply is in, it is not.
      await waitFor(
        () => {
          expect(decodes.heldCount()).toBeGreaterThan(0);
          expect(recorder.rowOf(refusedId)?.textContent).toContain("Could not draw this diagram");
        },
        { timeout: CASE_TIMEOUT_MS / 2 },
      );
      await letFramesPass(2);
      expect(recorder.rowOf(replyId)).toBe(null);
      decodes.release();
      await waitFor(
        () => {
          expect(recorder.rowOf(replyId)?.querySelector(".meridian-diagram__picture")).not.toBe(
            null,
          );
          expect(recorder.rowOf(refusedId)?.textContent).toContain("Could not draw this diagram");
        },
        { timeout: CASE_TIMEOUT_MS / 2 },
      );
      await letFramesPass(2);
      recorder.stop();

      expect(recorder.halfMade).toEqual([]);
      expect(recorder.rowOf(replyId)?.querySelector(".meridian-math--display")).not.toBe(null);
      // The neighbor waited on nothing, so it was listed before the reply's answers landed.
      const neighborSeenAt = recorder.firstSeenAtMs.get(neighborId) ?? expect.fail("drawn");
      const replySeenAt = recorder.firstSeenAtMs.get(replyId) ?? expect.fail("drawn");
      expect(neighborSeenAt).toBeLessThan(replySeenAt);
      expect(replySeenAt - releasedAtMs).toBeGreaterThanOrEqual(ANSWER_DELAY_MS);
    },
  );
});

/** Where each row on screen stands below the top of the box, by row id. */
function rowsOnScreen(scrollContainer: HTMLElement): Map<string, number> {
  const box = scrollContainer.getBoundingClientRect();
  const tops = new Map<string, number>();
  for (const row of scrollContainer.querySelectorAll<HTMLElement>("[data-row-id]")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > box.top && rect.top < box.bottom) {
      tops.set(row.dataset["rowId"] ?? "", rect.top - box.top);
    }
  }
  return tops;
}

describe("a held reply joining the list", () => {
  // The page read back holds rows 0 to 35; the reply at 30 waits on its picture, and the rows
  // above it wait with it, so the list starts at 31 until it joins at the head. No painted frame,
  // from the page's read to the join, shows one row over another.
  for (const placement of ["at the top of the box", "above the box"] as const) {
    it(
      `moves no row on screen when the list's head is ${placement}`,
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const pictures = new DiagramPictures(
          PICTURE_CACHE_BYTE_CAP,
          endWorkersWithTest(startDiagramWorker),
          () => undefined,
        );
        const history = heldHistoryRead(
          new Map([[FORMULA_AND_DIAGRAM_INDEX, formulaAndDiagramReply("store")]]),
        );
        const decodes = holdImageDecodes();
        const container = await mountFeed(history.read, pictures);
        const replyId = transcriptFixtureEventId(FORMULA_AND_DIAGRAM_INDEX);
        const neighborId = transcriptFixtureEventId(FORMULA_AND_DIAGRAM_INDEX + 1);
        const scrollContainer =
          container.querySelector<HTMLElement>(".meridian-transcript-viewport__scroll-container") ??
          expect.fail("the feed drew no scroll container");
        await waitFor(() => {
          expect(history.requests.length).toBeGreaterThan(0);
        });
        const overlaps = new PaintedOverlapRecorder();
        await act(async () => {
          history.release();
          await nextFrame();
        });
        await waitFor(
          () => {
            expect(decodes.heldCount()).toBeGreaterThan(0);
          },
          { timeout: CASE_TIMEOUT_MS / 2 },
        );
        // The reader scrolls up: to the top of the list, or two box heights short of it.
        await changeLayout(() => {
          readerScrollsTo(
            scrollContainer,
            placement === "at the top of the box" ? 0 : 2 * scrollContainer.clientHeight,
          );
        });
        const listedRowIds = [
          ...scrollContainer.querySelectorAll<HTMLElement>("[data-row-id]"),
        ].map((row) => row.dataset["rowId"]);
        expect(listedRowIds).not.toContain(replyId);
        expect(listedRowIds).not.toContain(transcriptFixtureEventId(FORMULA_AND_DIAGRAM_INDEX - 1));
        const before = rowsOnScreen(scrollContainer);
        expect(before.has(neighborId)).toBe(placement === "at the top of the box");

        decodes.release();
        await waitFor(
          () => {
            expect(
              container.querySelector(`[data-row-id="${replyId}"] .meridian-diagram__picture`),
            ).not.toBe(null);
          },
          { timeout: CASE_TIMEOUT_MS / 2 },
        );
        await letFramesPass(2);
        overlaps.stop();
        expect(overlaps.overlaps).toEqual([]);

        // Within a device pixel: the hold restores the row's place to the scroll offset's grain.
        const after = rowsOnScreen(scrollContainer);
        for (const [rowId, topPx] of before) {
          expect({
            rowId,
            isInPlace: Math.abs((after.get(rowId) ?? Infinity) - topPx) < 1,
          }).toEqual({
            rowId,
            isInPlace: true,
          });
        }
      },
    );
  }
});

/** The calls whose colored output stands in the box at the log's tail, by index, with lengths. */
const OPENING_OUTPUT_LENGTHS: ReadonlyMap<number, number> = new Map([
  [LOG_ROW_COUNT - 4, CONTENT_PAYLOAD_PLAINTEXT_MAX],
  [LOG_ROW_COUNT - 2, 60_000],
]);

/** A message at each log position, and a call's colored output at each `OPENING_OUTPUT_LENGTHS`. */
function openingEventAt(index: number): ProjectedSessionEvent {
  const length = OPENING_OUTPUT_LENGTHS.get(index);
  return length === undefined ? pagedSessionEventAt(index) : coloredOutputEventAt(index, length);
}

/** What one shown frame of the opening paints: where each row stands, and the outputs formatted. */
interface OpeningFrame {
  readonly rowTops: ReadonlyMap<string, number>;
  readonly formattedOutputIds: readonly string[];
}

/** The frame as painted, or `undefined` while the feed is still hidden. */
function readOpeningFrame(): OpeningFrame | undefined {
  const viewport = document.querySelector(".meridian-transcript-viewport");
  const scrollContainer = viewport?.querySelector<HTMLElement>(
    ".meridian-transcript-viewport__scroll-container",
  );
  if (
    viewport === null ||
    scrollContainer === null ||
    scrollContainer === undefined ||
    getComputedStyle(viewport).visibility !== "visible"
  ) {
    return undefined;
  }
  const rowTops = rowsOnScreen(scrollContainer);
  const formattedOutputIds = [...OPENING_OUTPUT_LENGTHS.keys()]
    .map((index) => transcriptFixtureEventId(index))
    .filter((rowId) => {
      const output = scrollContainer.querySelector(`[data-row-id="${rowId}"] .meridian-ansi__body`);
      return (
        rowTops.has(rowId) &&
        output !== null &&
        output.querySelector("span[class], span[style]") !== null &&
        !output.textContent.includes(ESCAPE)
      );
    });
  return { rowTops, formattedOutputIds };
}

describe("a session opening on command outputs", () => {
  it(
    "is first shown with each output in the box formatted where it stays",
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const painted: OpeningFrame[] = [];
      const frames = new PaintedFrameReader(ROW_SELECTOR, readOpeningFrame, (frame) => {
        if (frame !== undefined) {
          painted.push(frame);
        }
      });
      const pictures = new DiagramPictures(
        PICTURE_CACHE_BYTE_CAP,
        endWorkersWithTest(startDiagramWorker),
        () => undefined,
      );
      // The faces in first, as a session switched to finds them, so the rows show once committed.
      installMeridianTokens(document);
      await document.fonts.ready;
      await mountFeed(
        undefined,
        pictures,
        undefined,
        openPagedSessionStore(0, LOG_ROW_COUNT - 1, undefined, openingEventAt),
      );
      await waitFor(() => {
        expect(painted.length).toBeGreaterThan(0);
      });
      await letFramesPass(10);
      frames.stop();

      const outputIds = [...OPENING_OUTPUT_LENGTHS.keys()].map((index) =>
        transcriptFixtureEventId(index),
      );
      const [first] = painted;
      for (const frame of painted) {
        expect(frame.formattedOutputIds).toEqual(outputIds);
        expect([...frame.rowTops.keys()]).toEqual([...(first?.rowTops.keys() ?? [])]);
        for (const [rowId, topPx] of frame.rowTops) {
          expect({
            rowId,
            isInPlace: Math.abs((first?.rowTops.get(rowId) ?? Infinity) - topPx) < 1,
          }).toEqual({ rowId, isInPlace: true });
        }
      }
    },
  );
});
