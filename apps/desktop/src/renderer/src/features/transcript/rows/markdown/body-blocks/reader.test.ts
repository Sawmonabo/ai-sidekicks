// A body whose cut failed: it fails on every read until the worker has started again, then asks for
// the cut once more. A cut recorded a few blocks a slice records exactly the blocks one pass does,
// is asked for once while it records, and draws nothing until every block is recorded; closed
// part-way, it forgets what it recorded and records the same blocks when asked for again.

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { PageParser } from "#renderer/components/Markdown/parse/page-parser.js";
import { loadMarkdownParserCalls } from "#renderer/components/Markdown/parse/parser-calls.js";
import { MarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import {
  MarkdownWorkerConnection,
  type MarkdownWorkerPort,
} from "#renderer/components/Markdown/worker/connection.js";
import {
  InThreadMarkdownWorkers,
  inThreadMarkdownWorker,
} from "#renderer/components/Markdown/worker/connection.test-support.js";
import { appTextCompression } from "#renderer/lib/text/compression.js";
import { publishedTextOf } from "#renderer/lib/text/published.js";
import type { BlockRecords } from "../block-records.js";
import type { MarkdownBodyBlocks } from "./reader.js";
import { bodyBlocksForTest } from "./reader.test-support.js";

/** How many blocks the slice a cut lands in records; every slice ends after this many. */
const slice = vi.hoisted(() => ({ blockCount: Number.POSITIVE_INFINITY }));

vi.mock("#renderer/lib/work-slices.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#renderer/lib/work-slices.js")>()),
  startSlice: () => blockSlice(slice.blockCount),
}));

/** A slice that answers it has time for `blockCount` blocks: one more after each of the first. */
function blockSlice(blockCount: number): () => boolean {
  let left = blockCount;
  return () => (left -= 1) > 0;
}

/**
 * Headings, paragraphs referencing footnotes and links, their definitions, fences, formulas and
 * tables, so every flag and kind of reference is recorded.
 */
const REPLY = `${Array.from({ length: 30 }, (_, index) => {
  const part = String(index);
  return [
    `## Part ${part}`,
    `A note[^${part}], [a link][l${part}] and $x_${part}$.`,
    `[^${part}]: The note on part ${part}.`,
    `[l${part}]: https://example.org/${part}`,
    `\`\`\`ts\nconst part = ${part};\n\`\`\``,
    `| a | b |\n| - | - |\n| ${part} | 2 |`,
  ].join("\n\n");
}).join("\n\n")}\n`;

/** Everything the records hold of each block, one pass's worth. */
function recordsOf(records: BlockRecords): unknown[] {
  return Array.from({ length: records.count }, (_, index) => ({
    start: records.startOf(index),
    end: records.endOf(index),
    key: records.reactKeyAt(index),
    flags: records.flagsAt(index),
    lines: [...records.lineLengthsOf(index)],
    references: [...records.referenceKeysOf(index)],
  }));
}

/** Records `blocks`' landed cut two blocks a slice, answering how many slices it took. */
function recordInSlices(blocks: MarkdownBodyBlocks): number {
  let sliceCount = 0;
  while (!blocks.recordCut(blockSlice(2))) {
    sliceCount += 1;
  }
  return sliceCount + 1;
}

describe("a body whose cut failed", () => {
  it("fails until the worker has started again, then cuts its text again", () => {
    const workers = new InThreadMarkdownWorkers();
    let canStart = false;
    const startWorker = (): MarkdownWorkerPort => {
      if (!canStart) {
        throw new Error("no worker");
      }
      return workers.start();
    };
    // A page parser that failed leaves every cut to the worker.
    const pageParser = new PageParser(loadMarkdownParserCalls);
    pageParser.fail();
    const trees = new MarkdownTrees(
      new MarkdownWorkerConnection(startWorker, window, pageParser, appTextCompression),
    );
    const blocks = bodyBlocksForTest(trees);
    const text = publishedTextOf("first paragraph\n\nsecond paragraph\n");

    blocks.read(text, true);
    blocks.requestReads();
    expect(() => blocks.read(text, true)).toThrow("could not start");
    expect(() => blocks.read(text, true)).toThrow("could not start");

    canStart = true;
    trees.wakeWorker();
    blocks.read(text, true);
    blocks.requestReads();

    expect(blocks.read(text, true).records.count).toBe(2);
  });
});

describe("a cut recorded a slice at a time", () => {
  it("records the blocks one pass does, asked for once, and draws once all are", () => {
    const trees = new MarkdownTrees(inThreadMarkdownWorker(window));
    const text = publishedTextOf(REPLY);
    const onePass = bodyBlocksForTest(trees);
    onePass.read(text, true);
    onePass.requestReads();
    const whole = onePass.read(text, true);
    expect(whole.isDrawn).toBe(true);
    expect(whole.records.count).toBeGreaterThan(100);

    const cuts = vi.spyOn(trees, "requestCut");
    slice.blockCount = 3;
    onTestFinished(() => {
      slice.blockCount = Number.POSITIVE_INFINITY;
    });
    const sliced = bodyBlocksForTest(trees);
    sliced.read(text, true);
    sliced.requestReads();
    expect(sliced.isRecordingCut).toBe(true);
    expect(sliced.read(text, true).records.count).toBe(3);
    expect(sliced.read(text, true).isDrawn).toBe(false);
    sliced.requestReads();
    expect(cuts).toHaveBeenCalledTimes(1);

    expect(recordInSlices(sliced)).toBeGreaterThan(50);
    const drawn = sliced.read(text, true);
    expect(drawn.isDrawn).toBe(true);
    expect(drawn.settledCount).toBe(whole.settledCount);
    expect(drawn.definingBlocks).toStrictEqual(whole.definingBlocks);
    expect(recordsOf(drawn.records)).toStrictEqual(recordsOf(whole.records));

    // Closed part-way, it forgets the blocks it recorded and asks for the same cut again.
    const closed = bodyBlocksForTest(trees);
    closed.read(text, true);
    closed.requestReads();
    closed.close();
    expect(closed.isRecordingCut).toBe(false);
    expect(closed.read(text, true).records.count).toBe(0);
    slice.blockCount = Number.POSITIVE_INFINITY;
    closed.requestReads();
    expect(cuts).toHaveBeenCalledTimes(3);
    expect(recordsOf(closed.read(text, true).records)).toStrictEqual(recordsOf(whole.records));
  });
});
