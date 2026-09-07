// The queue's ordering rule, and nothing else.
//
// Split from `queue-feed.ts` because it is a second job: that module owns the
// SUBSCRIPTION — opening the tail, taking the snapshot, holding the refusals, and
// serving every watcher in the window — while this one owns what the two readings
// mean when they disagree about a row. The split is what lets the order rule be
// driven directly from a test with no bridge, no session, and no React at all,
// which is how its raced-row cases are written.

import type { QueueItemSummary } from "@ai-sidekicks/contracts";

import { compareInstants, parseInstant } from "../../core/index.js";

/**
 * The ordered fold, as a class so the order rule is one place rather than a
 * convention spread across three `setState` callbacks.
 */
export class QueueOrder {
  #itemsById = new Map<string, QueueItemSummary>();

  /**
   * Seat the snapshot. Its order becomes the list's order — and no row it carries
   * displaces a NEWER reading of that row.
   *
   * The two halves are one rule, and both are needed because the tail is opened
   * alongside the snapshot rather than after it. `run.queueList` answers a moment;
   * a tail emission that arrived while that answer was in flight describes a LATER
   * moment of the same row. Seating the snapshot by writing every row would then do
   * two wrong things at once: it would regress an `admitted` row back to the
   * `queued` the snapshot was taken at — permanently, since the daemon has no
   * reason to say it again — and it would leave the row at the position the tail
   * gave it rather than the canonical FIFO position the snapshot names, so a queue
   * of two would render reversed.
   *
   * So the order is REBUILT from the snapshot and each id takes the newer of the
   * two readings, compared on the registered `QueueItemSummary.updatedAt` — the
   * row's own monotonic member, wire-supplied, never arrival order, which says only
   * which message this process happened to receive first. A tie keeps the held row:
   * two readings of one instant are the same reading, and the held one is the later
   * observation. Ids the snapshot did not carry are appended after it, in the order
   * the tail delivered them.
   */
  public seat(items: readonly QueueItemSummary[]): void {
    const rebuilt = new Map<string, QueueItemSummary>();
    for (const snapshotRow of items) {
      const held = this.#itemsById.get(snapshotRow.id);
      rebuilt.set(
        snapshotRow.id,
        held !== undefined && !isStrictlyNewer(snapshotRow, held) ? held : snapshotRow,
      );
    }
    for (const [itemId, heldRow] of this.#itemsById) {
      if (!rebuilt.has(itemId)) {
        rebuilt.set(itemId, heldRow);
      }
    }
    this.#itemsById = rebuilt;
  }

  /**
   * Merge one live emission.
   *
   * An id already in the list keeps its POSITION and takes the new state; an id the
   * snapshot did not carry is appended. `Map.set` on an existing key preserves
   * insertion order, which is what makes the first half true without a second index.
   *
   * Last-writer-wins here and comparison only at `seat`, deliberately: the stream
   * is one ordered sequence of the daemon's own updates, so its newest delivery is
   * its newest reading. The snapshot is what arrives out of order, and it is the
   * only reading this fold has to rank.
   */
  public merge(item: QueueItemSummary): void {
    this.#itemsById.set(item.id, item);
  }

  public items(): readonly QueueItemSummary[] {
    return [...this.#itemsById.values()];
  }
}

/**
 * Whether one reading of a row is strictly newer than another.
 *
 * `updatedAt` is `z.iso.datetime({ offset: true })` on both sides, so both parse;
 * an unparseable value answers `false`, which keeps the held row — the fail-closed
 * direction, since the alternative is letting an unreadable stamp overwrite a
 * reading the console knows is real. Read through `parseInstant`, so an offset form
 * and a `Z` form naming the same moment compare as the same moment.
 */
function isStrictlyNewer(candidate: QueueItemSummary, held: QueueItemSummary): boolean {
  const candidateInstant = parseInstant(candidate.updatedAt);
  const heldInstant = parseInstant(held.updatedAt);
  if (candidateInstant.kind === "malformed" || heldInstant.kind === "malformed") {
    return false;
  }
  return compareInstants(candidateInstant, heldInstant, "newest-first") < 0;
}
