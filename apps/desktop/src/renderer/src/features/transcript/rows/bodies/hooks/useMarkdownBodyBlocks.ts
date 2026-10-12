import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";

import { appMarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import { type PublishedText } from "#renderer/features/transcript/reveal/published-text.js";
import { MarkdownBodyBlocks, type MarkdownBodyBlocksSnapshot } from "../../markdown/body-blocks.js";
import { MarkdownBlockSegmenter } from "../../markdown/parse/block-segmenter.js";

/**
 * One body's blocks for its published text, from a segmenter and a block reading that both
 * survive the frame. Memoized on the text's handle and revision, and on each parse the reading
 * needed landing, so every derived identity holds across renders nothing changed in, and no
 * dependency holds the text itself. A parse the body needed that failed throws, for the row's
 * error boundary.
 */
export function useMarkdownBodyBlocks(
  publishedText: PublishedText,
  isComplete: boolean,
): MarkdownBodyBlocksSnapshot {
  const [segmenter] = useState(() => new MarkdownBlockSegmenter());
  const [bodyBlocks] = useState(() => new MarkdownBodyBlocks(appMarkdownTrees));
  const revision = publishedText.revision;
  const segmentation = useMemo(
    () => segmenter.segment(publishedText, { isFinal: isComplete }),
    // The handle stays the same while a streaming text grows; its revision is what changed.
    [segmenter, publishedText, revision, isComplete],
  );
  const landedRevision = useSyncExternalStore(bodyBlocks.subscribe, bodyBlocks.readRevision);
  const snapshot = useMemo(
    () => bodyBlocks.read(segmentation),
    [bodyBlocks, segmentation, landedRevision],
  );
  // Before paint, so the parses this frame waits on are asked for as soon as it is drawn.
  useLayoutEffect(() => {
    bodyBlocks.requestReads();
  }, [bodyBlocks, snapshot]);
  useEffect(
    () => () => {
      bodyBlocks.close();
    },
    [bodyBlocks],
  );
  return snapshot;
}
