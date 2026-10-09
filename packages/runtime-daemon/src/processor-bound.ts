// Work over many items that each wait mostly on another process or the disk, run as many at once
// as the machine has processors, so a long list neither runs one by one nor starts every process
// together.

import { availableParallelism } from "node:os";

import { settleAll } from "./settle-all.js";

/**
 * Maps every item through `map`, at most one per processor at a time, and resolves with the
 * results in the items' order. Every item settles before a failure is thrown, the one failure or
 * every distinct one in an `AggregateError`, so nothing still runs once the caller hears of it.
 */
export async function mapWithProcessorBound<Item, Result>(
  items: readonly Item[],
  map: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const outcomes = new Array<Promise<Result>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      const outcome = map(items[index]!);
      outcomes[index] = outcome;
      // A failure is read once every item has settled, below.
      await outcome.catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: availableParallelism() }, worker));
  return settleAll(outcomes, "the work bounded by the processors");
}
