// What a `daemon.subscribe` name delivers, and that nothing can re-route the table at runtime.
// Whether each stream carries what the wire registers is `session-event-stream-kinds.test.ts`.
// Every assertion is about a set, so each answer is pinned against a kind that must be delivered
// and one that must not; a predicate that always answered `false` would otherwise pass.

import { describe, expect, it } from "vitest";

import {
  SESSION_EVENT_STREAMS,
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
    expect(subscriptionDeliversEventKind(RUN_QUEUE_EVENT_STREAM, "queue_item.not_delivered")).toBe(
      true,
    );
    expect(subscriptionDeliversEventKind(RUN_QUEUE_EVENT_STREAM, "run.starting")).toBe(false);
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

// The routing table is a process-wide constant, so the property to assert is that nothing in the
// process can change it, not that two bridges do not share state.
describe("session-event streams — the table cannot be re-routed at runtime", () => {
  it("refuses to grow a kind on an exported stream row", () => {
    // The rows were once `ReadonlySet` views over mutable `Set`s, so one `add` re-routed every
    // subscription in the renderer.
    const carried = carriedKindsOf(RUN_QUEUE_EVENT_STREAM);

    expect(() => {
      // @ts-expect-error `carriedKinds` is a `readonly string[]`, so `push` is a type error.
      carried.push("run.starting");
    }).toThrow(TypeError);
    expect(subscriptionDeliversEventKind(RUN_QUEUE_EVENT_STREAM, "run.starting")).toBe(false);
  });

  it("refuses to swap a whole stream row out of the exported table", () => {
    expect(() => {
      (SESSION_EVENT_STREAMS as Record<string, unknown>)[RUN_STATE_EVENT_STREAM] = {
        scope: "whole-session",
      };
    }).toThrow(TypeError);
    // A whole-session row answers `true` for every kind, so this is what a successful swap shows.
    expect(subscriptionDeliversEventKind(RUN_STATE_EVENT_STREAM, "queue_item.created")).toBe(false);
  });

  it("freezes the table, every row on it, and every kind list", () => {
    expect(Object.isFrozen(SESSION_EVENT_STREAMS)).toBe(true);
    for (const stream of Object.values(SESSION_EVENT_STREAMS)) {
      expect(Object.isFrozen(stream)).toBe(true);
      if (stream.scope === "selected-kinds") {
        expect(Object.isFrozen(stream.carriedKinds)).toBe(true);
      }
    }
  });

  it("negative control: the frozen check distinguishes a copy of the same data", () => {
    // Without it, an `isFrozen` that always answered `true` would pass the case above.
    expect(Object.isFrozen([...carriedKindsOf(RUN_STATE_EVENT_STREAM)])).toBe(false);
    expect(Object.isFrozen({ ...SESSION_EVENT_STREAMS })).toBe(false);
  });

  it("answers a lookup for an inherited property name as no row at all", () => {
    // Subscription names and kinds arrive wire-verbatim, so `"constructor"` must not resolve to
    // something off `Object.prototype`.
    expect(sessionEventStreamFor("constructor")).toBeUndefined();
    expect(subscriptionDeliversEventKind(RUN_STATE_EVENT_STREAM, "toString")).toBe(false);
    expect(subscriptionDeliversEventKind("constructor", "constructor")).toBe(true);
  });
});
