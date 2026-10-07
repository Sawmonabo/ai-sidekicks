import { useMemo, useState } from "react";

import { type PublishedText } from "#renderer/features/transcript/reveal/published-text.js";
import { MarkdownBodyBlocks, type MarkdownBodyBlocksSnapshot } from "../../markdown/body-blocks.js";
import { MarkdownBlockSegmenter } from "../../markdown/parse/block-segmenter.js";

/**
 * One body's blocks for its published text, from a segmenter and a block reading that both
 * survive the frame. Memoized on the text's handle and revision, so every derived identity holds
 * across renders the text did not change in, and no dependency holds the text itself.
 */
export function useMarkdownBodyBlocks(
  publishedText: PublishedText,
  isComplete: boolean,
): MarkdownBodyBlocksSnapshot {
  const [segmenter] = useState(() => new MarkdownBlockSegmenter());
  const [bodyBlocks] = useState(() => new MarkdownBodyBlocks());
  const revision = publishedText.revision;
  return useMemo(
    () => bodyBlocks.read(segmenter.segment(publishedText, { isFinal: isComplete })),
    // The handle stays the same while a streaming text grows; its revision is what changed.
    [bodyBlocks, segmenter, publishedText, revision, isComplete],
  );
}
