import { useMemo, useState } from "react";

import { MarkdownBodyBlocks, type MarkdownBodyBlocksSnapshot } from "../../markdown/body-blocks.js";
import { MarkdownBlockSegmenter } from "../../markdown/parse/block-segmenter.js";

/**
 * One body's blocks for its published text, from a segmenter and a block reading that both
 * survive the frame. Memoized on the snapshot, so every derived identity holds across renders the
 * text did not change in.
 */
export function useMarkdownBodyBlocks(
  publishedText: string,
  isComplete: boolean,
): MarkdownBodyBlocksSnapshot {
  const [segmenter] = useState(() => new MarkdownBlockSegmenter());
  const [bodyBlocks] = useState(() => new MarkdownBodyBlocks());
  return useMemo(
    () => bodyBlocks.read(segmenter.segment(publishedText, { isFinal: isComplete })),
    [bodyBlocks, segmenter, publishedText, isComplete],
  );
}
