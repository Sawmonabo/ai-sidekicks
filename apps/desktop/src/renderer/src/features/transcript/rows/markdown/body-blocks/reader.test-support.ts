// A body's block reader as its row's preparation holds it, for a test that draws a body outside
// a feed.

import { onTestFinished } from "vitest";

import { appMarkdownTrees, type MarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import { MarkdownBodyBlocks } from "./reader.js";

/**
 * A block reader over `trees` for one body, closed once the test finishes, as a row's preparation
 * closes its own when the window lets the row go.
 */
export function bodyBlocksForTest(trees: MarkdownTrees = appMarkdownTrees): MarkdownBodyBlocks {
  const bodyBlocks = new MarkdownBodyBlocks(trees);
  onTestFinished(() => {
    bodyBlocks.close();
  });
  return bodyBlocks;
}
