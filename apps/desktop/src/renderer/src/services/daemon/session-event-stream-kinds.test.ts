// Checks that each narrowed stream carries what the wire registers, by re-deriving the kinds from
// the census at runtime (the module binds them at compile time only). Every assertion is about a
// set, so each one is pinned against a kind that must be absent and one that must be present; an
// empty filter result would otherwise pass. Kinds are read through the routing table in
// `session-event-streams.ts`, whose delivery is covered by `session-event-streams.test.ts`.

import { describe, expect, it } from "vitest";

import { QueueItemStateSchema, RunStateSchema } from "@ai-sidekicks/contracts";

import {
  SESSION_EVENT_STREAMS,
  PRESENCE_EVENT_STREAM,
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
  SESSION_EVENT_STREAM,
  subscriptionDeliversEventKind,
} from "./session-event-streams.js";
import {
  ROLLED_BACK_KIND,
  carriedKindsOf,
  registeredCategoryOf,
  registeredKindsIn,
  sorted,
} from "./session-event-streams.test-support.js";

/** The namespace root every run-lifecycle event type carries. */
const RUN_EVENT_ROOT = "run.";

/** The namespace root every queue row carries. */
const QUEUE_ITEM_EVENT_ROOT = "queue_item.";

/**
 * The registered row that records a run's creation rather than a transition. `queued` is the state
 * a run is created in, so no state-change event can name it as a `newState`.
 */
const RUN_CREATION_KIND = "run.queued";

/**
 * The three registered run rows that record no state and no rollback. Named so the state stream's
 * exclusion of them is asserted; neither wire arm can represent one.
 */
const NON_STATE_RUN_KINDS = [
  "run.provider_initialized",
  "run.turn_started",
  "run.worker_shutdown",
] as const;

/** An event name that reads like a registered type and is not one. */
const UNREGISTERED_KIND = "run.started";

describe("session-event streams — the table carries what the wire registers", () => {
  it("routes exactly the four registered subscriptions this console opens", () => {
    expect(Object.keys(SESSION_EVENT_STREAMS).sort()).toStrictEqual(
      sorted([
        SESSION_EVENT_STREAM,
        RUN_STATE_EVENT_STREAM,
        RUN_QUEUE_EVENT_STREAM,
        PRESENCE_EVENT_STREAM,
      ]),
    );
  });

  it("carries only kinds the census registers", () => {
    const carried = Object.values(SESSION_EVENT_STREAMS).flatMap((stream) =>
      stream.scope === "selected-kinds" ? [...stream.carriedKinds] : [],
    );

    expect(carried.length).toBeGreaterThan(0);
    for (const kind of carried) {
      expect(registeredCategoryOf(kind)).toBeDefined();
    }
  });

  it("negative control: the census does not admit an event name nothing registers", () => {
    // Without this, the case above would pass over a census that answered `true` for every string.
    expect(registeredCategoryOf(UNREGISTERED_KIND)).toBeUndefined();
  });

  it("gives the state stream one kind per state a transition can end in, plus the rollback arm", () => {
    // Re-derived from the census by the registration's rule (one event per run state), less the
    // creation row, which no transition ends in.
    const runStateKinds = registeredKindsIn("run_lifecycle").filter(
      (kind) => RunStateSchema.safeParse(kind.slice(RUN_EVENT_ROOT.length)).success,
    );
    const transitionKinds = runStateKinds.filter((kind) => kind !== RUN_CREATION_KIND);

    expect(transitionKinds.length).toBeGreaterThan(0);
    expect(sorted(carriedKindsOf(RUN_STATE_EVENT_STREAM))).toStrictEqual(
      sorted([...transitionKinds, ROLLED_BACK_KIND]),
    );
  });

  it("leaves the run's creation off the state stream, and hands it to the whole session", () => {
    // A creation event has no `previousState`, so the state stream cannot represent it; a
    // subscriber learns the run exists from the whole-session stream.
    expect(registeredCategoryOf(RUN_CREATION_KIND)).toBe("run_lifecycle");
    expect(subscriptionDeliversEventKind(RUN_STATE_EVENT_STREAM, RUN_CREATION_KIND)).toBe(false);
    expect(subscriptionDeliversEventKind(SESSION_EVENT_STREAM, RUN_CREATION_KIND)).toBe(true);
  });

  it("leaves the forward, non-state run rows off the state stream", () => {
    const carried = carriedKindsOf(RUN_STATE_EVENT_STREAM);

    for (const kind of NON_STATE_RUN_KINDS) {
      // Registered but deliberately uncarried: neither wire arm can represent one.
      expect(registeredCategoryOf(kind)).toBe("run_lifecycle");
      expect(carried.includes(kind)).toBe(false);
    }
  });

  it("gives the queue stream the registered queue rows and nothing else from their category", () => {
    const queueKinds = registeredKindsIn("interactive_request").filter((kind) =>
      kind.startsWith(QUEUE_ITEM_EVENT_ROOT),
    );

    expect(queueKinds).toHaveLength(5);
    expect(sorted(carriedKindsOf(RUN_QUEUE_EVENT_STREAM))).toStrictEqual(sorted(queueKinds));
    // The category also holds intervention, user-message and question rows; none is a queue
    // projection.
    expect(carriedKindsOf(RUN_QUEUE_EVENT_STREAM).includes("intervention.requested")).toBe(false);
  });

  it("announces a registered queue state for every queue row it carries", () => {
    // The stream emits `QueueItemSummary`, so every carried row must announce a registered state.
    for (const kind of carriedKindsOf(RUN_QUEUE_EVENT_STREAM)) {
      expect(kind.startsWith(QUEUE_ITEM_EVENT_ROOT)).toBe(true);
    }
    expect(QueueItemStateSchema.safeParse("queued").success).toBe(true);
    expect(QueueItemStateSchema.safeParse("created").success).toBe(false);
  });
});
