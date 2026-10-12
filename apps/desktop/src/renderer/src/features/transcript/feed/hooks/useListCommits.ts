import { useLayoutEffect, useState } from "react";

/**
 * Tells the row gate each time a frame commits its list while the feed is not shown yet, and
 * renders the feed again when that list was newer than the last one noted, so its first frame
 * waits until the rows a new list puts in view are laid out and drawn.
 */
export function useListCommits(noteListCommitted: () => boolean, isShown: boolean): void {
  const [, setCommitCount] = useState(0);
  // After every commit, and after the viewport's own scroll write and measures in it.
  useLayoutEffect(() => {
    if (!isShown && noteListCommitted()) {
      setCommitCount((count) => count + 1);
    }
  });
}
