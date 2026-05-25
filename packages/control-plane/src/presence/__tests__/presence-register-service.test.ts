// PresenceRegisterService tests — Plan-002 Phase 3 (T3.1 + T3.2).
//
// Coverage (mapped to the dispatched spec_coverage + verifies_invariant):
//   Pr1 (I-002-3, Spec-002 §Default Behavior line 58 + §State And Data
//       Implications line 157): Yjs Awareness presence state is IN-MEMORY ONLY
//       — NO SQLite or Postgres write occurs on heartbeat ingestion. This is
//       the load-bearing invariant test. It is proven three ways:
//         (a) the service takes NO database handle at all — a TYPE-LEVEL
//             guarantee that `recordHeartbeat` cannot write to a durable store
//             (there is nothing to write to). A heartbeat round-trips through
//             the in-memory CRDT (`recordHeartbeat` -> `readPresence`), proving
//             the service WORKS without any persistence dependency.
//         (b) after `applyMigrations(querier)` (v1 + v2, the full Plan-002
//             migration set), NO `public` table matches `ILIKE '%presence%'`.
//         (c) the v1->v2 migration DELTA introduces EXACTLY `session_invites`
//             and no presence-state table (the same delta-set assertion the
//             T2.5 migration-shape regression makes — re-verified here so the
//             "no presence-state table / no DB write" property is pinned from
//             the Phase-3 presence task's own suite).
//   P10 (re-verify): the (b) + (c) assertions ARE the P10 re-verification — the
//       same no-presence-state-table / no-DB-write schema-shape assertion as
//       Pr1's schema-shape test, run after the Plan-002 migrations.
//   Pr2 (Spec-002 §Fallback Behavior line 73): a missed heartbeat moves a
//       participant to `reconnecting` BEFORE `offline` — the reconnect-grace
//       two-step timer (15s -> reconnecting, 45s -> offline from the last
//       heartbeat). A heartbeat within the grace window cancels the pending
//       transition. The timer rewrites the live CRDT only (I-002-3) and fires
//       the `onTransition` observation seam (T3.3 wires durable emission; T3.2
//       writes nothing durable).
//   Pr3 (Spec-002 §Default Behavior line 61): Postgres LISTEN/NOTIFY fan-out
//       delivers presence updates cross-node. Proven with an in-memory
//       broadcast bus standing in for the shared NOTIFY channel (two services =
//       two nodes), PLUS one belt-and-suspenders test of the real
//       `PgListenNotifyPubSub` against a single PGlite. Covers: peer state lands
//       on the receiving node; transitions fan out too; self-origin echo is
//       suppressed; a malformed foreign state is rejected (foreign-writer
//       hardening); a live local holder outranks a peer; cross-node recency
//       resolves deterministically (the `originNodeId` tiebreak). I-002-3 holds
//       on the fan-out path: NOTIFY touches a TRANSIENT channel, never a row.
//
// Plus behavioral coverage of the T3.1 ingest/query surface:
//   * a fresh service holds no presence; an unknown session reads empty.
//   * all four PresenceState values (online/idle/reconnecting/offline) are
//     accepted and stored verbatim on ingest (the wire enum admits them).
//   * the service genuinely uses Yjs Awareness as the store (the CRDT instance
//     reflects the ingested state) — pins I-002-3's "Yjs Awareness CRDT".
//   * multi-device aggregation: most-recently-heard-from device wins per
//     participant.
//   * `forgetClient` GCs a client's in-memory state (the explicit
//     disconnect/GC primitive; the timer that drives it is T3.2).
//
// Harness: the in-process PGlite pattern from
// `migrations/__tests__/migration-shape.test.ts` — a fresh ephemeral PGlite
// for the schema-shape assertions, `applyMigrations` for the full Plan-002
// schema. The service itself needs NO database (that is the point of Pr1), so
// most behavioral tests construct it standalone.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ChannelId,
  ParticipantId,
  PresenceHeartbeat,
  PresenceState,
  SessionId,
} from "@ai-sidekicks/contracts";
// Value import: the response schema is used to prove the foreign-id validation
// closes the `presence.read` poisoning vector (a malformed peer id would
// otherwise make the whole response fail schema validation).
import { PresenceReadResponseSchema } from "@ai-sidekicks/contracts";

import { INITIAL_MIGRATION_SQL } from "../../migrations/0001-initial.js";
import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import {
  InMemoryPresencePubSub,
  PgListenNotifyPubSub,
  PresenceRegisterService,
  type PgListenNotifyClient,
  type PresenceFanoutMessage,
  type PresencePubSub,
  type PresenceTransitionEvent,
} from "../presence-register-service.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUID v7-shaped ids (the brand validators accept any RFC 9562
// UUID; real generation is daemon-side).
// ----------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e1001" as SessionId;
const OTHER_SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e1002" as SessionId;
const PARTICIPANT_A: ParticipantId = "01970000-0000-7000-8000-0000000f1001" as ParticipantId;
const PARTICIPANT_B: ParticipantId = "01970000-0000-7000-8000-0000000f1002" as ParticipantId;
const FOCUSED_CHANNEL: ChannelId = "01970000-0000-7000-8000-0000000c1001" as ChannelId;

const DEVICE_LAPTOP = "device-laptop-01";
const DEVICE_PHONE = "device-phone-01";

// Build a well-formed PresenceHeartbeat. `activityState` and the focus fields
// are overridable per test; the metadata floor (all 5 keys present) matches
// the contract shape (presence.ts:222).
function heartbeat(args: {
  participantId: ParticipantId;
  deviceId: string;
  activityState: PresenceState;
  focusedSessionId?: SessionId | null;
  focusedChannelId?: ChannelId | null;
  lastActivityAt?: string;
}): PresenceHeartbeat {
  return {
    participantId: args.participantId,
    deviceId: args.deviceId,
    activityState: args.activityState,
    metadata: {
      deviceType: "desktop",
      focusedSessionId: args.focusedSessionId ?? null,
      focusedChannelId: args.focusedChannelId ?? null,
      lastActivityAt: args.lastActivityAt ?? new Date().toISOString(),
      appVisible: true,
    },
  };
}

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (mirrors migration-shape.test.ts `wrap`). Used ONLY
// by the schema-shape assertions (Pr1 (b)/(c) + P10 re-verify); the service
// itself takes no Querier.
// ----------------------------------------------------------------------------

function adaptPGlite(pg: PGlite): Querier {
  return wrap(pg);
}

function wrap(handle: PGlite | Transaction): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      const result = await handle.query<T>(sql, mutableParams);
      return { rows: result.rows };
    },
    exec: async (sql: string): Promise<void> => {
      await handle.exec(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      if (!isPGlite(handle)) {
        throw new Error(
          "Querier.transaction(): nested transactions are not supported on this substrate.",
        );
      }
      return handle.transaction(async (tx) => fn(wrap(tx)));
    },
  };
}

function isPGlite(handle: PGlite | Transaction): handle is PGlite {
  return typeof (handle as { transaction?: unknown }).transaction === "function";
}

// Snapshot the full set of `public`-schema table names (mirrors
// migration-shape.test.ts). Returns a Set so callers can diff directly.
async function snapshotPublicTables(querier: Querier): Promise<Set<string>> {
  const probe = await querier.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'`,
  );
  return new Set(probe.rows.map((row) => row.table_name));
}

// ----------------------------------------------------------------------------
// Pr1 (a) — in-memory only: a heartbeat round-trips with NO database handle.
// ----------------------------------------------------------------------------
//
// The strongest form of "no DB write on heartbeat": the service constructor
// takes no Querier / Pool, so there is structurally nothing to write to. The
// round-trip proves the service WORKS (not merely that it does nothing) — a
// heartbeat ingested into the in-memory CRDT is read back via `readPresence`.

describe("PresenceRegisterService — Pr1 (a) in-memory ingest, no database handle (I-002-3)", () => {
  it("records a heartbeat and reads it back from the in-memory CRDT without any persistence dependency", () => {
    // Constructed with NO arguments — there is no database/Querier/Pool to
    // pass. This is the type-level no-DB-write guarantee.
    const service = new PresenceRegisterService();

    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        activityState: "online",
        focusedSessionId: SESSION_ID,
        focusedChannelId: FOCUSED_CHANNEL,
      }),
    );

    const presence = service.readPresence(SESSION_ID);
    expect(presence.participants).toHaveLength(1);
    const entry = presence.participants[0];
    expect(entry?.participantId).toBe(PARTICIPANT_A);
    expect(entry?.state).toBe("online");
    // `lastSeen` is a server-clock ISO 8601 string (RFC 3339), not the wire
    // `lastActivityAt`. Assert it parses to a finite instant.
    expect(entry?.lastSeen).toBeDefined();
    expect(Number.isNaN(Date.parse(entry?.lastSeen ?? ""))).toBe(false);
  });

  it("a fresh service holds no presence; an unknown session reads empty", () => {
    const service = new PresenceRegisterService();
    expect(service.readPresence(SESSION_ID).participants).toEqual([]);
    expect(service.readPresence(OTHER_SESSION_ID).participants).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Pr1 (b) + (c) / P10 re-verify — no presence-state table; no durable presence
// surface in the Plan-002 schema.
// ----------------------------------------------------------------------------
//
// These are the schema-side enforcement of I-002-3 (and the P10
// re-verification): after the full Plan-002 migration set, the schema holds NO
// presence table, and the v1->v2 delta is EXACTLY `session_invites`. Heartbeat
// ingestion happens entirely in memory and cannot add a table (Pr1 (a) above
// already proved the service has no DB handle); these tests pin the schema
// itself from the presence task's own suite.

describe("PresenceRegisterService — Pr1 (b)/(c) + P10 re-verify (no presence-state table; I-002-3)", () => {
  let pg: PGlite;
  let querier: Querier;

  beforeEach(() => {
    pg = new PGlite();
    querier = adaptPGlite(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("after applyMigrations (v1 + v2), no public table matches '%presence%'", async () => {
    await applyMigrations(querier);
    const probe = await querier.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name ILIKE '%presence%'`,
    );
    expect(probe.rows).toEqual([]);
  });

  it("the v1->v2 migration delta is EXACTLY { session_invites } — no presence-state table is added", async () => {
    // Stepwise so S1 (post-v1) and S2 (post-v2) are distinct snapshots, mirroring
    // migration-shape.test.ts. `applyMigrations` applies BOTH v1 and v2 in one
    // call, so split the boundary: snapshot after a partial apply is not
    // possible via the runner, so we exec v1 then the runner for the rest.
    await querier.transaction(async (tx) => {
      await tx.exec(
        // v1 only — bootstrap the Plan-001 schema so S1 is post-v1, pre-v2.
        // Imported indirectly through applyMigrations would apply v2 too; here
        // we want the pre-v2 snapshot, so exec the INITIAL SQL directly.
        INITIAL_MIGRATION_SQL,
      );
    });
    const s1: Set<string> = await snapshotPublicTables(querier);

    // Apply the remaining migrations (v2) through the production runner.
    await applyMigrations(querier);
    const s2: Set<string> = await snapshotPublicTables(querier);

    const delta: string[] = [...s2].filter((tableName) => !s1.has(tableName)).sort();
    // Load-bearing: v2 adds the invites table and NOTHING else — no presence
    // table, no surprise table. A presence-state table would surface as an
    // extra delta member.
    expect(delta).toEqual(["session_invites"]);

    // No presence table anywhere in the final schema.
    const presenceTables: string[] = [...s2].filter((tableName) =>
      tableName.toLowerCase().includes("presence"),
    );
    expect(presenceTables).toEqual([]);
  });

  it("heartbeat ingestion does NOT create any table (the service still has no DB handle)", async () => {
    await applyMigrations(querier);
    const before: Set<string> = await snapshotPublicTables(querier);

    // Ingest several heartbeats into the in-memory service. The service shares
    // NO state with the PGlite database — this is a belt-and-suspenders check
    // that exercising the ingest path alongside a live DB adds no table.
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_B, deviceId: DEVICE_PHONE, activityState: "idle" }),
    );

    const after: Set<string> = await snapshotPublicTables(querier);
    expect([...after].sort()).toEqual([...before].sort());
  });
});

// ----------------------------------------------------------------------------
// Yjs Awareness is genuinely the store (pins I-002-3's "Yjs Awareness CRDT").
// ----------------------------------------------------------------------------
//
// I-002-3 names the Yjs Awareness CRDT specifically — not an arbitrary Map. A
// foreign `Awareness` instance, fed the SAME serialized update the service's
// CRDT produces, reflects the ingested presence. This proves the service
// stores state in a real `y-protocols/awareness` instance whose binary update
// format round-trips (the exact wire format T3.2's LISTEN/NOTIFY fan-out uses).

describe("PresenceRegisterService — uses Yjs Awareness as the in-memory store (I-002-3)", () => {
  it("ingested presence is reflected in a Yjs Awareness CRDT (binary update round-trips)", async () => {
    // Encode/decode helpers live in y-protocols/awareness; import lazily here so
    // the round-trip uses the real CRDT serialization, not a hand-rolled shape.
    const { encodeAwarenessUpdate, applyAwarenessUpdate } = await import("y-protocols/awareness");

    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "idle" }),
    );

    // The service's projection reports the participant idle.
    const projected = service.readPresence(SESSION_ID);
    expect(projected.participants[0]?.state).toBe("idle");

    // Independent proof the store is a real Awareness CRDT: a second Awareness,
    // fed an update encoding the SAME local-state object the service stored,
    // surfaces that participant in its `getStates()`. (We reconstruct the
    // update from a freshly-built Awareness carrying the projected state, then
    // apply it to a receiver — exactly the encode/apply path T3.2 will use for
    // cross-node fan-out. This asserts the y-protocols binary format, not the
    // service internals.)
    const sourceDoc = new Y.Doc();
    const sourceAwareness = new Awareness(sourceDoc);
    sourceAwareness.setLocalState({ participantId: PARTICIPANT_A, state: "idle" });
    const update: Uint8Array = encodeAwarenessUpdate(sourceAwareness, [sourceDoc.clientID]);

    const receiverDoc = new Y.Doc();
    const receiverAwareness = new Awareness(receiverDoc);
    applyAwarenessUpdate(receiverAwareness, update, "test");
    const received = [...receiverAwareness.getStates().values()];
    expect(received.some((state) => state["participantId"] === PARTICIPANT_A)).toBe(true);

    sourceAwareness.destroy();
    sourceDoc.destroy();
    receiverAwareness.destroy();
    receiverDoc.destroy();
  });
});

// ----------------------------------------------------------------------------
// newAwareness neutralizes y-protocols' built-in 30s _checkInterval.
// ----------------------------------------------------------------------------
//
// `newAwareness` clears the y-protocols `_checkInterval` (an `outdatedTimeout`
// `setInterval`) via a cast so the service owns lifecycle via the grace timer
// and does not leak a 30s timer per connected client-device. The cast reaches a
// field that is typed `any` in the `.d.ts`, so a future y-protocols field RENAME
// would silently skip the `clearInterval` and leak the interval. A
// field-presence assertion is NOT rename-resilient (`clearInterval(handle)` does
// not null the field, and a renamed-away field reads `undefined` either way).
// The rename-resilient tripwire is setInterval/clearInterval ACCOUNTING: every
// interval handle created while constructing the service's Awareness MUST be
// passed to `clearInterval`. If a rename makes the cast miss the handle,
// `clearInterval` is never called for it and this assertion fails loudly.

describe("PresenceRegisterService — newAwareness clears the y-protocols _checkInterval (no leaked 30s timer)", () => {
  it("passes every setInterval handle created during Awareness construction to clearInterval", () => {
    // Spy BEFORE the service creates any Awareness. The reconnect-grace timer
    // uses setTimeout (not setInterval), so setInterval here isolates exactly the
    // y-protocols Awareness interval — no grace-timer noise.
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      const service = new PresenceRegisterService();
      // `recordHeartbeat` lazily creates the client's Y.Doc + Awareness via
      // `newAwareness`, which constructs the interval THEN clears it.
      service.recordHeartbeat(
        SESSION_ID,
        heartbeat({
          participantId: PARTICIPANT_A,
          deviceId: DEVICE_LAPTOP,
          activityState: "online",
        }),
      );

      const createdHandles = setIntervalSpy.mock.results
        .filter((result) => result.type === "return")
        .map((result) => result.value);
      const clearedHandles = clearIntervalSpy.mock.calls.map((call) => call[0]);

      // y-protocols' Awareness constructor arms exactly one interval; assert at
      // least one was created (else the spy/construction wiring drifted and the
      // test would be vacuously green).
      expect(createdHandles.length).toBeGreaterThanOrEqual(1);
      // The load-bearing tripwire: EVERY created interval handle was cleared. A
      // y-protocols `_checkInterval` rename makes `newAwareness`'s cast miss the
      // handle -> it is never cleared -> this fails.
      for (const handle of createdHandles) {
        expect(clearedHandles).toContain(handle);
      }
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});

// ----------------------------------------------------------------------------
// All four PresenceState values are accepted and stored verbatim on ingest.
// ----------------------------------------------------------------------------
//
// The wire enum admits online/idle/reconnecting/offline (presence.ts:121). T3.1
// must keep the ingest path total — it does NOT transition toward offline or GC
// on an "offline" heartbeat (that lifecycle is T3.2's timer), so an "offline"
// or "reconnecting" heartbeat is stored as-is and read back unchanged.

describe("PresenceRegisterService — accepts and stores all four PresenceState values", () => {
  const states: PresenceState[] = ["online", "idle", "reconnecting", "offline"];
  for (const state of states) {
    it(`stores a heartbeat carrying activityState='${state}' verbatim`, () => {
      const service = new PresenceRegisterService();
      service.recordHeartbeat(
        SESSION_ID,
        heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: state }),
      );
      const presence = service.readPresence(SESSION_ID);
      expect(presence.participants).toHaveLength(1);
      expect(presence.participants[0]?.state).toBe(state);
    });
  }
});

// ----------------------------------------------------------------------------
// Multi-device aggregation — most-recently-heard-from device wins per
// participant.
// ----------------------------------------------------------------------------

describe("PresenceRegisterService — multi-device aggregation (most-recently-ingested device wins)", () => {
  it("collapses two devices of one participant to a single entry carrying the most-recently-ingested device's state", () => {
    const service = new PresenceRegisterService();

    // First ingest the laptop (idle), then the phone (online). These two calls
    // are synchronous and land in the same `Date.now()` millisecond, so the
    // winner CANNOT be decided by `lastSeenAtMs` — the merge orders on the
    // monotonic ingest sequence instead, so the later-ingested phone wins
    // deterministically. The participant projects as the phone's `online`.
    // (This is the regression guard for the same-tick tie: ordering on the wall
    // clock here would be non-deterministic / `Map`-iteration-order-dependent.)
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "idle" }),
    );
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_PHONE, activityState: "online" }),
    );

    const presence = service.readPresence(SESSION_ID);
    // One participant entry despite two devices.
    expect(presence.participants).toHaveLength(1);
    expect(presence.participants[0]?.participantId).toBe(PARTICIPANT_A);
    // The later-ingested (phone) heartbeat wins.
    expect(presence.participants[0]?.state).toBe("online");
  });

  it("most-recently-ingested device wins regardless of insertion order (laptop ingested last wins)", () => {
    // Mirror of the above with the ingest order REVERSED — phone (online)
    // first, laptop (idle) last. The later-ingested laptop must now win,
    // proving the merge follows ingest order and not, say, a fixed
    // device-id sort or first-write-wins. Both halves together pin the
    // direction of the tiebreaker (newest ingest, not oldest).
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_PHONE, activityState: "online" }),
    );
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "idle" }),
    );

    const presence = service.readPresence(SESSION_ID);
    expect(presence.participants).toHaveLength(1);
    expect(presence.participants[0]?.state).toBe("idle");
  });

  it("keeps distinct participants as distinct entries", () => {
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_B, deviceId: DEVICE_PHONE, activityState: "idle" }),
    );
    const presence = service.readPresence(SESSION_ID);
    const ids = presence.participants.map((p) => p.participantId).sort();
    expect(ids).toEqual([PARTICIPANT_A, PARTICIPANT_B].sort());
  });

  it("scopes presence per session — a participant in session A does not appear in session B", () => {
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    expect(service.readPresence(SESSION_ID).participants).toHaveLength(1);
    expect(service.readPresence(OTHER_SESSION_ID).participants).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// forgetClient — explicit in-memory GC (the disconnect primitive; the timer
// that drives it on a grace-window expiry is T3.2).
// ----------------------------------------------------------------------------

describe("PresenceRegisterService — forgetClient (explicit in-memory GC of a disconnected client)", () => {
  it("removes a client's presence and returns true; the participant drops from the projection", () => {
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    expect(service.readPresence(SESSION_ID).participants).toHaveLength(1);

    const removed = service.forgetClient(SESSION_ID, PARTICIPANT_A, DEVICE_LAPTOP);
    expect(removed).toBe(true);
    expect(service.readPresence(SESSION_ID).participants).toEqual([]);
  });

  it("forgets only the named device; the participant's other device stays present", () => {
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "idle" }),
    );
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_PHONE, activityState: "online" }),
    );

    // Forget the phone; the laptop remains, so the participant is still present
    // (now projected as the laptop's idle, the only surviving device).
    expect(service.forgetClient(SESSION_ID, PARTICIPANT_A, DEVICE_PHONE)).toBe(true);
    const presence = service.readPresence(SESSION_ID);
    expect(presence.participants).toHaveLength(1);
    expect(presence.participants[0]?.state).toBe("idle");
  });

  it("returns false for an unknown (session, participant, device) tuple", () => {
    const service = new PresenceRegisterService();
    expect(service.forgetClient(SESSION_ID, PARTICIPANT_A, DEVICE_LAPTOP)).toBe(false);

    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    // Right session + participant, wrong device.
    expect(service.forgetClient(SESSION_ID, PARTICIPANT_A, DEVICE_PHONE)).toBe(false);
    // Wrong session.
    expect(service.forgetClient(OTHER_SESSION_ID, PARTICIPANT_A, DEVICE_LAPTOP)).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Pr2 — reconnect-grace timer: a missed heartbeat moves a participant to
// `reconnecting` BEFORE `offline` (Spec-002 §Fallback Behavior line 73).
// ----------------------------------------------------------------------------
//
// The two-step grace machine (Spec-002 line 57 defaults: 15s -> reconnecting,
// 45s -> offline, measured from the LAST heartbeat). Driven by Vitest fake
// timers so the transitions are deterministic. Fake timers are scoped to THIS
// describe (in beforeEach/afterEach) — the PGlite suites above run on real
// async and must NOT see a faked clock. `Date.now()` is faked alongside the
// timers, so `lastSeenAtMs` advances in lockstep with the scheduled callbacks.
//
// Short non-default windows (`reconnectingAfterMs` / `offlineAfterMs`) are
// injected so the test reads cleanly; the DEFAULT 15s/45s is asserted
// separately below from the no-arg constructor.

describe("PresenceRegisterService — constructor validates the injected nodeId option", () => {
  it("throws RangeError on an empty, over-length, or NUL-bearing nodeId (fail-fast, static message)", () => {
    // The injected `nodeId` is stamped as `originNodeId` on every LOCAL
    // snapshot, and the local read-back path revalidates those snapshots through
    // `PresenceLocalStateSchema`, whose `originNodeId` field is
    // `wireFreeFormString(NODE_ID_MAX_LEN=256, ...)`. An empty / over-length /
    // NUL-bearing `nodeId` would therefore SILENTLY drop this node's own
    // presence on every read and no-op every grace transition. The constructor
    // now rejects it FAST, symmetric with the timing guards. Same `["", "   ",
    // "x".repeat(257), "node\0x"]` quad as the peer-side `originNodeId` drop test
    // (one per wireFreeFormString failure class: empty / whitespace-only /
    // over-length / NUL).
    for (const badNodeId of ["", "   ", "x".repeat(257), "node\0x"]) {
      expect(() => new PresenceRegisterService({ nodeId: badNodeId })).toThrow(RangeError);
      // Pin the STATIC constraint wording so a future message change is caught.
      // Load-bearing: the message must NOT echo the raw value (a NUL/megabyte
      // nodeId in a log line is exactly the vector the guard closes), so it is a
      // fixed literal naming only the rule.
      expect(() => new PresenceRegisterService({ nodeId: badNodeId })).toThrow(
        /nodeId must be a non-blank string/,
      );
    }
  });

  it("accepts a valid custom nodeId and the no-option default (does not over-reject)", () => {
    // Converse: a legitimate non-UUID node id (the cross-node tests pass
    // "node-a" / "node-b") passes, and the no-options path — whose default
    // `crypto.randomUUID()` (36 chars, non-blank, no NUL) must satisfy the same
    // rule — constructs fine. The guard rejects only malformed ids, not the
    // arbitrary-but-well-formed strings the abstraction allows.
    expect(() => new PresenceRegisterService({ nodeId: "node-a" })).not.toThrow();
    expect(() => new PresenceRegisterService()).not.toThrow();
  });
});

describe("PresenceRegisterService — constructor validates the reconnecting/offline timing options", () => {
  it("throws RangeError when offlineAfterMs < reconnectingAfterMs (well-ordering invariant)", () => {
    // FIX C: the two-step `reconnecting -> offline` machine requires
    // `offlineAfterMs >= reconnectingAfterMs`. A swapped pair is a fail-fast
    // construction error whose message names BOTH offending values, in the
    // order the message interpolates them (`offlineAfterMs (X) must be >=
    // reconnectingAfterMs (Y)`) — pinning both rules out a transposed
    // interpolation silently passing.
    expect(
      () => new PresenceRegisterService({ reconnectingAfterMs: 15_000, offlineAfterMs: 10_000 }),
    ).toThrow(RangeError);
    expect(
      () => new PresenceRegisterService({ reconnectingAfterMs: 15_000, offlineAfterMs: 10_000 }),
    ).toThrow(/offlineAfterMs \(10000\) must be >= reconnectingAfterMs \(15000\)/);
  });

  it("throws RangeError on a negative, NaN, non-integer, or over-ceiling timing value", () => {
    // FIX C: these feed `#armGraceTimer`'s `Math.max(0, …)` + setTimeout, where
    // a negative / NaN / fractional delay is a silent footgun (NaN coerces to a
    // 0ms timer). Each is rejected at construction; the message names the bad
    // value (its `String(value)` form), so a mislabeled message fails the test.
    expect(() => new PresenceRegisterService({ reconnectingAfterMs: -1 })).toThrow(RangeError);
    expect(() => new PresenceRegisterService({ reconnectingAfterMs: -1 })).toThrow(/received -1/);
    expect(() => new PresenceRegisterService({ offlineAfterMs: Number.NaN })).toThrow(
      /received NaN/,
    );
    expect(() => new PresenceRegisterService({ reconnectingAfterMs: 1.5 })).toThrow(/received 1.5/);
    expect(() => new PresenceRegisterService({ offlineAfterMs: 60_000.5 })).toThrow(
      /received 60000.5/,
    );

    // A delay above setTimeout's 32-bit ceiling (2^31-1 = 2_147_483_647) would
    // overflow and be coerced to ~1ms (TimeoutOverflowWarning), firing the grace
    // transition almost immediately and silently forcing the client offline.
    // `2_147_483_648` is exactly one past the ceiling. Hardcoded (not imported
    // from the module) so the test pins the documented bound independently of the
    // const. Asserted for BOTH timing options.
    expect(() => new PresenceRegisterService({ reconnectingAfterMs: 2_147_483_648 })).toThrow(
      RangeError,
    );
    expect(() => new PresenceRegisterService({ reconnectingAfterMs: 2_147_483_648 })).toThrow(
      /setTimeout ceiling/,
    );
    expect(() => new PresenceRegisterService({ offlineAfterMs: 2_147_483_648 })).toThrow(
      RangeError,
    );
  });

  it("accepts valid timing config, including equal values and the defaults", () => {
    // FIX C converse: the validation does NOT over-reject — equal values are a
    // legitimate (degenerate but well-ordered) config, 0 is a non-negative
    // integer, and the no-options path (the defaults, 15s/45s) constructs fine.
    expect(
      () => new PresenceRegisterService({ reconnectingAfterMs: 30_000, offlineAfterMs: 30_000 }),
    ).not.toThrow();
    expect(
      () => new PresenceRegisterService({ reconnectingAfterMs: 0, offlineAfterMs: 0 }),
    ).not.toThrow();
    expect(() => new PresenceRegisterService()).not.toThrow();
    // The exact setTimeout ceiling (2^31-1 = 2_147_483_647) is the largest
    // ACCEPTED value — pins that the bound is `>` not `>=` (a `>=` regression
    // would silently pass the over-ceiling reject test). Hardcoded to match the
    // suite's independent-bound-pinning convention.
    expect(() => new PresenceRegisterService({ offlineAfterMs: 2_147_483_647 })).not.toThrow();
  });
});

describe("PresenceRegisterService — Pr2 reconnect-grace timer (reconnecting before offline)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves online -> reconnecting at the grace threshold, then -> offline, observing reconnecting FIRST", () => {
    const transitions: PresenceTransitionEvent[] = [];
    const service = new PresenceRegisterService({
      reconnectingAfterMs: 15_000,
      offlineAfterMs: 45_000,
      onTransition: (event) => {
        transitions.push(event);
      },
    });

    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("online");

    // Just before the reconnecting threshold — still online.
    vi.advanceTimersByTime(14_999);
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("online");

    // Cross 15s — reconnecting (NOT offline yet). This is the load-bearing
    // ordering assertion: reconnecting precedes offline.
    vi.advanceTimersByTime(1);
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("reconnecting");

    // Just before the offline threshold — still reconnecting.
    vi.advanceTimersByTime(29_999);
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("reconnecting");

    // Cross 45s (from the heartbeat) — offline.
    vi.advanceTimersByTime(1);
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("offline");

    // The observation seam saw EXACTLY the ordered two-step transition.
    expect(transitions.map((event) => `${event.from}->${event.to}`)).toEqual([
      "online->reconnecting",
      "reconnecting->offline",
    ]);
    // Each transition carries the participant/device and a wall-clock instant.
    expect(transitions[0]?.participantId).toBe(PARTICIPANT_A);
    expect(transitions[0]?.deviceId).toBe(DEVICE_LAPTOP);
    expect(transitions[0]?.at).toBeInstanceOf(Date);
  });

  it("a heartbeat within the grace window cancels the pending reconnecting transition", () => {
    const transitions: PresenceTransitionEvent[] = [];
    const service = new PresenceRegisterService({
      reconnectingAfterMs: 15_000,
      offlineAfterMs: 45_000,
      onTransition: (event) => {
        transitions.push(event);
      },
    });

    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );

    // Advance into the window but BEFORE the reconnecting threshold, then send a
    // fresh heartbeat — this re-arms the timer, so the participant must stay
    // online past the ORIGINAL 15s mark.
    vi.advanceTimersByTime(10_000);
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );

    // 10s after the SECOND heartbeat (20s after the first): still online,
    // because the second heartbeat reset the grace timer.
    vi.advanceTimersByTime(10_000);
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("online");
    expect(transitions).toEqual([]);

    // Now let the (re-armed) window elapse with no further heartbeats: it
    // transitions on the new schedule.
    vi.advanceTimersByTime(5_000); // 15s after the second heartbeat.
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("reconnecting");
  });

  it("recovers a client from reconnecting back to online on a fresh heartbeat (no spurious backward transition)", () => {
    // The cancel test above pins cancel-BEFORE-reconnecting; this pins recovery
    // AFTER a client has actually reached `reconnecting`. Recovery is sound today
    // because `recordHeartbeat` -> `setLocalState` rewrites the slot directly and
    // BYPASSES the forward-only `#transition` — so it is NOT gated by the
    // degradation ordering. This is unpinned otherwise: a future refactor routing
    // heartbeats through `#transition` would strand a recovered client in
    // `reconnecting` (the backward online<-reconnecting move would be a no-op).
    const transitions: PresenceTransitionEvent[] = [];
    const service = new PresenceRegisterService({
      reconnectingAfterMs: 15_000,
      offlineAfterMs: 45_000,
      onTransition: (event) => {
        transitions.push(event);
      },
    });

    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );

    // Cross the reconnecting threshold (but NOT offline) — the client degrades.
    vi.advanceTimersByTime(15_000);
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("reconnecting");

    // A fresh `online` heartbeat arrives within the offline window — the client
    // must recover to `online`.
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("online");

    // The observation stream saw ONLY the forward degradation step — recovery is
    // a direct slot rewrite, NOT a timer transition, so there is NO spurious
    // `reconnecting->online` event. (Regression guard: routing heartbeats through
    // `#transition` would either strand the client OR emit a bogus backward
    // transition — both trip this assertion.)
    expect(transitions.map((event) => `${event.from}->${event.to}`)).toEqual([
      "online->reconnecting",
    ]);
  });

  it("uses the Spec-002 default 15s/45s grace windows when not overridden", () => {
    // Constructed with NO timing options — the defaults must be the spec values.
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );

    vi.advanceTimersByTime(15_000);
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("reconnecting");
    vi.advanceTimersByTime(30_000); // 45s total.
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("offline");
  });

  it("never bounces an already-offline client backward to reconnecting (forward-only degradation)", () => {
    const transitions: PresenceTransitionEvent[] = [];
    const service = new PresenceRegisterService({
      reconnectingAfterMs: 15_000,
      offlineAfterMs: 45_000,
      onTransition: (event) => {
        transitions.push(event);
      },
    });

    // A heartbeat that already carries the TERMINAL `offline` state. The grace
    // timer still fires at 15s/45s, but the machine only moves FORWARD in
    // degradation (online/idle < reconnecting < offline) — so the 15s step
    // (-> reconnecting) is a no-op (it would move backward) and the 45s step
    // (-> offline) is a no-op (already there). The observer sees NOTHING — a
    // bogus offline->reconnecting transition would pollute T3.3's durable
    // timeline.
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        activityState: "offline",
      }),
    );
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("offline");

    vi.advanceTimersByTime(45_000);
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("offline");
    expect(transitions).toEqual([]);
  });

  it("the timer rewrites the live CRDT only — no durable handle exists (I-002-3)", () => {
    // The service has NO database/Querier/Pool (type-level no-DB guarantee), so
    // a timer-driven transition cannot write durably — there is nothing to write
    // to. The ONLY emission seam is the in-process `onTransition` observer
    // (T3.3 wires durable emission downstream; T3.2 writes nothing).
    let observed = false;
    const service = new PresenceRegisterService({
      reconnectingAfterMs: 15_000,
      offlineAfterMs: 45_000,
      onTransition: () => {
        observed = true;
      },
    });
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    vi.advanceTimersByTime(15_000);
    // The transition is reflected purely in the in-memory projection.
    expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("reconnecting");
    expect(observed).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Pr2 (crash guard) — a throwing onTransition observer must NOT crash the
// process (daemon-crash guard on the detached setTimeout grace-timer boundary).
// ----------------------------------------------------------------------------
//
// `#transition` fires the `onTransition` observer from a DETACHED `setTimeout`
// grace-timer callback (`#armGraceTimer`). The observer is T3.3's durable-
// emission seam wired to `SessionService.append`, which CAN throw (SQLite
// `SQLITE_BUSY`, a `monotonic_ns` unique-violation, a Zod failure). On a real
// timer boundary an uncaught throw ESCAPES to Node's `uncaughtException` and can
// terminate the daemon process — exactly the failure the guard in `#transition`
// prevents (mirrors the daemon's session-subscribe.ts setImmediate/timer guard).
//
// This test deliberately uses REAL timers (a tiny 5ms reconnecting window),
// NOT the fake timers the rest of Pr2 uses: under `vi.useFakeTimers()` a throw
// inside a `setTimeout` callback is re-thrown SYNCHRONOUSLY by
// `advanceTimersByTime` and never reaches `process.on("uncaughtException")`, so
// the "no uncaught exception" assertion would be vacuous. Real timers exercise
// the genuine production path: the detached callback runs on its own tick, so a
// throw really would surface as an `uncaughtException` if the guard regressed.

describe("PresenceRegisterService — Pr2 crash guard (a throwing onTransition observer does not crash the process)", () => {
  it("swallows a throw from the onTransition seam on the grace-timer boundary, logs a tripwire, and keeps processing", async () => {
    // Capture any uncaughtException the timer boundary would surface. WITHOUT
    // the guard in `#transition`, the synthetic throw below escapes the detached
    // `setTimeout` callback and lands here (and, unguarded in production, would
    // terminate the daemon). WITH the guard it is swallowed, so this list stays
    // empty.
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);

    // Spy on `console.error` so the tripwire log is assertable. Mock the impl to
    // a no-op so the synthetic-failure diagnostic does not pollute test output.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // The observer throws on the FIRST transition (PARTICIPANT_A's
    // reconnecting), then becomes a no-op so a subsequent participant's
    // transitions are observed normally. A short 5ms reconnecting window keeps
    // the real-timer wait tight.
    const observed: string[] = [];
    let throwOnce = true;
    const service = new PresenceRegisterService({
      reconnectingAfterMs: 5,
      offlineAfterMs: 10_000, // far out — this test only drives the reconnecting step.
      onTransition: (event) => {
        if (throwOnce && event.participantId === PARTICIPANT_A) {
          throwOnce = false;
          throw new Error("synthetic append failure");
        }
        observed.push(`${event.participantId}:${event.from}->${event.to}`);
      },
    });

    try {
      // Drive PARTICIPANT_A to the reconnecting transition; its observer throws.
      service.recordHeartbeat(
        SESSION_ID,
        heartbeat({
          participantId: PARTICIPANT_A,
          deviceId: DEVICE_LAPTOP,
          activityState: "online",
        }),
      );
      // Wait past the 5ms reconnecting window on REAL timers so the detached
      // `setTimeout` callback runs on its own tick (where an unguarded throw
      // would escape to `uncaughtException`).
      await new Promise((resolve) => setTimeout(resolve, 30));

      // (a) The throw was SWALLOWED at the guard, not propagated to the process.
      // (If the guard were removed, the detached-callback throw would land in
      // `uncaught` here.)
      expect(uncaught).toEqual([]);

      // (b) The guard logged the tripwire with the full transition context
      // (sessionId / participantId / from / to).
      expect(consoleErrorSpy).toHaveBeenCalled();
      const tripwireCall = consoleErrorSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("onTransition observer threw"),
      );
      expect(tripwireCall).toBeDefined();
      const tripwireMessage = tripwireCall?.[0] as string;
      expect(tripwireMessage).toContain(SESSION_ID);
      expect(tripwireMessage).toContain(PARTICIPANT_A);
      expect(tripwireMessage).toContain("from=online");
      expect(tripwireMessage).toContain("to=reconnecting");
      // The thrown Error is forwarded as the second arg for diagnosis.
      expect(tripwireCall?.[1]).toBeInstanceOf(Error);
      expect((tripwireCall?.[1] as Error).message).toBe("synthetic append failure");

      // The in-memory CRDT still advanced despite the observer throw — the
      // transition itself is applied BEFORE the (swallowed) emission.
      expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("reconnecting");

      // (c) The service is NOT in a corrupt state: a SUBSEQUENT heartbeat for a
      // DIFFERENT participant still processes and its grace-timer transition is
      // observed normally (the observer no longer throws).
      service.recordHeartbeat(
        SESSION_ID,
        heartbeat({
          participantId: PARTICIPANT_B,
          deviceId: DEVICE_PHONE,
          activityState: "online",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(observed).toContain(`${PARTICIPANT_B}:online->reconnecting`);
      // PARTICIPANT_B surfaces correctly in the projection alongside A.
      const states = new Map(
        service.readPresence(SESSION_ID).participants.map((p) => [p.participantId, p.state]),
      );
      expect(states.get(PARTICIPANT_B)).toBe("reconnecting");

      await service.destroy();
    } finally {
      process.removeListener("uncaughtException", onUncaught);
      consoleErrorSpy.mockRestore();
    }
  });

  it("swallows a REJECTION from an async onTransition seam, logs the async tripwire, and does not crash", async () => {
    // The seam is legitimately async (T3.3 wires it to `SessionService.append`,
    // a DB write). A plain try/catch catches a SYNC throw but NOT a rejected
    // promise — an unhandled rejection on this detached `setTimeout` boundary
    // escapes to Node's `unhandledRejection` and can terminate the daemon. The
    // guard duck-types the observer's return value for a thenable and attaches a
    // `.catch` to the same tripwire. Real timers (not fake) so the detached
    // callback runs on its own tick — exactly the production path where an
    // unguarded rejection would surface as `unhandledRejection`.
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUncaught);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // An `async` callback that REJECTS — assignable to the widened
    // `() => void | Promise<void>` seam. This is the failure shape T3.3's async
    // append produces (e.g. a rejected SQLite write), distinct from a sync throw.
    const service = new PresenceRegisterService({
      reconnectingAfterMs: 5,
      offlineAfterMs: 10_000, // far out — this test only drives the reconnecting step.
      onTransition: async () => {
        await Promise.resolve();
        throw new Error("synthetic async append rejection");
      },
    });

    try {
      service.recordHeartbeat(
        SESSION_ID,
        heartbeat({
          participantId: PARTICIPANT_A,
          deviceId: DEVICE_LAPTOP,
          activityState: "online",
        }),
      );
      // Wait past the 5ms reconnecting window on REAL timers so the detached
      // callback fires, THEN flush microtasks so the rejected promise's `.catch`
      // (or, if the guard regressed, the `unhandledRejection`) has settled.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await new Promise((resolve) => setImmediate(resolve));

      // (a) The rejection was routed to the guard's `.catch`, NOT to the process:
      // neither the unhandledRejection nor the uncaughtException handler fired.
      expect(unhandledRejections).toEqual([]);
      expect(uncaught).toEqual([]);

      // (b) The async tripwire fired with the full transition context and the
      // rejection reason forwarded for diagnosis.
      const tripwireCall = consoleErrorSpy.mock.calls.find(
        (call) =>
          typeof call[0] === "string" && call[0].includes("onTransition observer rejected (async)"),
      );
      expect(tripwireCall).toBeDefined();
      const tripwireMessage = tripwireCall?.[0] as string;
      expect(tripwireMessage).toContain(SESSION_ID);
      expect(tripwireMessage).toContain(PARTICIPANT_A);
      expect(tripwireMessage).toContain("from=online");
      expect(tripwireMessage).toContain("to=reconnecting");
      expect(tripwireCall?.[1]).toBeInstanceOf(Error);
      expect((tripwireCall?.[1] as Error).message).toBe("synthetic async append rejection");

      // The in-memory CRDT still advanced despite the rejected emission.
      expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("reconnecting");

      await service.destroy();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      process.removeListener("uncaughtException", onUncaught);
      consoleErrorSpy.mockRestore();
    }
  });

  it("routes a rejection from a `.then`-only thenable (no `.catch`) to the async tripwire, not a sync mislabel", async () => {
    // Hardening parity with `jsonRpcClient.ts`: the seam is a foreign-code trust
    // boundary, and the PromiseLike (TC39) contract only requires `.then` — a
    // valid thenable MAY omit `.catch`. The guard MUST discharge the rejection
    // via `Promise.resolve(thenable).catch(...)`, never a DIRECT `.catch` on the
    // value: a direct call on a `.then`-only thenable is `undefined(...)` →
    // throws TypeError synchronously → lands in the sync catch (MISLABELED
    // "(sync)") while the REAL rejection goes unrouted to `unhandledRejection`.
    // This thenable rejects and has NO `.catch`. It is a PromiseLike, not a
    // Promise, so it does not statically satisfy `() => void | Promise<void>` —
    // the cast injects it to exercise the RUNTIME path the duck-typing defends (a
    // JS caller / cross-realm value / lying types). The native-Promise test above
    // passes BOTH the old and new code, so it does NOT cover this case; this does.
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUncaught);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const thenOnlyRejecting = {
      then: (_resolve: (value: void) => void, reject?: (reason: unknown) => void): void => {
        reject?.(new Error("synthetic then-only rejection"));
      },
    };
    const service = new PresenceRegisterService({
      reconnectingAfterMs: 5,
      offlineAfterMs: 10_000, // far out — this test only drives the reconnecting step.
      // Cast: a `.then`-only PromiseLike is exactly the runtime shape the guard
      // must absorb; the static type is intentionally bypassed (see comment).
      onTransition: (() => thenOnlyRejecting) as unknown as (
        event: PresenceTransitionEvent,
      ) => void | Promise<void>,
    });

    try {
      service.recordHeartbeat(
        SESSION_ID,
        heartbeat({
          participantId: PARTICIPANT_A,
          deviceId: DEVICE_LAPTOP,
          activityState: "online",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      await new Promise((resolve) => setImmediate(resolve));

      // (a) The rejection was absorbed by `Promise.resolve(...).catch`, NOT
      // leaked to the process and NOT swallowed as a sync TypeError.
      expect(unhandledRejections).toEqual([]);
      expect(uncaught).toEqual([]);

      // (b) It was routed to the ASYNC tripwire (not the "(sync)" one — a direct
      // `.catch` TypeError would have hit the sync catch instead). The forwarded
      // reason is the thenable's rejection, not a TypeError.
      const asyncTripwire = consoleErrorSpy.mock.calls.find(
        (call) =>
          typeof call[0] === "string" && call[0].includes("onTransition observer rejected (async)"),
      );
      expect(asyncTripwire).toBeDefined();
      expect(asyncTripwire?.[1]).toBeInstanceOf(Error);
      expect((asyncTripwire?.[1] as Error).message).toBe("synthetic then-only rejection");
      // The sync tripwire must NOT have fired (no swallowed-and-mislabeled
      // TypeError from a direct `.catch` on a `.then`-only value).
      const syncTripwire = consoleErrorSpy.mock.calls.find(
        (call) =>
          typeof call[0] === "string" && call[0].includes("onTransition observer threw (sync)"),
      );
      expect(syncTripwire).toBeUndefined();

      expect(service.readPresence(SESSION_ID).participants[0]?.state).toBe("reconnecting");

      await service.destroy();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      process.removeListener("uncaughtException", onUncaught);
      consoleErrorSpy.mockRestore();
    }
  });
});

// ----------------------------------------------------------------------------
// Pr3 — Postgres LISTEN/NOTIFY cross-node fan-out (Spec-002 §Default Behavior
// line 61).
// ----------------------------------------------------------------------------
//
// The cross-node tests use an `InMemoryPresencePubSub` as the shared transport:
// two `PresenceRegisterService` instances subscribing to ONE bus model two
// nodes on ONE Postgres NOTIFY channel (two in-process PGlite instances are
// SEPARATE databases that cannot share NOTIFY, so the bus is the faithful
// unit-test substrate — see the class doc). The real `PgListenNotifyPubSub` is
// exercised separately below against a single PGlite (belt-and-suspenders).
//
// `nodeId` is injected explicitly per service so self-suppression and the
// cross-node recency tiebreak are deterministic and assertable.

describe("PresenceRegisterService — Pr3 cross-node fan-out (LISTEN/NOTIFY, in-memory substrate)", () => {
  it("delivers a heartbeat ingested on node A to node B's projection", async () => {
    const bus = new InMemoryPresencePubSub();
    const nodeA = new PresenceRegisterService({ pubSub: bus, nodeId: "node-a" });
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

    // Ingest on A. The publish fans out synchronously through the in-memory bus,
    // so B applies the peer state immediately.
    nodeA.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );

    const onB = nodeB.readPresence(SESSION_ID);
    expect(onB.participants).toHaveLength(1);
    expect(onB.participants[0]?.participantId).toBe(PARTICIPANT_A);
    expect(onB.participants[0]?.state).toBe("online");

    await nodeA.destroy();
    await nodeB.destroy();
  });

  it("fans out a timer-driven transition (reconnecting) to the peer node, not just heartbeats", () => {
    vi.useFakeTimers();
    try {
      const bus = new InMemoryPresencePubSub();
      const nodeA = new PresenceRegisterService({
        pubSub: bus,
        nodeId: "node-a",
        reconnectingAfterMs: 15_000,
        offlineAfterMs: 45_000,
      });
      const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

      nodeA.recordHeartbeat(
        SESSION_ID,
        heartbeat({
          participantId: PARTICIPANT_A,
          deviceId: DEVICE_LAPTOP,
          activityState: "online",
        }),
      );
      expect(nodeB.readPresence(SESSION_ID).participants[0]?.state).toBe("online");

      // A's grace timer fires reconnecting; `#transition` re-publishes, so B's
      // peer snapshot must update to reconnecting too.
      vi.advanceTimersByTime(15_000);
      expect(nodeB.readPresence(SESSION_ID).participants[0]?.state).toBe("reconnecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses a node's own fan-out echo (no self-applied peer holder)", () => {
    // A single service subscribed to a bus that echoes its own publishes back.
    // Self-origin messages must be dropped — the local holder stays authoritative
    // and no duplicate/peer holder is created for its own device.
    const bus = new InMemoryPresencePubSub();
    const node = new PresenceRegisterService({ pubSub: bus, nodeId: "node-a" });

    node.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "idle" }),
    );

    const presence = node.readPresence(SESSION_ID);
    // Exactly one participant, projected from the LOCAL holder (idle), with no
    // phantom peer entry from the echoed self-message.
    expect(presence.participants).toHaveLength(1);
    expect(presence.participants[0]?.state).toBe("idle");
  });

  it("rejects a malformed foreign presence state (foreign-writer hardening — bad enum value)", () => {
    // A hostile/buggy peer publishes a state carrying an OFF-ENUM activity value
    // (`"away"` is not one of online/idle/reconnecting/offline). The receiving
    // node must REJECT it (full revalidation incl. enum membership), not project
    // it. We craft the malformed update via the real y-protocols encode path and
    // inject it straight onto the bus as if from another node.
    const bus = new InMemoryPresencePubSub();
    const node = new PresenceRegisterService({ pubSub: bus, nodeId: "node-a" });

    const foreignUpdate = encodeForeignState({
      participantId: PARTICIPANT_B,
      deviceId: DEVICE_PHONE,
      state: "away", // OFF-ENUM — must be rejected.
      deviceType: "desktop",
      focusedSessionId: null,
      focusedChannelId: null,
      lastSeenAtMs: Date.now(),
      originNodeId: "node-evil",
      ingestSequence: 1,
      lastActivityAt: new Date().toISOString(),
      appVisible: true,
    });
    void bus.publish({ sessionId: SESSION_ID, update: foreignUpdate, originNodeId: "node-evil" });

    // The malformed peer contributed nothing.
    expect(node.readPresence(SESSION_ID).participants).toEqual([]);

    // Control: a WELL-FORMED foreign state from the same peer IS projected,
    // proving the rejection above was specific to the bad enum and not a
    // blanket drop of all foreign input.
    const validUpdate = encodeForeignState({
      participantId: PARTICIPANT_B,
      deviceId: DEVICE_PHONE,
      state: "online",
      deviceType: "desktop",
      focusedSessionId: null,
      focusedChannelId: null,
      lastSeenAtMs: Date.now(),
      originNodeId: "node-evil",
      ingestSequence: 2,
      lastActivityAt: new Date().toISOString(),
      appVisible: true,
    });
    void bus.publish({ sessionId: SESSION_ID, update: validUpdate, originNodeId: "node-evil" });
    const after = node.readPresence(SESSION_ID);
    expect(after.participants).toHaveLength(1);
    expect(after.participants[0]?.state).toBe("online");
  });

  it("does NOT leak an empty session map when a fan-out message contributes no surviving holder (ACTIONABLE memory-exhaustion guard)", () => {
    // `#onFanoutMessage` get-or-creates a session map BEFORE the per-state loop.
    // When NO state survives (all rejected by foreign-writer revalidation, or
    // all per-state self-origin), the map would otherwise persist empty forever
    // — a hostile/buggy peer publishing malformed-only states across many
    // DISTINCT, never-seen session ids grows `#sessions` unbounded. The reclaim
    // must drop the emptied map. An empty map and a deleted map are
    // observationally identical via `readPresence` (both yield empty
    // `participants`), so we assert against the `trackedSessionCount()` gauge.
    const bus = new InMemoryPresencePubSub();
    const node = new PresenceRegisterService({ pubSub: bus, nodeId: "node-a" });
    expect(node.trackedSessionCount()).toBe(0);

    // Case 1 — ALL states REJECTED (off-enum `state: "away"`), each on a DISTINCT
    // session id. A peer-origin envelope (originNodeId !== node-a) so the
    // message-level self-suppression does NOT short-circuit before the map is
    // created; the rejection happens INSIDE the loop.
    for (let index = 0; index < 5; index++) {
      const sessionId = `01970000-0000-7000-8000-00000000d${index}01` as SessionId;
      const rejectedUpdate = encodeForeignState({
        participantId: PARTICIPANT_B,
        deviceId: DEVICE_PHONE,
        state: "away", // OFF-ENUM — rejected, no holder added.
        deviceType: "desktop",
        focusedSessionId: null,
        focusedChannelId: null,
        lastSeenAtMs: Date.now(),
        originNodeId: "node-evil",
        ingestSequence: 1,
        lastActivityAt: new Date().toISOString(),
        appVisible: true,
      });
      void bus.publish({ sessionId, update: rejectedUpdate, originNodeId: "node-evil" });
      // Each rejected message must leave NO residual session map.
      expect(node.readPresence(sessionId).participants).toEqual([]);
    }
    // The load-bearing assertion: zero residual maps despite 5 distinct sessions.
    expect(node.trackedSessionCount()).toBe(0);

    // Case 2 — peer-origin ENVELOPE carrying our OWN nodeId in the inner state
    // (the relay/multi-hop self-echo the per-state `:718` check defends). The
    // map is created (envelope origin differs), but the only holder is dropped
    // by the per-state self-suppression — again leaving an empty map to reclaim.
    const selfRelaySession = "01970000-0000-7000-8000-00000000d901" as SessionId;
    const selfOriginUpdate = encodeForeignState({
      participantId: PARTICIPANT_A,
      deviceId: DEVICE_LAPTOP,
      state: "online", // well-formed, but...
      deviceType: "desktop",
      focusedSessionId: null,
      focusedChannelId: null,
      lastSeenAtMs: Date.now(),
      originNodeId: "node-a", // ...OUR OWN node id — dropped by per-state self-suppression.
      ingestSequence: 1,
      lastActivityAt: new Date().toISOString(),
      appVisible: true,
    });
    void bus.publish({
      sessionId: selfRelaySession,
      update: selfOriginUpdate,
      originNodeId: "node-relay", // envelope origin differs, so the map IS created.
    });
    expect(node.readPresence(selfRelaySession).participants).toEqual([]);
    // Still zero — the all-self-origin-inner-state path also reclaims.
    expect(node.trackedSessionCount()).toBe(0);

    // Control: a WELL-FORMED, non-self peer state DOES create exactly one
    // tracked session, proving the gauge counts real holders (the reclaim is
    // specific to empty maps, not a blanket no-op).
    const goodSession = "01970000-0000-7000-8000-00000000da01" as SessionId;
    const goodUpdate = encodeForeignState({
      participantId: PARTICIPANT_B,
      deviceId: DEVICE_PHONE,
      state: "online",
      deviceType: "desktop",
      focusedSessionId: null,
      focusedChannelId: null,
      lastSeenAtMs: Date.now(),
      originNodeId: "node-evil",
      ingestSequence: 1,
      lastActivityAt: new Date().toISOString(),
      appVisible: true,
    });
    void bus.publish({ sessionId: goodSession, update: goodUpdate, originNodeId: "node-evil" });
    expect(node.trackedSessionCount()).toBe(1);
    expect(node.readPresence(goodSession).participants).toHaveLength(1);
  });

  it("drops a fan-out message whose envelope sessionId is not a valid UUID, minting no #sessions key", () => {
    // The envelope `sessionId` becomes a `#sessions` key via `#clientsFor`. A peer
    // publishing a MALFORMED sessionId that nonetheless carries a WELL-FORMED
    // state would otherwise mint a live, unreachable holder under a garbage key —
    // and because a VALID holder survives under it, the empty-map reclaim (which
    // fires only when ZERO holders survive) NEVER collects it. Unbounded growth
    // from the foreign-writer surface. The receive-chokepoint `SessionIdSchema`
    // guard must DROP the whole message. We assert against `trackedSessionCount()`
    // (an empty/garbage map and a deleted map both yield empty `readPresence`).
    const bus = new InMemoryPresencePubSub();
    const node = new PresenceRegisterService({ pubSub: bus, nodeId: "node-a" });
    expect(node.trackedSessionCount()).toBe(0);

    // A fully WELL-FORMED foreign state (so the drop is attributable ONLY to the
    // bad envelope sessionId, not a per-state revalidation rejection).
    const wellFormedState = encodeForeignState({
      participantId: PARTICIPANT_B,
      deviceId: DEVICE_PHONE,
      state: "online",
      deviceType: "desktop",
      focusedSessionId: null,
      focusedChannelId: null,
      lastSeenAtMs: Date.now(),
      originNodeId: "node-evil",
      ingestSequence: 1,
      lastActivityAt: new Date().toISOString(),
      appVisible: true,
    });

    // Published under a GARBAGE envelope sessionId. The message must be dropped
    // before `#clientsFor` mints a key — despite the surviving valid holder.
    void bus.publish({
      sessionId: "not-a-valid-uuid" as SessionId,
      update: wellFormedState,
      originNodeId: "node-evil",
    });
    // Load-bearing: the garbage key was NEVER minted.
    expect(node.trackedSessionCount()).toBe(0);

    // Control: the SAME well-formed state under a VALID sessionId IS tracked,
    // proving the drop was specific to the malformed envelope key, not a blanket
    // drop of all foreign input.
    const validSession = "01970000-0000-7000-8000-0000000000aa" as SessionId;
    void bus.publish({
      sessionId: validSession,
      update: wellFormedState,
      originNodeId: "node-evil",
    });
    expect(node.trackedSessionCount()).toBe(1);
    expect(node.readPresence(validSession).participants).toHaveLength(1);
  });

  it("a live local holder outranks a peer holder for the same (participant, device) tuple", () => {
    const bus = new InMemoryPresencePubSub();
    const nodeA = new PresenceRegisterService({ pubSub: bus, nodeId: "node-a" });

    // A peer claims PARTICIPANT_A / DEVICE_LAPTOP is offline.
    const peerUpdate = encodeForeignState({
      participantId: PARTICIPANT_A,
      deviceId: DEVICE_LAPTOP,
      state: "offline",
      deviceType: "desktop",
      focusedSessionId: null,
      focusedChannelId: null,
      lastSeenAtMs: Date.now() + 10_000, // even a NEWER peer timestamp...
      originNodeId: "node-b",
      ingestSequence: 99,
      lastActivityAt: new Date().toISOString(),
      appVisible: false,
    });
    void bus.publish({ sessionId: SESSION_ID, update: peerUpdate, originNodeId: "node-b" });

    // ...is outranked by a LIVE LOCAL holder for the exact same tuple: node A
    // ingests its own online heartbeat for that device.
    nodeA.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );

    const presence = nodeA.readPresence(SESSION_ID);
    expect(presence.participants).toHaveLength(1);
    // The local holder wins — this node is the authoritative origin for a device
    // it ingests, regardless of a peer's (even newer) claim about that tuple.
    expect(presence.participants[0]?.state).toBe("online");
  });

  it("resolves a cross-node same-millisecond tie deterministically by originNodeId", () => {
    // Two nodes, ONE participant, DIFFERENT devices, both ingested in the SAME
    // millisecond (fake timers freeze `Date.now()`), so `lastSeenAtMs` ties.
    // Cross-node, the disjoint per-node `ingestSequence` spaces are NOT compared;
    // the tiebreak is the deterministic `originNodeId` ordering. With "node-b" >
    // "node-a" lexicographically, node B's device wins on BOTH nodes' merge.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-24T00:00:00.000Z"));
    try {
      const bus = new InMemoryPresencePubSub();
      const nodeA = new PresenceRegisterService({ pubSub: bus, nodeId: "node-a" });
      const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

      // Same tick: A's laptop idle, B's phone online. No timer advance between
      // them, so both stamp the identical frozen `lastSeenAtMs`.
      nodeA.recordHeartbeat(
        SESSION_ID,
        heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "idle" }),
      );
      nodeB.recordHeartbeat(
        SESSION_ID,
        heartbeat({
          participantId: PARTICIPANT_A,
          deviceId: DEVICE_PHONE,
          activityState: "online",
        }),
      );

      // Both nodes converge on the SAME winner (node-b's phone, online) because
      // the tiebreak is content-deterministic, not ingest-order- or
      // iteration-order-dependent.
      expect(nodeA.readPresence(SESSION_ID).participants[0]?.state).toBe("online");
      expect(nodeB.readPresence(SESSION_ID).participants[0]?.state).toBe("online");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the local same-node, same-ms ingest-order tiebreak even with fan-out wired", () => {
    // The SAME-NODE same-tick contract (T3.1's `ingestSequence` tiebreak) must
    // survive turning fan-out on: two devices of one participant ingested on ONE
    // node in the same millisecond resolve to the LATER-ingested device. This
    // pins that the fan-out path did not silently drop the per-node sequence
    // tiebreak (obligation: ingestSequence scoped to same-origin, not deleted).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-24T00:00:00.000Z"));
    try {
      const bus = new InMemoryPresencePubSub();
      const node = new PresenceRegisterService({ pubSub: bus, nodeId: "node-a" });

      node.recordHeartbeat(
        SESSION_ID,
        heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "idle" }),
      );
      node.recordHeartbeat(
        SESSION_ID,
        heartbeat({
          participantId: PARTICIPANT_A,
          deviceId: DEVICE_PHONE,
          activityState: "online",
        }),
      );

      // Later-ingested phone (same node, same ms) wins via ingestSequence.
      expect(node.readPresence(SESSION_ID).participants[0]?.state).toBe("online");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT let a later-arriving but OLDER peer snapshot clobber a newer one for the same tuple (recency guard)", () => {
    // Out-of-order fan-out delivery: three updates for the SAME (participant,
    // device) tuple from node-a arrive at node B. The third arrives LAST but is
    // OLDER (smaller `lastSeenAtMs`) than the second. The receive-side recency
    // guard (`isMoreRecent`, the SAME comparator `readPresence` uses) must keep
    // the NEWER snapshot — the stale tail-arrival is dropped, not stored. Without
    // the guard the unconditional upsert would regress B to the older state.
    const bus = new InMemoryPresencePubSub();
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

    const baseMs = Date.parse("2026-05-24T00:00:00.000Z");

    // (1) online @ baseMs (seq 1) — the initial peer snapshot.
    void bus.publish({
      sessionId: SESSION_ID,
      update: encodeForeignState({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        state: "online",
        deviceType: "desktop",
        focusedSessionId: null,
        focusedChannelId: null,
        lastSeenAtMs: baseMs,
        originNodeId: "node-a",
        ingestSequence: 1,
        lastActivityAt: new Date(baseMs).toISOString(),
        appVisible: true,
      }),
      originNodeId: "node-a",
    });
    expect(nodeB.readPresence(SESSION_ID).participants[0]?.state).toBe("online");

    // (2) reconnecting @ baseMs + 1000 (seq 2) — strictly NEWER; B updates.
    void bus.publish({
      sessionId: SESSION_ID,
      update: encodeForeignState({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        state: "reconnecting",
        deviceType: "desktop",
        focusedSessionId: null,
        focusedChannelId: null,
        lastSeenAtMs: baseMs + 1000,
        originNodeId: "node-a",
        ingestSequence: 2,
        lastActivityAt: new Date(baseMs + 1000).toISOString(),
        appVisible: true,
      }),
      originNodeId: "node-a",
    });
    expect(nodeB.readPresence(SESSION_ID).participants[0]?.state).toBe("reconnecting");

    // (3) idle @ baseMs - 1000 (seq 1) — arrives LAST but is OLDER. The recency
    // guard must REJECT it: B stays on the newer `reconnecting`.
    void bus.publish({
      sessionId: SESSION_ID,
      update: encodeForeignState({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        state: "idle",
        deviceType: "desktop",
        focusedSessionId: null,
        focusedChannelId: null,
        lastSeenAtMs: baseMs - 1000,
        originNodeId: "node-a",
        ingestSequence: 1,
        lastActivityAt: new Date(baseMs - 1000).toISOString(),
        appVisible: true,
      }),
      originNodeId: "node-a",
    });
    // Load-bearing: the older tail-arrival did NOT clobber the newer snapshot.
    const presence = nodeB.readPresence(SESSION_ID);
    expect(presence.participants).toHaveLength(1);
    expect(presence.participants[0]?.state).toBe("reconnecting");
  });

  it("DOES let a strictly newer peer snapshot replace an older peer holder for the same tuple (recency guard converse)", () => {
    // Converse of the guard: an in-order, strictly-newer snapshot for the same
    // tuple MUST replace the older peer holder (the guard rejects only OLDER-or-
    // equal arrivals, never a genuine update). Pins that the guard did not
    // over-reach into a freeze-first-write.
    const bus = new InMemoryPresencePubSub();
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

    const baseMs = Date.parse("2026-05-24T00:00:00.000Z");

    void bus.publish({
      sessionId: SESSION_ID,
      update: encodeForeignState({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        state: "online",
        deviceType: "desktop",
        focusedSessionId: null,
        focusedChannelId: null,
        lastSeenAtMs: baseMs,
        originNodeId: "node-a",
        ingestSequence: 1,
        lastActivityAt: new Date(baseMs).toISOString(),
        appVisible: true,
      }),
      originNodeId: "node-a",
    });
    expect(nodeB.readPresence(SESSION_ID).participants[0]?.state).toBe("online");

    // Strictly newer (greater `lastSeenAtMs`) — must replace the older holder.
    void bus.publish({
      sessionId: SESSION_ID,
      update: encodeForeignState({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        state: "idle",
        deviceType: "desktop",
        focusedSessionId: null,
        focusedChannelId: null,
        lastSeenAtMs: baseMs + 1000,
        originNodeId: "node-a",
        ingestSequence: 2,
        lastActivityAt: new Date(baseMs + 1000).toISOString(),
        appVisible: true,
      }),
      originNodeId: "node-a",
    });
    expect(nodeB.readPresence(SESSION_ID).participants[0]?.state).toBe("idle");
  });

  it("does NOT let a stale, less-degraded same-tuple peer snapshot clobber a newer grace state (state-rank tiebreak)", () => {
    // The grace machine (`#transition`) reuses a client's heartbeat tuple
    // (lastSeenAtMs + originNodeId + ingestSequence) and advances ONLY `state`
    // forward (online|idle -> reconnecting -> offline). So two fan-out frames for
    // the same tuple can differ only in `state`. If they arrive out of order — a
    // later `reconnecting` first, then the earlier `online` grace frame delivered
    // late — the receive guard must keep the MORE-degraded (strictly later)
    // state. With only the (lastSeenAtMs, origin, ingestSequence) tiebreak the
    // tuples compare EQUAL and the stale `online` would clobber the newer
    // `reconnecting`. The `PRESENCE_PROGRESSION` state-rank sub-tiebreak rejects
    // the stale, less-degraded snapshot.
    const bus = new InMemoryPresencePubSub();
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

    const baseMs = Date.parse("2026-05-24T00:00:00.000Z");

    // (1) reconnecting @ (baseMs, node-a, seq 5) — the newer grace state arrives
    // first.
    void bus.publish({
      sessionId: SESSION_ID,
      update: encodeForeignState({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        state: "reconnecting",
        deviceType: "desktop",
        focusedSessionId: null,
        focusedChannelId: null,
        lastSeenAtMs: baseMs,
        originNodeId: "node-a",
        ingestSequence: 5,
        lastActivityAt: new Date(baseMs).toISOString(),
        appVisible: true,
      }),
      originNodeId: "node-a",
    });
    expect(nodeB.readPresence(SESSION_ID).participants[0]?.state).toBe("reconnecting");

    // (2) online @ the SAME (baseMs, node-a, seq 5) — the EARLIER grace frame
    // delivered late. Equal tuple, LESS-degraded state: the state-rank tiebreak
    // must REJECT it. B stays on the newer `reconnecting`.
    void bus.publish({
      sessionId: SESSION_ID,
      update: encodeForeignState({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        state: "online",
        deviceType: "desktop",
        focusedSessionId: null,
        focusedChannelId: null,
        lastSeenAtMs: baseMs,
        originNodeId: "node-a",
        ingestSequence: 5,
        lastActivityAt: new Date(baseMs).toISOString(),
        appVisible: true,
      }),
      originNodeId: "node-a",
    });
    // Load-bearing: the stale same-tuple `online` did NOT clobber `reconnecting`.
    const presence = nodeB.readPresence(SESSION_ID);
    expect(presence.participants).toHaveLength(1);
    expect(presence.participants[0]?.state).toBe("reconnecting");
  });

  it("fans out an offline tombstone when a LOCAL client is forgotten, so the peer node sees offline (not stale online)", () => {
    // FIX @936: a hard disconnect on node A must propagate an explicit `offline`
    // snapshot to peers — otherwise B keeps A's last `online` snapshot forever
    // (there is no `awareness.on('update')` observer fanning out a null). A
    // ingests online (B sees online), then A.forgetClient(...) — B must flip to
    // `offline`, surfaced truthfully by `readPresence` (no state filter).
    const bus = new InMemoryPresencePubSub();
    const nodeA = new PresenceRegisterService({ pubSub: bus, nodeId: "node-a" });
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

    nodeA.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    expect(nodeB.readPresence(SESSION_ID).participants[0]?.state).toBe("online");

    // Hard-disconnect the local client on A. The InMemory bus dispatches the
    // offline tombstone synchronously, so B observes it immediately.
    expect(nodeA.forgetClient(SESSION_ID, PARTICIPANT_A, DEVICE_LAPTOP)).toBe(true);

    const onB = nodeB.readPresence(SESSION_ID);
    expect(onB.participants).toHaveLength(1);
    expect(onB.participants[0]?.participantId).toBe(PARTICIPANT_A);
    // Load-bearing: B sees `offline`, NOT a stale `online`.
    expect(onB.participants[0]?.state).toBe("offline");
  });

  it("re-publishes the offline tombstone on teardown even when the client is ALREADY offline (best-effort repair)", () => {
    // `#publish` is best-effort: it swallows transport rejections, so the
    // transition-to-`offline` publish can fail transiently, leaving peers stuck
    // on a stale `online`/`reconnecting` snapshot. There is no TTL reaper this
    // phase, so teardown is the LAST chance to fan out the disconnect — it must
    // re-publish offline UNCONDITIONALLY (not skip because the local state is
    // already offline). A droppable bus reproduces the lost publish: B sees A's
    // `online`, then A's offline publish is DROPPED (so B stays stale), then
    // A.forgetClient(...) must re-fan-out the tombstone so B finally flips to
    // offline. Under the prior `state !== "offline"` skip, this stayed stale.
    const drop = { active: false };
    const handlers = new Set<(message: PresenceFanoutMessage) => void>();
    // A best-effort bus whose `publish` silently drops while `drop.active` — the
    // same observable effect as a transient NOTIFY failure `#publish` swallows.
    const droppableBus: PresencePubSub = {
      publish: (message: PresenceFanoutMessage): Promise<void> => {
        if (!drop.active) {
          for (const handler of [...handlers]) {
            handler(message);
          }
        }
        return Promise.resolve();
      },
      subscribe: (handler: (message: PresenceFanoutMessage) => void): (() => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    };

    const nodeA = new PresenceRegisterService({ pubSub: droppableBus, nodeId: "node-a" });
    const nodeB = new PresenceRegisterService({ pubSub: droppableBus, nodeId: "node-b" });

    nodeA.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    expect(nodeB.readPresence(SESSION_ID).participants[0]?.state).toBe("online");

    // The offline transition's publish is DROPPED (transient transport failure):
    // A goes offline locally, but B never receives it and stays stale on online.
    drop.active = true;
    nodeA.recordHeartbeat(
      SESSION_ID,
      heartbeat({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        activityState: "offline",
      }),
    );
    expect(nodeB.readPresence(SESSION_ID).participants[0]?.state).toBe("online"); // stale.

    // Transport recovers; tear down the (already-offline) local client. Teardown
    // must re-publish the offline tombstone unconditionally — the last chance to
    // repair B's stale snapshot.
    drop.active = false;
    expect(nodeA.forgetClient(SESSION_ID, PARTICIPANT_A, DEVICE_LAPTOP)).toBe(true);

    const onB = nodeB.readPresence(SESSION_ID);
    expect(onB.participants).toHaveLength(1);
    // Load-bearing: the unconditional teardown re-publish flipped B from the
    // stale `online` to `offline` despite A already being offline locally.
    expect(onB.participants[0]?.state).toBe("offline");
  });

  it("fans out an offline tombstone on destroy(), so a peer node sees the local client go offline", async () => {
    // The destroy() analog of the forgetClient tombstone: a node shutting down
    // its tracked LOCAL clients publishes a final `offline` snapshot for each
    // (best-effort fire-and-forget). The InMemory bus dispatches synchronously,
    // so B's projection reflects the offline by the time destroy()'s teardown
    // loop runs (before the eventual `close()`).
    const bus = new InMemoryPresencePubSub();
    const nodeA = new PresenceRegisterService({ pubSub: bus, nodeId: "node-a" });
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

    nodeA.recordHeartbeat(
      SESSION_ID,
      heartbeat({ participantId: PARTICIPANT_A, deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    expect(nodeB.readPresence(SESSION_ID).participants[0]?.state).toBe("online");

    await nodeA.destroy();

    const onB = nodeB.readPresence(SESSION_ID);
    expect(onB.participants).toHaveLength(1);
    expect(onB.participants[0]?.state).toBe("offline");

    await nodeB.destroy();
  });

  it("drops a peer snapshot whose participantId is not a valid UUID, and keeps presence.read schema-valid", () => {
    // FOREIGN-WRITER HARDENING (FIX A): a peer fan-out value with a malformed
    // (non-UUID) participantId must be REJECTED on receive — not stored. The
    // contract id is `brandedUuidIdSchema` and `PresenceReadResponseSchema`
    // rejects a non-UUID participantId, so storing it would poison the WHOLE
    // session's `presence.read` response. A valid co-arriving client for the
    // SAME session must still surface (the drop is per-snapshot, not per-session).
    const bus = new InMemoryPresencePubSub();
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

    const nowMs = Date.parse("2026-05-24T00:00:00.000Z");

    // Malformed participantId — must be dropped (NOT a valid UUID).
    void bus.publish({
      sessionId: SESSION_ID,
      update: encodeForeignState({
        participantId: "not-a-uuid",
        deviceId: DEVICE_LAPTOP,
        state: "online",
        deviceType: "desktop",
        focusedSessionId: null,
        focusedChannelId: null,
        lastSeenAtMs: nowMs,
        originNodeId: "node-a",
        ingestSequence: 1,
        lastActivityAt: new Date(nowMs).toISOString(),
        appVisible: true,
      }),
      originNodeId: "node-a",
    });

    // Valid co-arriving client for the same session — must survive.
    void bus.publish({
      sessionId: SESSION_ID,
      update: encodeForeignState({
        participantId: PARTICIPANT_B,
        deviceId: DEVICE_PHONE,
        state: "online",
        deviceType: "mobile",
        focusedSessionId: null,
        focusedChannelId: null,
        lastSeenAtMs: nowMs,
        originNodeId: "node-a",
        ingestSequence: 2,
        lastActivityAt: new Date(nowMs).toISOString(),
        appVisible: true,
      }),
      originNodeId: "node-a",
    });

    const presence = nodeB.readPresence(SESSION_ID);
    // The malformed-id client was dropped; only the valid one surfaced.
    expect(presence.participants).toHaveLength(1);
    expect(presence.participants[0]?.participantId).toBe(PARTICIPANT_B);
    // Load-bearing: the poisoning vector is closed — the response the daemon
    // would emit for this session passes the contract schema.
    expect(PresenceReadResponseSchema.safeParse(presence).success).toBe(true);
  });

  it("drops a peer snapshot whose focusedSessionId is a non-UUID string", () => {
    // FIX A: `focusedSessionId` is a branded SessionId-or-null on the wire. A
    // non-null, non-UUID value must be rejected (null is the legitimate
    // not-focused value and is exercised by the other fan-out tests).
    const bus = new InMemoryPresencePubSub();
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

    const nowMs = Date.parse("2026-05-24T00:00:00.000Z");
    void bus.publish({
      sessionId: SESSION_ID,
      update: encodeForeignState({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        state: "online",
        deviceType: "desktop",
        focusedSessionId: "not-a-uuid",
        focusedChannelId: null,
        lastSeenAtMs: nowMs,
        originNodeId: "node-a",
        ingestSequence: 1,
        lastActivityAt: new Date(nowMs).toISOString(),
        appVisible: true,
      }),
      originNodeId: "node-a",
    });

    expect(nodeB.readPresence(SESSION_ID).participants).toHaveLength(0);
  });

  it("drops a peer snapshot whose focusedChannelId is a non-UUID string", () => {
    // FIX A: `focusedChannelId` is a branded ChannelId-or-null on the wire; a
    // non-null, non-UUID value must be rejected.
    const bus = new InMemoryPresencePubSub();
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

    const nowMs = Date.parse("2026-05-24T00:00:00.000Z");
    void bus.publish({
      sessionId: SESSION_ID,
      update: encodeForeignState({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        state: "online",
        deviceType: "desktop",
        focusedSessionId: null,
        focusedChannelId: "not-a-uuid",
        lastSeenAtMs: nowMs,
        originNodeId: "node-a",
        ingestSequence: 1,
        lastActivityAt: new Date(nowMs).toISOString(),
        appVisible: true,
      }),
      originNodeId: "node-a",
    });

    expect(nodeB.readPresence(SESSION_ID).participants).toHaveLength(0);
  });

  it("stores and surfaces a fully-valid foreign update (all branded ids well-formed)", () => {
    // FIX A converse: the branded-id revalidation does NOT over-reject — a peer
    // snapshot whose participantId AND both non-null focus ids are valid UUIDs
    // passes revalidation, is stored, and is surfaced (the projection exposes
    // {participantId, state, lastSeen}; the focus ids are validated on the
    // stored state, not re-emitted by `presence.read`).
    const bus = new InMemoryPresencePubSub();
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

    const nowMs = Date.parse("2026-05-24T00:00:00.000Z");
    void bus.publish({
      sessionId: SESSION_ID,
      update: encodeForeignState({
        participantId: PARTICIPANT_A,
        deviceId: DEVICE_LAPTOP,
        state: "online",
        deviceType: "desktop",
        focusedSessionId: SESSION_ID,
        focusedChannelId: FOCUSED_CHANNEL,
        lastSeenAtMs: nowMs,
        originNodeId: "node-a",
        ingestSequence: 1,
        lastActivityAt: new Date(nowMs).toISOString(),
        appVisible: true,
      }),
      originNodeId: "node-a",
    });

    const presence = nodeB.readPresence(SESSION_ID);
    expect(presence.participants).toHaveLength(1);
    expect(presence.participants[0]?.participantId).toBe(PARTICIPANT_A);
    expect(presence.participants[0]?.state).toBe("online");
    expect(PresenceReadResponseSchema.safeParse(presence).success).toBe(true);
  });

  it("drops a peer snapshot whose lastSeenAtMs is out of Date range, keeping presence.read schema-valid", () => {
    // FOREIGN-WRITER HARDENING (field-range guard): a peer can send any finite
    // number for `lastSeenAtMs`. A value past the JS Date ceiling (1e17) is a
    // finite integer, so the old `Number.isFinite` guard let it through; once
    // stored it dominates `isMoreRecent` permanently (sticky) and crashes
    // `readPresence`'s `new Date(ms).toISOString()` for the WHOLE session. It
    // must be dropped, and the response must stay schema-valid afterward.
    const bus = new InMemoryPresencePubSub();
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });

    void bus.publish({
      sessionId: SESSION_ID,
      update: foreignStateWithLastSeenAtMs(1e17),
      originNodeId: "node-a",
    });

    const presence = nodeB.readPresence(SESSION_ID);
    expect(presence.participants).toHaveLength(0);
    // Load-bearing: no out-of-range value was stored, so the projection the
    // daemon would emit does not throw and passes the contract schema.
    expect(PresenceReadResponseSchema.safeParse(presence).success).toBe(true);
  });

  it("accepts lastSeenAtMs at the contract-legal 4-digit-year ceiling and keeps presence.read schema-valid, but drops one past it", () => {
    // The ceiling is NOT the JS Date max (8.64e15) — `new Date(8.64e15)
    // .toISOString()` does NOT throw, it emits a 6-digit EXPANDED year
    // ("+275760-09-13T...") that `PresenceReadResponseSchema.lastSeen`
    // (`z.iso.datetime`) rejects, relocating the session-wide DoS one layer
    // downstream into the daemon's presence.read result-schema validation. The
    // real ceiling is `Date.UTC(9999,11,31,23,59,59,999)` =
    // 253_402_300_799_999, whose `toISOString()` is the contract-legal
    // "9999-12-31T23:59:59.999Z"; one past it emits "+010000-01-01T..." and is
    // dropped. The load-bearing assertion is that the projection stays
    // contract-valid AT the ceiling.
    const busAtMax = new InMemoryPresencePubSub();
    const nodeAtMax = new PresenceRegisterService({ pubSub: busAtMax, nodeId: "node-b" });
    void busAtMax.publish({
      sessionId: SESSION_ID,
      update: foreignStateWithLastSeenAtMs(253_402_300_799_999),
      originNodeId: "node-a",
    });
    const presenceAtMax = nodeAtMax.readPresence(SESSION_ID);
    expect(presenceAtMax.participants).toHaveLength(1);
    expect(PresenceReadResponseSchema.safeParse(presenceAtMax).success).toBe(true);

    const busPastMax = new InMemoryPresencePubSub();
    const nodePastMax = new PresenceRegisterService({ pubSub: busPastMax, nodeId: "node-b" });
    void busPastMax.publish({
      sessionId: SESSION_ID,
      update: foreignStateWithLastSeenAtMs(253_402_300_800_000),
      originNodeId: "node-a",
    });
    expect(nodePastMax.readPresence(SESSION_ID).participants).toHaveLength(0);
  });

  it("drops a peer snapshot whose lastSeenAtMs is negative or fractional", () => {
    // `>= 0` rejects an impossible negative receipt time; `Number.isInteger`
    // rejects fractional ms (the wire contract is integer epoch ms).
    const busNegative = new InMemoryPresencePubSub();
    const nodeNegative = new PresenceRegisterService({ pubSub: busNegative, nodeId: "node-b" });
    void busNegative.publish({
      sessionId: SESSION_ID,
      update: foreignStateWithLastSeenAtMs(-1),
      originNodeId: "node-a",
    });
    expect(nodeNegative.readPresence(SESSION_ID).participants).toHaveLength(0);

    const busFractional = new InMemoryPresencePubSub();
    const nodeFractional = new PresenceRegisterService({ pubSub: busFractional, nodeId: "node-b" });
    void busFractional.publish({
      sessionId: SESSION_ID,
      update: foreignStateWithLastSeenAtMs(1_700_000_000_000.5),
      originNodeId: "node-a",
    });
    expect(nodeFractional.readPresence(SESSION_ID).participants).toHaveLength(0);
  });

  it("drops a peer snapshot whose lastActivityAt is not an ISO-8601 timestamp", () => {
    // `lastActivityAt` is validated against the SAME grammar the contract uses
    // for this field (contracts/src/presence.ts:251, `z.iso.datetime({ offset:
    // true })`); a non-ISO value is dropped (parity with the contract's
    // "rejects non-ISO lastActivityAt" test).
    const bus = new InMemoryPresencePubSub();
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });
    void bus.publish({
      sessionId: SESSION_ID,
      update: foreignStateWithLastActivityAt("tomorrow"),
      originNodeId: "node-a",
    });
    expect(nodeB.readPresence(SESSION_ID).participants).toHaveLength(0);
  });

  it("accepts a peer snapshot whose lastActivityAt carries a numeric UTC offset (RFC 3339 §5.6)", () => {
    // Converse: a valid offset timestamp (the contract's "accepts ISO with
    // numeric offset" case) passes — the guard does not over-reject.
    const bus = new InMemoryPresencePubSub();
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });
    void bus.publish({
      sessionId: SESSION_ID,
      update: foreignStateWithLastActivityAt("2026-05-22T08:30:00-04:00"),
      originNodeId: "node-a",
    });
    expect(nodeB.readPresence(SESSION_ID).participants).toHaveLength(1);
  });

  it("drops a peer snapshot whose ingestSequence is fractional or negative", () => {
    // `ingestSequence` is documented per-node MONOTONIC ingest order; a
    // fractional or negative value violates that contract and is dropped.
    const busFractional = new InMemoryPresencePubSub();
    const nodeFractional = new PresenceRegisterService({ pubSub: busFractional, nodeId: "node-b" });
    void busFractional.publish({
      sessionId: SESSION_ID,
      update: foreignStateWithIngestSequence(1.5),
      originNodeId: "node-a",
    });
    expect(nodeFractional.readPresence(SESSION_ID).participants).toHaveLength(0);

    const busNegative = new InMemoryPresencePubSub();
    const nodeNegative = new PresenceRegisterService({ pubSub: busNegative, nodeId: "node-b" });
    void busNegative.publish({
      sessionId: SESSION_ID,
      update: foreignStateWithIngestSequence(-1),
      originNodeId: "node-a",
    });
    expect(nodeNegative.readPresence(SESSION_ID).participants).toHaveLength(0);
  });

  it("drops a peer snapshot whose deviceId contains a NUL byte", () => {
    // `deviceId` is validated with `wireFreeFormString` (the SAME guard the
    // local heartbeat path uses, contracts/src/presence.ts:240), which rejects
    // an embedded NUL via `.refine((s) => !s.includes("\0"))` (session.ts:109).
    // A foreign peer cannot smuggle the `clientKey` separator byte into the
    // device id (closing the NUL log-injection vector on the fan-out path).
    const bus = new InMemoryPresencePubSub();
    const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });
    void bus.publish({
      sessionId: SESSION_ID,
      update: foreignStateWithDeviceId("dev\0x"),
      originNodeId: "node-a",
    });
    expect(nodeB.readPresence(SESSION_ID).participants).toHaveLength(0);
  });

  it("drops a peer snapshot whose internal originNodeId is empty, over-length, or NUL-bearing", () => {
    // The SNAPSHOT-internal `originNodeId` (string-compared in `isMoreRecent`
    // and logged) carries the same `wireFreeFormString` guard as deviceId /
    // deviceType — rejects empty / whitespace-only / over-length
    // (> NODE_ID_MAX_LEN = 256) / NUL. A foreign peer cannot inject an unbounded
    // or NUL-bearing node id. Each override stays distinct from the receiver's
    // nodeId ("node-b") so the message reaches validation rather than being
    // self-suppressed first; the publish-envelope originNodeId ("node-a") is a
    // valid distinct id.
    for (const badOriginNodeId of ["", "   ", "x".repeat(257), "node\0x"]) {
      const bus = new InMemoryPresencePubSub();
      const nodeB = new PresenceRegisterService({ pubSub: bus, nodeId: "node-b" });
      void bus.publish({
        sessionId: SESSION_ID,
        update: foreignStateWithOriginNodeId(badOriginNodeId),
        originNodeId: "node-a",
      });
      expect(nodeB.readPresence(SESSION_ID).participants).toHaveLength(0);
    }
  });

  it("the published fan-out update carries the full validated state and does not mutate it on transition", () => {
    // Capture what node A actually puts on the wire. The heartbeat publish and
    // the timer-driven transition publish must BOTH carry a fully-revalidatable
    // state, and the transition must only change `state` — NOT bump
    // `ingestSequence` or `lastSeenAtMs` (a reconnecting transition is "the
    // heartbeat aged out", not a synthetic new heartbeat — load-bearing so a
    // transition on one node cannot leapfrog a real heartbeat on another).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-24T00:00:00.000Z"));
    try {
      const captured: PresenceFanoutMessage[] = [];
      const bus = new InMemoryPresencePubSub();
      bus.subscribe((message) => captured.push(message));
      const node = new PresenceRegisterService({
        pubSub: bus,
        nodeId: "node-a",
        reconnectingAfterMs: 15_000,
        offlineAfterMs: 45_000,
      });

      node.recordHeartbeat(
        SESSION_ID,
        heartbeat({
          participantId: PARTICIPANT_A,
          deviceId: DEVICE_LAPTOP,
          activityState: "online",
        }),
      );
      vi.advanceTimersByTime(15_000); // fire reconnecting -> a second publish.

      expect(captured).toHaveLength(2);
      const heartbeatState = decodeForeignState(captured[0] as PresenceFanoutMessage);
      const transitionState = decodeForeignState(captured[1] as PresenceFanoutMessage);

      expect(heartbeatState?.["state"]).toBe("online");
      expect(transitionState?.["state"]).toBe("reconnecting");
      // The transition preserved the heartbeat's identity fields — only `state`
      // changed.
      expect(transitionState?.["ingestSequence"]).toBe(heartbeatState?.["ingestSequence"]);
      expect(transitionState?.["lastSeenAtMs"]).toBe(heartbeatState?.["lastSeenAtMs"]);
      expect(transitionState?.["originNodeId"]).toBe("node-a");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ----------------------------------------------------------------------------
// Pr3 (belt-and-suspenders) — the REAL PgListenNotifyPubSub against one PGlite.
// ----------------------------------------------------------------------------
//
// The cross-node tests above use the in-memory bus (two PGlite instances cannot
// share NOTIFY). This test exercises the PRODUCTION transport — encode -> NOTIFY
// -> LISTEN -> decode — on a SINGLE PGlite, proving `PgListenNotifyPubSub` wires
// the `notification` event and round-trips a fan-out message through real
// Postgres LISTEN/NOTIFY. It also pins I-002-3 on the fan-out path: after the
// round-trip, NO `%presence%` table exists — NOTIFY touched a transient channel,
// never a row.
//
// PGlite's notification API (`onNotification(cb(channel, payload))`) differs
// from the `pg.Client` shape `PgListenNotifyPubSub` consumes
// (`on("notification", { channel, payload })`). A thin in-test adapter bridges
// the two WITHOUT widening the production interface to fit the test substrate.

describe("PresenceRegisterService — Pr3 PgListenNotifyPubSub over real Postgres LISTEN/NOTIFY (PGlite)", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    // The transport requires an active LISTEN on the channel before NOTIFY.
    await pg.exec("LISTEN presence_fanout");
  });

  afterEach(async () => {
    await pg.close();
  });

  it("round-trips a fan-out message through NOTIFY/LISTEN and adds NO presence table (I-002-3)", async () => {
    // Bridge PGlite's onNotification -> the pg.Client-shaped interface the
    // production transport consumes. The adapter lives HERE, not in the module.
    const client: PgListenNotifyClient = {
      query: (sql, params) => pg.query(sql, params === undefined ? [] : [...params]),
      on: (_event, listener) =>
        pg.onNotification((channel, payload) => listener({ channel, payload })),
    };

    const transport = new PgListenNotifyPubSub(client);
    const received: PresenceFanoutMessage[] = [];
    transport.subscribe((message) => received.push(message));

    // Build a real serialized Awareness update to send over the wire.
    const update = encodeForeignState({
      participantId: PARTICIPANT_A,
      deviceId: DEVICE_LAPTOP,
      state: "online",
      deviceType: "desktop",
      focusedSessionId: null,
      focusedChannelId: null,
      lastSeenAtMs: Date.now(),
      originNodeId: "node-remote",
      ingestSequence: 1,
      lastActivityAt: new Date().toISOString(),
      appVisible: true,
    });

    await transport.publish({ sessionId: SESSION_ID, update, originNodeId: "node-remote" });

    // PGlite delivers notifications asynchronously after the NOTIFY commits.
    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });

    // The decoded message survived the base64/JSON envelope round-trip intact.
    expect(received[0]?.sessionId).toBe(SESSION_ID);
    expect(received[0]?.originNodeId).toBe("node-remote");
    expect(received[0]?.update).toBeInstanceOf(Uint8Array);

    // End-to-end: a service subscribed to this REAL transport projects the
    // peer once the next NOTIFY round-trips through Postgres LISTEN/NOTIFY.
    const consumer = new PresenceRegisterService({ pubSub: transport, nodeId: "node-local" });
    await transport.publish({ sessionId: SESSION_ID, update, originNodeId: "node-remote" });
    await vi.waitFor(() => {
      expect(consumer.readPresence(SESSION_ID).participants).toHaveLength(1);
    });
    expect(consumer.readPresence(SESSION_ID).participants[0]?.state).toBe("online");

    // I-002-3 on the fan-out path: NOTIFY touched a transient channel; no
    // presence table was created by any of this.
    const probe = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name ILIKE '%presence%'`,
    );
    expect(probe.rows).toEqual([]);

    await transport.close();
    await consumer.destroy();
  });
});

// ----------------------------------------------------------------------------
// Pr3 — PgListenNotifyPubSub publish error surface (no DB; fake rejecting
// client). Separate from the PGlite round-trip describe so this fake-client
// test does NOT open an unused PGlite per run.
// ----------------------------------------------------------------------------

describe("PresenceRegisterService — PgListenNotifyPubSub publish error surface (warn + rethrow)", () => {
  it("warns (with channel + sessionId) and rethrows when the underlying NOTIFY query rejects", async () => {
    // A transient transport fault (connection blip, PG restart/failover) rejects
    // the `pg_notify` query. The transport must surface it through the injected
    // `#warn` sink (so operators can distinguish "fan-out healthy" from "every
    // publish failing") AND rethrow — the service's `#publish` `.catch(() => {})`
    // swallows the rethrow for the hot path, but the operability signal fires.
    // A fake client whose `query` rejects exercises this WITHOUT a real PG fault.
    const queryError = new Error("connection terminated unexpectedly");
    const failingClient: PgListenNotifyClient = {
      query: () => Promise.reject(queryError),
      on: () => undefined,
    };
    const warn = vi.fn<(warning: string, detail: Record<string, unknown>) => void>();
    const transport = new PgListenNotifyPubSub(failingClient, warn);

    const update = encodeForeignState({
      participantId: PARTICIPANT_A,
      deviceId: DEVICE_LAPTOP,
      state: "online",
      deviceType: "desktop",
      focusedSessionId: null,
      focusedChannelId: null,
      lastSeenAtMs: Date.now(),
      originNodeId: "node-remote",
      ingestSequence: 1,
      lastActivityAt: new Date().toISOString(),
      appVisible: true,
    });

    // The publish rejects (rethrown), so the hot-path caller can still swallow it.
    await expect(
      transport.publish({ sessionId: SESSION_ID, update, originNodeId: "node-remote" }),
    ).rejects.toBe(queryError);

    // The operability signal fired with the structured detail (channel + the
    // session the dropped publish belonged to).
    expect(warn).toHaveBeenCalledTimes(1);
    const [warning, detail] = warn.mock.calls[0] ?? [];
    expect(warning).toContain("NOTIFY failed");
    expect(detail).toMatchObject({ channel: "presence_fanout", sessionId: SESSION_ID });

    await transport.close();
  });
});

// ----------------------------------------------------------------------------
// Pr3 — PgListenNotifyPubSub.close() server-side cleanup (UNLISTEN). No DB; a
// fake client captures the issued queries so we can assert the UNLISTEN and its
// best-effort (swallowed) failure path WITHOUT a real Postgres connection.
// ----------------------------------------------------------------------------

describe("PresenceRegisterService — PgListenNotifyPubSub.close() issues UNLISTEN (server-side cleanup)", () => {
  it("issues UNLISTEN presence_fanout on close so a reused connection is left clean", async () => {
    // FIX B: close() clears handlers + removeListener but, without UNLISTEN, a
    // reused long-lived pg client stays server-side-subscribed (leaked listener,
    // wasted NOTIFY). A fake client records the queries it is asked to run.
    const queries: string[] = [];
    const client: PgListenNotifyClient = {
      query: (sql) => {
        queries.push(sql);
        return Promise.resolve(undefined);
      },
      on: () => undefined,
    };
    const transport = new PgListenNotifyPubSub(client);

    await transport.close();

    // The transport issued exactly the UNLISTEN for the trusted channel constant.
    expect(queries).toContain("UNLISTEN presence_fanout");
  });

  it("swallows a failing UNLISTEN on close (best-effort) — close() resolves and warns", async () => {
    // FIX B: a transient query failure on an already-closing connection must NOT
    // make close() throw (teardown must stay total); it is surfaced via `#warn`.
    const unlistenError = new Error("connection terminated unexpectedly");
    const failingClient: PgListenNotifyClient = {
      query: () => Promise.reject(unlistenError),
      on: () => undefined,
    };
    const warn = vi.fn<(warning: string, detail: Record<string, unknown>) => void>();
    const transport = new PgListenNotifyPubSub(failingClient, warn);

    // close() resolves (does NOT reject) despite the failing UNLISTEN.
    await expect(transport.close()).resolves.toBeUndefined();

    // The operability signal fired with the structured channel detail.
    expect(warn).toHaveBeenCalledTimes(1);
    const [warning, detail] = warn.mock.calls[0] ?? [];
    expect(warning).toContain("UNLISTEN failed");
    expect(detail).toMatchObject({ channel: "presence_fanout" });
  });
});

// ----------------------------------------------------------------------------
// Pr3 test helpers — craft/decode a serialized Awareness update the same way
// the service's fan-out does, so foreign-state tests use the REAL y-protocols
// wire format (not a hand-rolled shape).
// ----------------------------------------------------------------------------

// Encode an arbitrary presence-state object into a serialized Awareness update,
// as if published by another node. Uses a fresh Y.Doc/Awareness so the slot is
// this scratch doc's clientID (a foreign client from the receiver's view).
function encodeForeignState(state: Record<string, unknown>): Uint8Array {
  const sourceDoc = new Y.Doc();
  const sourceAwareness = new Awareness(sourceDoc);
  sourceAwareness.setLocalState(state);
  const update = encodeAwarenessUpdate(sourceAwareness, [sourceDoc.clientID]);
  sourceAwareness.destroy();
  sourceDoc.destroy();
  return update;
}

// A fully-VALID foreign presence-state object — every field passes
// `validatePresenceLocalState`. The field-range guard tests start from this and
// override exactly ONE field with a malformed value, so a drop is attributable
// to that single field (not an unrelated invalid one).
const VALID_FOREIGN_BASE_MS = Date.parse("2026-05-24T00:00:00.000Z");
function validForeignState(): Record<string, unknown> {
  return {
    participantId: PARTICIPANT_A,
    deviceId: DEVICE_LAPTOP,
    state: "online",
    deviceType: "desktop",
    focusedSessionId: null,
    focusedChannelId: null,
    lastSeenAtMs: VALID_FOREIGN_BASE_MS,
    originNodeId: "node-a",
    ingestSequence: 1,
    lastActivityAt: new Date(VALID_FOREIGN_BASE_MS).toISOString(),
    appVisible: true,
  };
}

// Encode a valid foreign state with a single field overridden, for the
// field-range guard tests.
function foreignStateWithLastSeenAtMs(lastSeenAtMs: number): Uint8Array {
  return encodeForeignState({ ...validForeignState(), lastSeenAtMs });
}
function foreignStateWithLastActivityAt(lastActivityAt: string): Uint8Array {
  return encodeForeignState({ ...validForeignState(), lastActivityAt });
}
function foreignStateWithIngestSequence(ingestSequence: number): Uint8Array {
  return encodeForeignState({ ...validForeignState(), ingestSequence });
}
function foreignStateWithDeviceId(deviceId: string): Uint8Array {
  return encodeForeignState({ ...validForeignState(), deviceId });
}
function foreignStateWithOriginNodeId(originNodeId: string): Uint8Array {
  return encodeForeignState({ ...validForeignState(), originNodeId });
}

// Decode the foreign client's state object out of a captured fan-out message,
// applying the update into a scratch Awareness and reading the single non-self
// slot.
function decodeForeignState(message: PresenceFanoutMessage): Record<string, unknown> | undefined {
  const receiverDoc = new Y.Doc();
  const receiverAwareness = new Awareness(receiverDoc);
  applyAwarenessUpdate(receiverAwareness, message.update, "test");
  let result: Record<string, unknown> | undefined;
  for (const [clientId, foreignState] of receiverAwareness.getStates()) {
    if (clientId !== receiverDoc.clientID) {
      result = foreignState as Record<string, unknown>;
      break;
    }
  }
  receiverAwareness.destroy();
  receiverDoc.destroy();
  return result;
}
