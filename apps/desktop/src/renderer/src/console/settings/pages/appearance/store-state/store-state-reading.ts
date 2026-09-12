// What this window's durable store says about itself, as a reading a block can draw.
//
// Until the durable adapter ships, the console runs on an in-memory adapter and owes
// a report of that state in its own settings page. Nothing read it. A person choosing
// a colour scheme was told the
// choice is "remembered for the next start", which on the in-memory adapter is
// false — and the only way to find that out was to restart and see it gone.
//
// WHAT THIS FILE IS AND WHAT IT IS NOT. It is the reading's VOCABULARY: the three
// things the block can be looking at, and the incidents worth drawing from one of
// them. How a reading is TAKEN — the schedule that decides what a burst of triggers
// costs, and the round that decides which answer installs — is `store-state-read.ts`
// beside it. They were one file, and the split is the reason the read stopped racing
// itself: a module that also held the union had no obvious place to put a scheduler,
// so each trigger called the store directly.

import type { ConsoleRefusal } from "../../../../core/index.js";
import { type PersistenceHealth } from "../../../../persistence/index.js";

/**
 * The three things this block can be looking at.
 *
 * `unread` is the pass before the first answer lands and is a real state rather than
 * an empty reading — the block says the question is out rather than drawing a store
 * whose adapter it does not know. `unreadable` carries the throw, because a store
 * that cannot describe itself is exactly the state a person on a broken adapter is
 * in, and reporting it as "in memory" would be a guess wearing an answer's clothes.
 */
export type StoreStateReading =
  | { readonly kind: "unread" }
  | { readonly kind: "read"; readonly health: PersistenceHealth }
  | { readonly kind: "unreadable"; readonly refusal: ConsoleRefusal };

/** One counted thing that has gone wrong, and the sentence naming it. */
export interface StoreIncident {
  readonly label: string;
  readonly count: number;
}

/**
 * The incidents worth showing, which is the ones that happened.
 *
 * A zero is not rendered, and that is the density decision: three rows reading "0"
 * are three claims a person has to read to learn nothing, and the block's job is to
 * say whether this window's memory is trustworthy. The refusal CODES are carried
 * verbatim — the store's own vocabulary, never reworded here, so what is on screen
 * is what an author would grep for.
 */
export function incidentsOf(health: PersistenceHealth): readonly StoreIncident[] {
  const incidents: StoreIncident[] = [];
  for (const [code, count] of Object.entries(health.refusalCounts)) {
    if (count > 0) {
      incidents.push({ label: code, count });
    }
  }
  if (health.failedReadCount > 0) {
    incidents.push({ label: "reads that failed", count: health.failedReadCount });
  }
  if (health.trimCount > 0) {
    incidents.push({ label: "sessions dropped to make room", count: health.trimCount });
  }
  return incidents;
}
