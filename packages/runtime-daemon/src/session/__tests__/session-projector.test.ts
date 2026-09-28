// Bootstrap projection — a single `session.created` event yields a snapshot
// naming the session's owner.
//
// Pure projector test — no SQLite, no service. Constructs a `StoredEvent`
// in-memory and calls `replay()` directly. The projector reads the owner off
// the envelope's `actor`; the `session.created` payload does not name it.

import { describe, expect, it } from "vitest";

import { replay } from "../session-projector.js";
import type { DaemonSessionSnapshot, StoredEvent } from "../types.js";

const SESSION_ID: string = "01J0SE5510NN5J5J5J5J5J5J5J";
const OWNER_ACTOR_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";
const OCCURRED_AT: string = "2026-04-27T12:00:00.000Z";

function makeCreatedEvent(): StoredEvent {
  return {
    id: "01J0EV0000NN5J5J5J5J5J5J5J",
    sessionId: SESSION_ID,
    sequence: 0,
    occurredAt: OCCURRED_AT,
    monotonicNs: 1_000_000_000n,
    category: "session_lifecycle",
    type: "session.created",
    actor: OWNER_ACTOR_ID,
    payload: { sessionId: SESSION_ID, name: "test-session" },
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

describe("session-projector — bootstrap projection", () => {
  it("records the owner from a single session.created event", () => {
    const snapshot: DaemonSessionSnapshot | null = replay([makeCreatedEvent()]);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return; // type guard for TS

    expect(snapshot.sessionId).toBe(SESSION_ID);
    // A newly created session starts in `provisioning`; the
    // `session.activated` handler that transitions it to `active` has not
    // landed yet.
    expect(snapshot.state).toBe("provisioning");
    expect(snapshot.createdAt).toBe(OCCURRED_AT);
    expect(snapshot.asOfSequence).toBe(0);

    // The owner is the bootstrap envelope's `actor` and nothing else.
    expect(snapshot.ownerActor).toBe(OWNER_ACTOR_ID);
  });

  it("lets a later event advance asOfSequence and nothing else", () => {
    // The no-leak half: an event the projector does not fold contributes no
    // field to the snapshot.
    const snapshot: DaemonSessionSnapshot | null = replay([
      makeCreatedEvent(),
      {
        ...makeCreatedEvent(),
        id: "01J0EV0001NN5J5J5J5J5J5J5J",
        sequence: 1,
        category: "assistant_output",
        type: "assistant.message",
        payload: { text: "hello" },
      },
    ]);
    expect(snapshot).toStrictEqual({ ...replay([makeCreatedEvent()]), asOfSequence: 1 });
  });

  it("returns null on an empty event list", () => {
    expect(replay([])).toBeNull();
  });

  it("rejects a first event that is not session.created", () => {
    const stranded: StoredEvent = {
      id: "01J0EV9999NN5J5J5J5J5J5J5J",
      sessionId: SESSION_ID,
      sequence: 0,
      occurredAt: OCCURRED_AT,
      monotonicNs: 1_000_000_000n,
      category: "session_lifecycle",
      type: "session.activated",
      actor: OWNER_ACTOR_ID,
      payload: { sessionId: SESSION_ID },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };
    expect(() => replay([stranded])).toThrow(/expected first event type 'session.created'/);
  });

  it("reports ownerActor as null when the bootstrap envelope names no actor", () => {
    // `actor: null` is legal on every wire variant, so a system-emitted
    // bootstrap names nobody. The projector reports that rather than
    // inventing an owner — there is no other signed place to read one from.
    const systemEmitted: StoredEvent = { ...makeCreatedEvent(), actor: null };
    const snapshot: DaemonSessionSnapshot | null = replay([systemEmitted]);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    expect(snapshot.ownerActor).toBeNull();
  });

  it("normalizes an empty-string actor to a null ownerActor", () => {
    // An empty owner is an absent owner. Collapsing the two here means no
    // reader has to check both.
    const blankActor: StoredEvent = { ...makeCreatedEvent(), actor: "" };
    const snapshot: DaemonSessionSnapshot | null = replay([blankActor]);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    expect(snapshot.ownerActor).toBeNull();
  });

  // -----------------------------------------------------------------------
  // replay() must reject a session.created at sequence > 0
  // -----------------------------------------------------------------------
  //
  // The bootstrap path's sequence-0 invariant must match `projectEvent`'s
  // in-stream `case "session.created"` guard — without the bootstrap-
  // path check, a log opening with `session.created` at sequence > 0
  // would be accepted as a valid bootstrap, masking lost/corrupted
  // earlier events. SessionService.append accepts arbitrary sequence
  // values today (the per-session strict-monotonicity is a producer
  // contract, not a service-layer enforcement), so this projector-side
  // assertion is the only line of defense that catches the case.

  it("rejects a bootstrap session.created event at sequence > 0", () => {
    const nonZeroBootstrap: StoredEvent = {
      ...makeCreatedEvent(),
      sequence: 1,
    };
    expect(() => replay([nonZeroBootstrap])).toThrow(
      /bootstrap 'session\.created' must have sequence=0 \(got sequence=1\)/,
    );
  });

  it("rejects a bootstrap session.created event at a far-future sequence (>0 covers the whole non-zero domain)", () => {
    // Belt-and-braces: pin a non-adjacent sequence so a regression that
    // accidentally compared `sequence < 1` (instead of `!== 0`) would
    // also surface. Picks a value that sits in the realistic per-
    // session range (well below Number.MAX_SAFE_INTEGER) so the test
    // exercises the same code path as production.
    const farFutureBootstrap: StoredEvent = {
      ...makeCreatedEvent(),
      sequence: 12345,
    };
    expect(() => replay([farFutureBootstrap])).toThrow(
      /bootstrap 'session\.created' must have sequence=0 \(got sequence=12345\)/,
    );
  });
});
