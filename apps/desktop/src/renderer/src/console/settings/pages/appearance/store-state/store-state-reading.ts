// What this window's durable store says about itself, and when it is asked again.
//
// Plan-023 §Target Areas states the obligation in terms: until the durable adapter
// ships, the console "runs on an in-memory adapter and reports that state in its own
// settings page". Nothing read it. A person choosing a colour scheme was told the
// choice is "remembered for the next start", which on the in-memory adapter is
// false — and the only way to find that out was to restart and see it gone.
//
// THIS IS A READ AND NOT A SUBSCRIPTION. `UiStateStore.health()` answers at one
// instant, refreshing the quota gauge as it goes, so it is wired to the two triggers
// that belong to the WINDOW: the mount, and the window regaining focus. Not the two
// session-scoped ones — the store is per window and no session's timeline says
// anything about how much room a disk has — and not a timer, which the console's
// budget forbids on a question nothing is asking on a person's behalf.
//
// THE STORE IS THE SUBJECT. The reading is held per store rather than per window, so
// a composition that replaced the store — an auxiliary window, a test moving between
// two — reads the new store's own answer on the first pass rather than the previous
// store's for one frame.

import { useMemo } from "react";

import { type ConsoleRefusal } from "../../../../core/index.js";
import { consoleRefusalFrom } from "../../../../seats/index.js";
import { type PersistenceHealth, type UiStateStore } from "../../../../persistence/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  useSubjectScopedState,
  useWindowReadTriggers,
  type ReadTriggerTarget,
} from "../../../../store/index.js";

/** Names a read that produced no answer at all, where the thrown value named none. */
const STORE_STATE_ORIGIN = "ui-state-store";

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

/** Ask the store how it is, at mount and whenever this window comes back. */
export function useStoreStateReading(uiStateStore: UiStateStore): StoreStateReading {
  const { value: reading, publish: publishReading } = useSubjectScopedState<StoreStateReading>(
    uiStateStore,
    undefined,
    () => ({ kind: "unread" }),
  );

  const readTarget = useMemo<ReadTriggerTarget>(
    () => ({
      // Empty, and the emptiness is the claim: this answer is the WINDOW's storage
      // and no session event bears on it.
      triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
      requestRead: () => {
        void uiStateStore.health().then(
          (health) => {
            publishReading({ kind: "read", health });
          },
          (rejection: unknown) => {
            publishReading({
              kind: "unreadable",
              refusal: consoleRefusalFrom(rejection, STORE_STATE_ORIGIN),
            });
          },
        );
      },
    }),
    [uiStateStore, publishReading],
  );
  useWindowReadTriggers(readTarget);

  return reading;
}

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
