// How ranked results become the palette's categories.

import type { CommandSearchResult } from "@renderer/registries/commands/command-ranking.js";

/** Results for one category, in the order the best result in it appeared. */
export interface CommandResultGroup {
  readonly value: string;
  readonly items: readonly CommandSearchResult[];
}

/**
 * Groups ranked results by category in first-appearance order, so the best-ranked category leads
 * and categories do not reshuffle as a person types.
 */
export function groupResults(
  results: readonly CommandSearchResult[],
): readonly CommandResultGroup[] {
  const itemsByGroup = new Map<string, CommandSearchResult[]>();
  for (const result of results) {
    const bucket = itemsByGroup.get(result.command.group);
    if (bucket === undefined) {
      itemsByGroup.set(result.command.group, [result]);
    } else {
      bucket.push(result);
    }
  }
  return [...itemsByGroup.entries()].map(([value, items]) => ({ value, items }));
}
