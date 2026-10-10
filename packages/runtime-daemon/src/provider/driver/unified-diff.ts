// Line counts of a unified diff, as a transcript patch row shows them.

/**
 * Counts the added and removed lines inside a unified diff's hunks only, so a removed line whose
 * own text starts with `--` reads `---` and is still a removal.
 */
export function countUnifiedDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let isInHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      isInHunk = true;
    } else if (isInHunk && line.startsWith("+")) {
      additions += 1;
    } else if (isInHunk && line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}
