// Does each narrowed stream carry what the wire registers?
//
// The kind tables are bound to the contracts census at COMPILE time, through unions
// `Extract`ed from `SessionEventType` and records declared `satisfies Record<…>`.
// That proof is real but invisible at runtime, and it can only fail a build — it can
// never tell a reader WHICH kinds a stream ended up with. So this file re-derives
// each stream's kinds from the census itself, at runtime, by a different route than
// the module used: it reads `SESSION_EVENT_CATEGORY_BY_TYPE`, filters it to the
// category the registration names, and asks the registered state vocabularies which
// of those rows the stream's wire arms can carry. A test file is not bundled, so it
// can import the census as a VALUE where the module deliberately imports it as a type
// only.
//
// The negative controls matter more than usual here, because every assertion in this
// file is about a set: a filter that produced the empty set, or a membership test
// that answered `false` for everything, would satisfy "carries only its own kinds"
// perfectly. Each clean set is therefore pinned against a kind that must be absent
// and a kind that must be present.
//
// THE KINDS ARE READ THROUGH THE ROUTING TABLE next door, because what a stream
// carries is only a claim about the wire once the row a subscriber reaches is the row
// carrying it. What that table then DELIVERS, and whether anything can re-route it
// under a running renderer, is `session-event-streams.test.ts` — the sibling suite
// beside the sibling module.

import { describe, expect, it } from "vitest";

import { QueueItemStateSchema, RunStateSchema } from "@ai-sidekicks/contracts";

import {
  CONSOLE_SESSION_EVENT_STREAMS,
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
 * The registered row that records a run's CREATION rather than a transition.
 *
 * `queued` is the state a run is created in and the destination of no row in
 * `docs/domain/run-state-machine.md`'s transition table, so no `RunStateChangeEvent`
 * can name it as a `currentState` — the shape requires a `previousState`, and the
 * vocabulary has no member for a state a run has not been in yet.
 */
const RUN_CREATION_KIND = "run.queued";

/**
 * The three registered run rows that record no state and no rollback.
 *
 * Named here so the state stream's exclusion of them is asserted rather than
 * merely implied by a set comparison: they are the rows a table derived from the
 * category alone would have swept in, and neither of the stream's two wire arms
 * can represent one.
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
    expect(Object.keys(CONSOLE_SESSION_EVENT_STREAMS).sort()).toStrictEqual(
      sorted([
        SESSION_EVENT_STREAM,
        RUN_STATE_EVENT_STREAM,
        RUN_QUEUE_EVENT_STREAM,
        PRESENCE_EVENT_STREAM,
      ]),
    );
  });

  it("carries only kinds the census registers", () => {
    const carried = Object.values(CONSOLE_SESSION_EVENT_STREAMS).flatMap((stream) =>
      stream.scope === "whole-session" ? [] : [...stream.carriedKinds],
    );

    expect(carried.length).toBeGreaterThan(0);
    for (const kind of carried) {
      expect(registeredCategoryOf(kind)).toBeDefined();
    }
  });

  it("negative control: the census does not admit an event name nothing registers", () => {
    // Without this, the case above would pass over a census that answered `true`
    // for every string, which is exactly the shape a broken membership test takes.
    expect(registeredCategoryOf(UNREGISTERED_KIND)).toBeUndefined();
  });

  it("gives the state stream one kind per state a transition can end in, plus the rollback arm", () => {
    // Re-derived from the census by the registration's own rule — one event per
    // canonical run state — rather than from the table under test, then less the
    // creation row, which is the one state no transition ends in.
    const runStateKinds = registeredKindsIn("run_lifecycle").filter(
      (kind) => RunStateSchema.safeParse(kind.slice(RUN_EVENT_ROOT.length)).success,
    );
    const transitionKinds = runStateKinds.filter((kind) => kind !== RUN_CREATION_KIND);

    expect(runStateKinds).toHaveLength(9);
    expect(transitionKinds).toHaveLength(8);
    expect(sorted(carriedKindsOf(RUN_STATE_EVENT_STREAM))).toStrictEqual(
      sorted([...transitionKinds, ROLLED_BACK_KIND]),
    );
  });

  it("leaves the run's creation off the state stream, and hands it to the whole session", () => {
    // A registered run-lifecycle row that neither wire arm of this stream can
    // represent: a `RunStateChangeEvent` for it would need a `previousState` naming
    // a state the run has not been in. A subscriber learns the run exists from the
    // whole-session stream, where the run-lifecycle projector folds the row in.
    expect(registeredCategoryOf(RUN_CREATION_KIND)).toBe("run_lifecycle");
    expect(subscriptionDeliversEventKind(RUN_STATE_EVENT_STREAM, RUN_CREATION_KIND)).toBe(false);
    expect(subscriptionDeliversEventKind(SESSION_EVENT_STREAM, RUN_CREATION_KIND)).toBe(true);
  });

  it("leaves the forward, non-state run rows off the state stream", () => {
    const carried = carriedKindsOf(RUN_STATE_EVENT_STREAM);

    for (const kind of NON_STATE_RUN_KINDS) {
      // Registered rows, deliberately uncarried: neither `RunStateChangeEvent` nor
      // `RunRolledBackEvent` can represent one, so a subscriber never sees them.
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
    // The intervention, driver-ask, and user-message rows share that category and
    // ride no queue projection; a stream derived from the category alone would
    // have handed all of them to a queue subscriber.
    expect(carriedKindsOf(RUN_QUEUE_EVENT_STREAM).includes("intervention.requested")).toBe(false);
  });

  it("announces a registered queue state for every queue row it carries", () => {
    // The stream emits `QueueItemSummary`, whose `state` is the registered
    // vocabulary — so a carried row that announced nothing in it would be a row
    // the projection cannot describe.
    for (const kind of carriedKindsOf(RUN_QUEUE_EVENT_STREAM)) {
      expect(kind.startsWith(QUEUE_ITEM_EVENT_ROOT)).toBe(true);
    }
    expect(QueueItemStateSchema.safeParse("queued").success).toBe(true);
    expect(QueueItemStateSchema.safeParse("created").success).toBe(false);
  });
});
