// The decode boundary reads the wire's envelope and refuses the app's own projection shape.
// Both halves matter: a boundary that read the projection's names refused every canonical envelope
// while the fixture handed it the projection and every assertion agreed. The envelopes here are
// written member by member, not composed by `event-envelope.fixture.ts`, so the test checks the
// boundary against the contract rather than against the fixture's own composer.

import { describe, expect, it } from "vitest";

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session-event";
import type { EventCategory } from "@ai-sidekicks/contracts/event/envelope";

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

import { readSessionStreamFrame, type SessionStreamFrameReading } from "./session-event-payload.js";

/** A session id the branded schema accepts. */
const SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a99a9";

/** The daemon's opaque row id for the event under test. */
const EVENT_ID = "019b79ee-0280-7ea1-8110-e5e0d1159901";

/**
 * The position the stream delivered the change at: opaque, and not the event's id, so a decode
 * that copied the id into the cursor would be told apart.
 */
const CHANGE_CURSOR = "stream-position-41";

/** The user a user-attributed envelope names. */
const USER_ID = "019b79ee-0280-79a4-8110-cca0117a0110";

const OCCURRED_AT = "2026-01-01T14:20:00.500Z";

/** The census-known type every envelope below carries unless a case says otherwise. */
const REGISTERED_TYPE = "run.running";

/** A type spelled like a real one that the census does not register. */
const UNREGISTERED_TYPE = "run.teleported";

/** The one category the census pairs {@link REGISTERED_TYPE} with, read rather than written. */
const REGISTERED_CATEGORY = registeredCategoryOf(REGISTERED_TYPE);

/** The census entry for one type, or a failure saying the type is not registered at all. */
function registeredCategoryOf(eventType: typeof REGISTERED_TYPE): EventCategory {
  const category = SESSION_EVENT_CATEGORY_BY_TYPE.get(eventType);
  if (category === undefined) {
    throw new Error(`"${eventType}" is not a registered event type, so it pairs with no category`);
  }
  return category;
}

/**
 * Some registered category that is not the given one. Derived from the census so the mismatch
 * cases stay about the pairing when the taxonomy changes.
 */
function categoryOtherThan(ownCategory: EventCategory): EventCategory {
  const foreign = [...SESSION_EVENT_CATEGORY_BY_TYPE.values()].find(
    (candidate) => candidate !== ownCategory,
  );
  if (foreign === undefined) {
    throw new Error("the census registers one category, so no mismatched pairing can be planted");
  }
  return foreign;
}

/**
 * One canonical envelope, spelled as `packages/contracts` declares it. `overrides` is untyped so a
 * case can set a member to a value the contract forbids.
 */
function registeredEnvelope(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id: EVENT_ID,
    sessionId: SESSION_ID,
    sequence: 7,
    occurredAt: OCCURRED_AT,
    category: REGISTERED_CATEGORY,
    type: REGISTERED_TYPE,
    payload: { runId: SESSION_ID, newState: "running" },
    version: "1.0",
    ...overrides,
  };
}

/** One frame carrying one change, the given envelope at the change's cursor. */
function frameCarrying(envelope: unknown): Readonly<Record<string, unknown>> {
  return { changes: [{ cursor: CHANGE_CURSOR, event: envelope }] };
}

/** The frame carrying one envelope, read. */
function readFrameOf(envelope: unknown): SessionStreamFrameReading | undefined {
  return readSessionStreamFrame(frameCarrying(envelope));
}

/** The one event a frame carrying this envelope yields, or `undefined`. */
function readOneEvent(envelope: unknown): ProjectedSessionEvent | undefined {
  return readFrameOf(envelope)?.events[0];
}

describe("readSessionStreamFrame — the registered envelope", () => {
  it("decodes a wire envelope into the app's event, carrying its type and cursor", () => {
    const reading = readFrameOf(registeredEnvelope({ actor: USER_ID }));

    expect(reading).toStrictEqual({
      events: [
        {
          id: EVENT_ID,
          sessionId: SESSION_ID,
          sequence: 7,
          cursor: CHANGE_CURSOR,
          kind: "run.running",
          occurredAt: OCCURRED_AT,
          actorId: USER_ID,
          payload: { runId: SESSION_ID, newState: "running" },
        },
      ],
      unreadableEventCount: 0,
      dropped: false,
      resumeCursor: CHANGE_CURSOR,
    });
  });

  it("decodes a system-emitted envelope with no actor at all", () => {
    // `actor: null` is the wire's system arm. It must reach the app as an absence, not as the
    // string "null" or an empty id, because the store hands every actor to the agent hue allocator.
    const decoded = readOneEvent(registeredEnvelope({ actor: null }));

    expect(decoded?.actorId).toBeUndefined();
    expect(decoded?.kind).toBe("run.running");
  });
});

describe("readSessionStreamFrame — the census pairing of type and category", () => {
  it("refuses a census-known type carrying a category the registry does not pair it with", () => {
    // The case the tolerant carrier cannot make: it admits any registered category beside any
    // type, and the strict layer that rejects a mismatch does not run here. Without this check the
    // run partition would be mutated off a pairing the strict layer refuses.
    const reading = readFrameOf(
      registeredEnvelope({ category: categoryOtherThan(REGISTERED_CATEGORY) }),
    );

    // The refusal is the event's; the frame's other changes are not lost with it.
    expect(reading?.events).toStrictEqual([]);
    expect(reading?.unreadableEventCount).toBe(1);
    // A stream opened again resumes past the refused change too, so the daemon never sends it
    // twice.
    expect(reading?.resumeCursor).toBe(CHANGE_CURSOR);
  });

  it("admits a type the census does not register, whatever category it names", () => {
    // A higher-minor producer may send a type this app has no entry for, and the app keeps
    // it. Every category is swept so a check that refused one would be caught.
    expect(SESSION_EVENT_CATEGORY_BY_TYPE.has(UNREGISTERED_TYPE as never)).toBe(false);

    for (const category of new Set(SESSION_EVENT_CATEGORY_BY_TYPE.values())) {
      const decoded = readOneEvent(registeredEnvelope({ type: UNREGISTERED_TYPE, category }));

      expect(decoded?.kind).toBe(UNREGISTERED_TYPE);
    }
  });
});

describe("readSessionStreamFrame — the drop mark", () => {
  it("reads the caught-up frame: no events, and the daemon's mark that it dropped some", () => {
    // The one frame with no changes the contract admits. Read as an empty batch, it would leave the
    // session short of rows with nothing saying so.
    expect(readSessionStreamFrame({ changes: [], dropped: true, cursor: EVENT_ID })).toStrictEqual({
      events: [],
      unreadableEventCount: 0,
      dropped: true,
      resumeCursor: EVENT_ID,
    });
  });
});

describe("readSessionStreamFrame — what it refuses", () => {
  it("refuses the app's own projection shape", () => {
    // The app's own field names, with no `category` or `version`, which a boundary still
    // reading the projection would admit.
    const reading = readFrameOf({
      id: EVENT_ID,
      sessionId: SESSION_ID,
      sequence: 7,
      kind: "run.running",
      occurredAt: OCCURRED_AT,
      actorId: USER_ID,
      payload: {},
    });

    expect(reading).toBeUndefined();
  });
});
