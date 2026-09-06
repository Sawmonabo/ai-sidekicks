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
function carriedKindsOf(subscriptionName: ConsoleSessionEventStreamName): readonly string[] {
  const stream = sessionEventStreamFor(subscriptionName);
  if (stream === undefined || stream.scope !== "selected-kinds") {
    throw new Error(`${subscriptionName} is not a narrowed stream, so it carries no kind list`);
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
    expect(CATEGORY_BY_REGISTERED_KIND.get(RUN_CREATION_KIND)).toBe("run_lifecycle");
    expect(subscriptionDeliversEventKind(RUN_STATE_EVENT_STREAM, RUN_CREATION_KIND)).toBe(false);
    expect(subscriptionDeliversEventKind(SESSION_EVENT_STREAM, RUN_CREATION_KIND)).toBe(true);
  });

  it("leaves the forward, non-state run rows off the state stream", () => {
    const carried = carriedKindsOf(RUN_STATE_EVENT_STREAM);

    for (const kind of NON_STATE_RUN_KINDS) {
      // Registered rows, deliberately uncarried: neither `RunStateChangeEvent` nor
      // `RunRolledBackEvent` can represent one, so a subscriber never sees them.
      expect(CATEGORY_BY_REGISTERED_KIND.get(kind)).toBe("run_lifecycle");
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

// The routing table is a process-wide CONSTANT and not per-bridge state, so
// "two bridges do not share routing state" is not the property to assert — there
// is no state to share, and asserting it would pass over the exact defect this
// closes. The stronger claim is asserted instead: nothing in the process can
// change the table at all, so no subscription, and no bridge, can re-route
// another.
describe("session-event streams — the table cannot be re-routed at runtime", () => {
  it("refuses to grow a kind on an exported stream row", () => {
    // The defect this closes: the rows were `ReadonlySet` views over mutable
    // `Set`s, and `ReadonlySet` is a compiler view and nothing else. One
    // `carriedKinds.add(…)` anywhere in the process re-routed every subscription
    // in the renderer for the rest of its life, silently and permanently.
    const carried = carriedKindsOf(RUN_QUEUE_EVENT_STREAM);

    expect(() => {
      // @ts-expect-error `carriedKinds` is a frozen `readonly string[]`, so the
      // compiler refuses `push` before the runtime does — both halves matter,
      // because the type view alone is what used to be relied on.
      carried.push("run.starting");
    }).toThrow(TypeError);
    expect(subscriptionDeliversEventKind(RUN_QUEUE_EVENT_STREAM, "run.starting")).toBe(false);
  });

  it("refuses to swap a whole stream row out of the exported table", () => {
    expect(() => {
      (CONSOLE_SESSION_EVENT_STREAMS as Record<string, unknown>)[RUN_STATE_EVENT_STREAM] = {
        scope: "whole-session",
      };
    }).toThrow(TypeError);
    // The routing the swap tried to install: a whole-session row answers `true`
    // for every kind, so this is what a successful mutation would have looked like.
    expect(subscriptionDeliversEventKind(RUN_STATE_EVENT_STREAM, "queue_item.created")).toBe(false);
  });

  it("freezes the table, every row on it, and every kind list", () => {
    expect(Object.isFrozen(CONSOLE_SESSION_EVENT_STREAMS)).toBe(true);
    for (const stream of Object.values(CONSOLE_SESSION_EVENT_STREAMS)) {
      expect(Object.isFrozen(stream)).toBe(true);
      if (stream.scope === "selected-kinds") {
        expect(Object.isFrozen(stream.carriedKinds)).toBe(true);
      }
    }
  });

  it("negative control: the frozen check distinguishes a copy of the same data", () => {
    // Without it, an `isFrozen` that answered `true` for everything would pass the
    // case above — and a copy is exactly what a caller who wants to mutate should
    // have to make, so it must read as unfrozen.
    expect(Object.isFrozen([...carriedKindsOf(RUN_STATE_EVENT_STREAM)])).toBe(false);
    expect(Object.isFrozen({ ...CONSOLE_SESSION_EVENT_STREAMS })).toBe(false);
  });

  it("answers a lookup for an inherited property name as no row at all", () => {
    // A subscription name and an event kind both arrive wire-verbatim, so
    // `"constructor"` reaches these lookups exactly as a registered string does. An
    // indexed read would answer it with something off `Object.prototype`, which is
    // a truthy value where the caller asked whether the table has a row.
    expect(sessionEventStreamFor("constructor")).toBeUndefined();
    expect(subscriptionDeliversEventKind(RUN_STATE_EVENT_STREAM, "toString")).toBe(false);
    expect(subscriptionDeliversEventKind("constructor", "constructor")).toBe(true);
  });
});
