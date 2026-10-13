// A body's block reader as its row's preparation holds it, for a test that draws a body outside
// a feed.

import { onTestFinished } from "vitest";

import { appMarkdownTrees, type MarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import { WHOLE_SLICE } from "#renderer/lib/work-slices.js";
import { MarkdownBodyBlocks } from "./reader.js";

/**
 * A block reader over `trees` for one body, closed once the test finishes, as a row's preparation
 * closes its own when the window lets the row go. A landed cut the first slice left unrecorded is
 * recorded whole a microtask later, where a row's preparation records it in turn.
 */
export function bodyBlocksForTest(trees: MarkdownTrees = appMarkdownTrees): MarkdownBodyBlocks {
  const bodyBlocks = new MarkdownBodyBlocks(trees);
  const stopRecording = bodyBlocks.subscribe(() => {
    if (bodyBlocks.isRecordingCut) {
      queueMicrotask(() => {
        bodyBlocks.recordCut(WHOLE_SLICE);
      });
    }
  });
  onTestFinished(() => {
    stopRecording();
    bodyBlocks.close();
  });
  return bodyBlocks;
}
