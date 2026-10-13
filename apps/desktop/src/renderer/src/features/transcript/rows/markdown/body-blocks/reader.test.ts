// A body whose cut failed: it fails on every read until the worker has started again, then asks for
// the cut once more.

import { describe, expect, it } from "vitest";

import { PageParser } from "#renderer/components/Markdown/parse/page-parser.js";
import { loadMarkdownParserCalls } from "#renderer/components/Markdown/parse/parser-calls.js";
import { MarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import {
  MarkdownWorkerConnection,
  type MarkdownWorkerPort,
} from "#renderer/components/Markdown/worker/connection.js";
import { InThreadMarkdownWorkers } from "#renderer/components/Markdown/worker/connection.test-support.js";
import { appTextCompression } from "#renderer/lib/text/compression.js";
import { publishedTextOf } from "#renderer/lib/text/published.js";
import { bodyBlocksForTest } from "./reader.test-support.js";

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
