// Does the stream table carry what the wire registers, and route what it carries?
//
// The table's kinds are bound to the contracts census at COMPILE time, through
// unions `Extract`ed from `SessionEventType` and records declared `satisfies
// Record<…>`. That proof is real but invisible at runtime, and it can only fail a
// build — it can never tell a reader WHICH kinds a stream ended up with. So this
// file re-derives each stream's kinds from the census itself, at runtime, by a
// different route than the module used: it reads
// `SESSION_EVENT_CATEGORY_BY_TYPE`, filters it to the category the registration
// names, and asks the registered state vocabularies which of those rows the
// stream's wire arms can carry. A test file is not bundled, so it can import the
// census as a VALUE where the module deliberately imports it as a type only.
//
// The negative controls matter more than usual here, because every assertion in
// this file is about a set: a filter that produced the empty set, or a membership
// test that answered `false` for everything, would satisfy "carries only its own
// kinds" perfectly. Each clean set is therefore pinned against a kind that must be
// absent and a kind that must be present.

import { describe, expect, it } from "vitest";

import {
  QueueItemStateSchema,
  RunStateSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
  type EventCategory,
} from "@ai-sidekicks/contracts";

import {
  CONSOLE_SESSION_EVENT_STREAMS,
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
  SESSION_EVENT_STREAM,
  sessionEventStreamFor,
  subscriptionDeliversEventKind,
  type ConsoleSessionEventStreamName,
} from "./session-event-streams.js";

/** The namespace root every run-lifecycle event type carries. */
const RUN_EVENT_ROOT = "run.";

/** The namespace root every queue row carries. */
const QUEUE_ITEM_EVENT_ROOT = "queue_item.";

/** The registered forward, non-state rollback row — the state stream's second arm. */
const ROLLED_BACK_KIND = "run.rolled_back";

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

/** A stream name that reads like a registered subscription and is not one. */
const UNREGISTERED_STREAM = "run.subscribeStates";

/**
 * The census, re-keyed to plain strings.
 *
 * `SESSION_EVENT_CATEGORY_BY_TYPE` is keyed to the `SessionEventType` union, so
 * asking it about an arbitrary string needs a cast at every call site. One widened
 * view instead: the questions this file asks are all "is this wire-verbatim string
 * registered, and as what", which is a string question.
 */
const CATEGORY_BY_REGISTERED_KIND: ReadonlyMap<string, EventCategory> = new Map(
  SESSION_EVENT_CATEGORY_BY_TYPE,
);

/** Every registered event type in one category, read from the census. */
function registeredKindsIn(category: EventCategory): readonly string[] {
  return [...CATEGORY_BY_REGISTERED_KIND.entries()]
    .filter(([, registeredCategory]) => registeredCategory === category)
    .map(([eventType]) => eventType);
}

/** The kinds one narrowed stream carries, as the table declares them. */
function carriedKindsOf(subscriptionName: ConsoleSessionEventStreamName): ReadonlySet<string> {
  const stream = sessionEventStreamFor(subscriptionName);
  if (stream === undefined || stream.scope !== "selected-kinds") {
    throw new Error(`${subscriptionName} is not a narrowed stream, so it carries no kind set`);
  }
  return stream.carriedKinds;
}

function sorted(kinds: Iterable<string>): readonly string[] {
  return [...kinds].sort();
}

describe("session-event streams — the table carries what the wire registers", () => {
  it("routes exactly three registered subscriptions", () => {
    expect(Object.keys(CONSOLE_SESSION_EVENT_STREAMS).sort()).toStrictEqual(
      sorted([SESSION_EVENT_STREAM, RUN_STATE_EVENT_STREAM, RUN_QUEUE_EVENT_STREAM]),
    );
  });

  it("carries only kinds the census registers", () => {
    const carried = Object.values(CONSOLE_SESSION_EVENT_STREAMS).flatMap((stream) =>
      stream.scope === "selected-kinds" ? [...stream.carriedKinds] : [],
    );

    expect(carried.length).toBeGreaterThan(0);
    for (const kind of carried) {
      expect(CATEGORY_BY_REGISTERED_KIND.has(kind)).toBe(true);
    }
  });

  it("negative control: the census does not admit an event name nothing registers", () => {
    // Without this, the case above would pass over a census that answered `true`
    // for every string, which is exactly the shape a broken membership test takes.
    expect(CATEGORY_BY_REGISTERED_KIND.has(UNREGISTERED_KIND)).toBe(false);
  });

  it("gives the state stream one kind per canonical run state, plus the rollback arm", () => {
    // Re-derived from the census by the registration's own rule — one event per
    // canonical run state — rather than from the table under test.
    const stateTransitionKinds = registeredKindsIn("run_lifecycle").filter(
      (kind) => RunStateSchema.safeParse(kind.slice(RUN_EVENT_ROOT.length)).success,
    );

    expect(stateTransitionKinds).toHaveLength(9);
    expect(sorted(carriedKindsOf(RUN_STATE_EVENT_STREAM))).toStrictEqual(
      sorted([...stateTransitionKinds, ROLLED_BACK_KIND]),
    );
  });

  it("leaves the forward, non-state run rows off the state stream", () => {
    const carried = carriedKindsOf(RUN_STATE_EVENT_STREAM);

    for (const kind of NON_STATE_RUN_KINDS) {
      // Registered rows, deliberately uncarried: neither `RunStateChangeEvent` nor
      // `RunRolledBackEvent` can represent one, so a subscriber never sees them.
      expect(CATEGORY_BY_REGISTERED_KIND.get(kind)).toBe("run_lifecycle");
      expect(carried.has(kind)).toBe(false);
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
    expect(carriedKindsOf(RUN_QUEUE_EVENT_STREAM).has("intervention.requested")).toBe(false);
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

describe("session-event streams — what a subscription name delivers", () => {
  it("hands the whole-session stream every kind, carried or not", () => {
    expect(subscriptionDeliversEventKind(SESSION_EVENT_STREAM, "session.created")).toBe(true);
    expect(subscriptionDeliversEventKind(SESSION_EVENT_STREAM, "run.queued")).toBe(true);
    expect(subscriptionDeliversEventKind(SESSION_EVENT_STREAM, "queue_item.created")).toBe(true);
  });

  it("hands a narrowed stream its own kinds and refuses a registered stranger", () => {
    expect(subscriptionDeliversEventKind(RUN_STATE_EVENT_STREAM, "run.starting")).toBe(true);
    expect(subscriptionDeliversEventKind(RUN_STATE_EVENT_STREAM, ROLLED_BACK_KIND)).toBe(true);
    expect(subscriptionDeliversEventKind(RUN_STATE_EVENT_STREAM, "queue_item.created")).toBe(false);
    expect(subscriptionDeliversEventKind(RUN_QUEUE_EVENT_STREAM, "queue_item.expired")).toBe(true);
    expect(subscriptionDeliversEventKind(RUN_QUEUE_EVENT_STREAM, "run.starting")).toBe(false);
  });

  it("treats a name that is not a stream as a subscription to that one event type", () => {
    expect(subscriptionDeliversEventKind("run.starting", "run.starting")).toBe(true);
    expect(subscriptionDeliversEventKind("run.starting", "run.queued")).toBe(false);
  });

  it("negative control: a stream name nothing registers matches no kind at all", () => {
    for (const kind of CATEGORY_BY_REGISTERED_KIND.keys()) {
      expect(subscriptionDeliversEventKind(UNREGISTERED_STREAM, kind)).toBe(false);
    }
  });
});
