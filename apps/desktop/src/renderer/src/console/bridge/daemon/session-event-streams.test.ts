// What a `daemon.subscribe` name delivers, and whether the routing can be changed
// under a running renderer.
//
// The two questions a SUBSCRIBER's string raises: which kinds bear on the name it
// passed, and whether anything in the process can answer that differently later.
// Whether each stream carries what the wire registers is the sibling suite,
// `session-event-stream-kinds.test.ts`, beside the module that declares the kinds —
// it re-derives every list from the contracts census, which is the proof this file
// takes as given.
//
// The negative controls carry the weight here for the same reason they do next door:
// every assertion is about a set, and a predicate that answered `false` for
// everything would satisfy "a narrowed stream refuses a stranger" perfectly. Each
// clean answer is therefore pinned against a kind that must be delivered and one that
// must not.

import { describe, expect, it } from "vitest";

import {
  CONSOLE_SESSION_EVENT_STREAMS,
  PRESENCE_EVENT_STREAM,
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
  SESSION_EVENT_STREAM,
  sessionEventStreamFor,
  subscriptionDeliversEventKind,
} from "./session-event-streams.js";
import {
  EVERY_REGISTERED_EVENT_KIND,
  ROLLED_BACK_KIND,
  carriedKindsOf,
  registeredKindsIn,
  sorted,
} from "./session-event-streams.test-support.js";

/** A stream name that reads like a registered subscription and is not one. */
const UNREGISTERED_STREAM = "run.subscribeStates";

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

  it("holds the Awareness stream to the presence transitions and to nothing else", () => {
    // Its kinds are the log-borne half of what moves the room. What it DELIVERS is a
    // payload-free signal rather than any of them — the fixture's own seam owns that —
    // and the other half, what a person is doing, rides on no registered event at all.
    expect(sorted(carriedKindsOf(PRESENCE_EVENT_STREAM))).toStrictEqual(
      sorted(registeredKindsIn("membership_change").filter((kind) => kind.startsWith("presence."))),
    );
    expect(subscriptionDeliversEventKind(PRESENCE_EVENT_STREAM, "presence.idle")).toBe(true);
    expect(subscriptionDeliversEventKind(PRESENCE_EVENT_STREAM, "run.starting")).toBe(false);
  });

  it("treats a name that is not a stream as a subscription to that one event type", () => {
    expect(subscriptionDeliversEventKind("run.starting", "run.starting")).toBe(true);
    expect(subscriptionDeliversEventKind("run.starting", "run.queued")).toBe(false);
  });

  it("negative control: a stream name nothing registers matches no kind at all", () => {
    for (const kind of EVERY_REGISTERED_EVENT_KIND) {
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
