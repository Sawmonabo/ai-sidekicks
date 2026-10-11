// The queue's ordering rule: rows stand in their `position` order, lowest first, and a snapshot
// and the live tail that disagree about a row keep the newer reading. Kept apart from the
// subscription so it can be tested with no bridge, session or React.

import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";

import { compareInstants, parseInstant } from "#renderer/lib/instant.js";

/** The ordered fold of queue rows; the order rule lives here and nowhere else. */
export class QueueOrder {
  #itemsById = new Map<string, QueueItemSummary>();

  /**
   * Install the snapshot, each id keeping the newer of the two readings. The tail opens
   * alongside the snapshot, so it can hold a later state of a row than the snapshot does;
   * writing every snapshot row would regress `admitted` to `queued` for good. Newer means the
   * wire `updatedAt`, never arrival order; a tie keeps the held row, and ids the snapshot lacks
   * are kept.
   */
  public replaceWithSnapshot(items: readonly QueueItemSummary[]): void {
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
   * Merge one live change: the row as it now stands, its state and its position. Last writer
   * wins because the stream is the daemon's own ordered sequence; only the snapshot arrives out
   * of order.
   */
  public merge(item: QueueItemSummary): void {
    this.#itemsById.set(item.id, item);
  }

  /** The rows by `position`, lowest first; rows that share one keep the order they were folded. */
  public items(): readonly QueueItemSummary[] {
    return [...this.#itemsById.values()].sort((first, second) => first.position - second.position);
  }
}

/**
 * Whether `candidate` is strictly newer than `held`. An unparseable stamp answers `false`, which
 * keeps the held row rather than letting an unreadable stamp overwrite a real reading.
 */
function isStrictlyNewer(candidate: QueueItemSummary, held: QueueItemSummary): boolean {
  const candidateInstant = parseInstant(candidate.updatedAt);
  const heldInstant = parseInstant(held.updatedAt);
  if (candidateInstant.kind === "malformed" || heldInstant.kind === "malformed") {
    return false;
  }
  return compareInstants(candidateInstant, heldInstant, "newest-first") < 0;
}
