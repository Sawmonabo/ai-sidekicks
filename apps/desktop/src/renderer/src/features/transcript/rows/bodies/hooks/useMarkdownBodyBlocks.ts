import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";

import { appMarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import { type PublishedText } from "#renderer/features/transcript/reveal/published-text.js";
import { MarkdownBodyBlocks } from "../../markdown/body-blocks/reader.js";
import { type MarkdownBodyBlocksSnapshot } from "../../markdown/body-blocks/snapshot.js";

/**
 * One body's blocks for its published text, from the reader its row's preparation published, or,
 * where none is, one of its own that lives with the body. Memoized on the text's handle and
 * revision, and on each parse or cut the reader needed landing, so every derived identity holds
 * across renders nothing changed in, and no dependency holds the text itself. A parse the body
 * needed that failed throws, for the row's error boundary.
 */
export function useMarkdownBodyBlocks(
  publishedText: PublishedText,
  isComplete: boolean,
  publishedBlocks: MarkdownBodyBlocks | undefined,
): MarkdownBodyBlocksSnapshot {
  // A body handed its row's reader keeps one: it unmounts once the row withdraws it.
  const [ownBlocks] = useState(() =>
    publishedBlocks === undefined ? new MarkdownBodyBlocks(appMarkdownTrees) : undefined,
  );
  const bodyBlocks = publishedBlocks ?? ownBlocks;
  if (bodyBlocks === undefined) {
    throw new Error("A body's published blocks were withdrawn while it was drawn");
  }
  const revision = publishedText.revision;
  const landedRevision = useSyncExternalStore(bodyBlocks.subscribe, bodyBlocks.readRevision);
  const snapshot = useMemo(
    () => bodyBlocks.read(publishedText, isComplete),
    // The handle stays the same while a streaming text grows; its revision is what changed.
    [bodyBlocks, publishedText, revision, isComplete, landedRevision],
  );
  // Before paint, so the parses this frame waits on are asked for as soon as it is drawn.
  useLayoutEffect(() => {
    bodyBlocks.requestReads();
  }, [bodyBlocks, snapshot]);
  useEffect(
    () => () => {
      bodyBlocks.letPageTreesGo();
    },
    [bodyBlocks],
  );
  useEffect(
    () => () => {
      ownBlocks?.close();
    },
    [ownBlocks],
  );
  return snapshot;
}
