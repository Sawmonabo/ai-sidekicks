// Reciprocal Rank Fusion: several ranked lists of the same items merged into one, each list
// adding 1/(60 + rank) for every item it ranks, with rank counted from one.

// The constant from the method's original paper, which keeps one list's top item from swamping
// an item every list ranks well.
const RANK_FUSION_OFFSET = 60;

/**
 * Merges ranked lists into one, best first: an item's score is the sum over the lists that rank
 * it of 1/(60 + its rank there). Ties keep the order of first appearance across the lists.
 */
export function fuseRankedLists<Item>(rankedLists: readonly (readonly Item[])[]): Item[] {
  const scores = new Map<Item, number>();
  for (const rankedList of rankedLists) {
    rankedList.forEach((item, index) => {
      scores.set(item, (scores.get(item) ?? 0) + 1 / (RANK_FUSION_OFFSET + index + 1));
    });
  }
  // Map iteration keeps insertion order, and the sort is stable, so ties keep first appearance.
  return [...scores.entries()].sort((left, right) => right[1] - left[1]).map(([item]) => item);
}
