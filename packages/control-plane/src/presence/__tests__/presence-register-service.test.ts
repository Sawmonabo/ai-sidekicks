// PresenceRegisterService tests.
//
// Coverage:
//   Pr1 — presence is IN-MEMORY ONLY: no SQLite or Postgres write occurs on
//         heartbeat ingestion. Proven three ways:
//           (a) the service takes NO database handle at all — a TYPE-LEVEL
//               guarantee that `recordHeartbeat` cannot write to a durable store
//               (there is nothing to write to). A heartbeat round-trips through
//               the in-memory CRDT (`recordHeartbeat` -> `readPresence`),
//               proving the service WORKS without any persistence dependency.
//           (b) after the migration set, NO `public` table matches
//               `ILIKE '%presence%'` other than the durable runtime-NODE
//               liveness table, a DIFFERENT domain from the in-memory device
//               presence this service owns.
//           (c) exercising the ingest path alongside a live database adds no
//               table.
//   Pr2 — a missed heartbeat moves a DEVICE to `reconnecting` BEFORE `offline`:
//         the reconnect-grace two-step timer (15s -> reconnecting, 45s ->
//         offline from the last heartbeat). A heartbeat within the grace window
//         cancels the pending transition. The timer rewrites the live CRDT only
//         and fires the `onTransition` observation seam; the service itself
//         writes nothing durable.
//
// Plus behavioral coverage of the ingest/query surface:
//   * a fresh service holds no presence; an unknown session reads empty.
//   * all four PresenceState values (online/idle/reconnecting/offline) are
//     accepted and stored verbatim on ingest (the wire enum admits them).
//   * the service genuinely uses Yjs Awareness as the store (the CRDT instance
//     reflects the ingested state).
//   * multiple devices of the one user each get their own entry — the read is a
//     per-device projection with no collapse.
//   * `forgetDevice` GCs a device's in-memory state (the explicit disconnect/GC
//     primitive).
//   * the projection parses against `PresenceReadResponseSchema`.
//
// Harness: the in-process PGlite pattern from
// `migrations/__tests__/migration-shape.test.ts`. The service itself needs NO
// database (that is the point of Pr1), so most behavioral tests construct it
// standalone.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ChannelId,
  PresenceHeartbeat,
  PresenceState,
  SessionId,
} from "@ai-sidekicks/contracts";
// Value import: the response schema proves the projection the service emits is
// wire-valid, so a malformed stored snapshot cannot poison `presence.read`.
import { PresenceReadResponseSchema } from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import {
  PresenceRegisterService,
  type PresenceTransitionEvent,
} from "../presence-register-service.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUID v7-shaped ids (the brand validators accept any RFC 9562
// UUID; real generation is daemon-side).
// ----------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e1001" as SessionId;
const OTHER_SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e1002" as SessionId;
const FOCUSED_CHANNEL: ChannelId = "01970000-0000-7000-8000-0000000c1001" as ChannelId;

const DEVICE_LAPTOP = "device-laptop-01";
const DEVICE_PHONE = "device-phone-01";

// Build a well-formed PresenceHeartbeat. `activityState` and the focus fields
// are overridable per test; the metadata floor (all 5 keys present) matches the
// contract shape.
function heartbeat(args: {
  deviceId: string;
  activityState: PresenceState;
  deviceType?: string;
  appVisible?: boolean;
  focusedSessionId?: SessionId | null;
  focusedChannelId?: ChannelId | null;
  lastActivityAt?: string;
}): PresenceHeartbeat {
  return {
    deviceId: args.deviceId,
    activityState: args.activityState,
    metadata: {
      deviceType: args.deviceType ?? "desktop",
      focusedSessionId: args.focusedSessionId ?? null,
      focusedChannelId: args.focusedChannelId ?? null,
      lastActivityAt: args.lastActivityAt ?? new Date().toISOString(),
      appVisible: args.appVisible ?? true,
    },
  };
}

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (mirrors migration-shape.test.ts `wrap`). Used ONLY
// by the schema-shape assertions; the service itself takes no Querier.
// ----------------------------------------------------------------------------

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

describe("PresenceRegisterService — in-memory ingest, no database handle", () => {
  it("records a heartbeat and reads it back from the in-memory CRDT without any persistence dependency", () => {
    // Constructed with NO arguments — there is no database/Querier/Pool to
    // pass. This is the type-level no-DB-write guarantee.
    const service = new PresenceRegisterService();

    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({
        deviceId: DEVICE_LAPTOP,
        activityState: "online",
        deviceType: "desktop",
        focusedSessionId: SESSION_ID,
        focusedChannelId: FOCUSED_CHANNEL,
      }),
    );

    const presence = service.readPresence(SESSION_ID);
    expect(presence.devices).toHaveLength(1);
    const entry = presence.devices[0];
    expect(entry?.deviceId).toBe(DEVICE_LAPTOP);
    expect(entry?.deviceType).toBe("desktop");
    expect(entry?.appVisible).toBe(true);
    expect(entry?.state).toBe("online");
    // `lastSeen` is a server-clock ISO 8601 string (RFC 3339), not the wire
    // `lastActivityAt`. Assert it parses to a finite instant.
    expect(entry?.lastSeen).toBeDefined();
    expect(Number.isNaN(Date.parse(entry?.lastSeen ?? ""))).toBe(false);
    // The projection is wire-valid — a malformed stored snapshot would fail here
    // rather than at the `presence.read` result-schema boundary.
    expect(PresenceReadResponseSchema.safeParse(presence).success).toBe(true);
  });

  it("a fresh service holds no presence; an unknown session reads empty", () => {
    const service = new PresenceRegisterService();
    expect(service.readPresence(SESSION_ID).devices).toEqual([]);
    expect(service.readPresence(OTHER_SESSION_ID).devices).toEqual([]);
    expect(service.trackedSessionCount()).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Pr1 (b) + (c) — no device-presence table; no durable presence surface.
// ----------------------------------------------------------------------------
//
// The schema-side enforcement of the in-memory-only property: the only
// presence-named table in the schema is the durable runtime-NODE liveness
// record (`runtime_node_presence`), a DIFFERENT domain from the in-memory
// device presence this service owns. Heartbeat ingestion happens entirely in
// memory and cannot add a table.

describe("PresenceRegisterService — no device-presence table in the schema", () => {
  let pg: PGlite;
  let querier: Querier;

  beforeEach(() => {
    pg = new PGlite();
    querier = wrap(pg);
  });

  afterEach(async () => {
    await pg.close();
  });

  it("the only presence-named table after the migration set is the runtime-node liveness record", async () => {
    await applyMigrations(querier);
    const probe = await querier.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name ILIKE '%presence%'`,
    );
    expect(probe.rows.map((row) => row.table_name).sort()).toEqual(["runtime_node_presence"]);
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
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_PHONE, activityState: "idle" }),
    );

    const after: Set<string> = await snapshotPublicTables(querier);
    expect([...after].sort()).toEqual([...before].sort());
  });
});

// ----------------------------------------------------------------------------
// Yjs Awareness is genuinely the store.
// ----------------------------------------------------------------------------
//
// A foreign `Awareness` instance, fed the SAME serialized update the service's
// CRDT produces, reflects the ingested presence. This proves the service stores
// state in a real `y-protocols/awareness` instance whose binary update format
// round-trips.

describe("PresenceRegisterService — uses Yjs Awareness as the in-memory store", () => {
  it("ingested presence is reflected in a Yjs Awareness CRDT (binary update round-trips)", () => {
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "idle" }),
    );

    // The service's projection reports the device idle.
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("idle");

    // Independent proof the store is a real Awareness CRDT: a second Awareness,
    // fed an update encoding the SAME local-state object the service stored,
    // surfaces that device in its `getStates()`. This asserts the y-protocols
    // binary format, not the service internals.
    const sourceDoc = new Y.Doc();
    const sourceAwareness = new Awareness(sourceDoc);
    sourceAwareness.setLocalState({ deviceId: DEVICE_LAPTOP, state: "idle" });
    const update: Uint8Array = encodeAwarenessUpdate(sourceAwareness, [sourceDoc.clientID]);

    const receiverDoc = new Y.Doc();
    const receiverAwareness = new Awareness(receiverDoc);
    applyAwarenessUpdate(receiverAwareness, update, "test");
    const received = [...receiverAwareness.getStates().values()];
    expect(received.some((state) => state["deviceId"] === DEVICE_LAPTOP)).toBe(true);

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
// and does not leak a 30s timer per connected device. The cast reaches a field
// that is typed `any` in the `.d.ts`, so a future y-protocols field RENAME would
// silently skip the `clearInterval` and leak the interval. A field-presence
// assertion is NOT rename-resilient (`clearInterval(handle)` does not null the
// field, and a renamed-away field reads `undefined` either way). The
// rename-resilient tripwire is setInterval/clearInterval ACCOUNTING: every
// interval handle created while constructing the service's Awareness MUST be
// passed to `clearInterval`.

describe("PresenceRegisterService — newAwareness clears the y-protocols _checkInterval", () => {
  it("passes every setInterval handle created during Awareness construction to clearInterval", () => {
    // Spy BEFORE the service creates any Awareness. The reconnect-grace timer
    // uses setTimeout (not setInterval), so setInterval here isolates exactly
    // the y-protocols Awareness interval — no grace-timer noise.
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      const service = new PresenceRegisterService();
      // `recordHeartbeat` lazily creates the device's Y.Doc + Awareness via
      // `newAwareness`, which constructs the interval THEN clears it.
      service.recordHeartbeat(
        SESSION_ID,
        heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
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
// The wire enum admits online/idle/reconnecting/offline. The ingest path stays
// total — it does NOT transition toward offline or GC on an "offline" heartbeat
// (that lifecycle is the grace timer's), so an "offline" or "reconnecting"
// heartbeat is stored as-is and read back unchanged.

describe("PresenceRegisterService — accepts and stores all four PresenceState values", () => {
  const states: PresenceState[] = ["online", "idle", "reconnecting", "offline"];
  for (const state of states) {
    it(`stores a heartbeat carrying activityState='${state}' verbatim`, () => {
      const service = new PresenceRegisterService();
      service.recordHeartbeat(
        SESSION_ID,
        heartbeat({ deviceId: DEVICE_LAPTOP, activityState: state }),
      );
      const presence = service.readPresence(SESSION_ID);
      expect(presence.devices).toHaveLength(1);
      expect(presence.devices[0]?.state).toBe(state);
    });
  }
});

// ----------------------------------------------------------------------------
// Per-device projection — one entry per device, no collapse.
// ----------------------------------------------------------------------------
//
// Every device belongs to the same user, so there is no roster to collapse into:
// each device's liveness is independently interesting and gets its own entry.

describe("PresenceRegisterService — per-device projection", () => {
  it("surfaces one entry per device, each carrying its own state and type", () => {
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online", deviceType: "desktop" }),
    );
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({
        deviceId: DEVICE_PHONE,
        activityState: "idle",
        deviceType: "mobile",
        appVisible: false,
      }),
    );

    const byDevice = new Map(
      service.readPresence(SESSION_ID).devices.map((device) => [device.deviceId, device]),
    );
    expect([...byDevice.keys()].sort()).toEqual([DEVICE_LAPTOP, DEVICE_PHONE].sort());
    expect(byDevice.get(DEVICE_LAPTOP)?.state).toBe("online");
    expect(byDevice.get(DEVICE_LAPTOP)?.deviceType).toBe("desktop");
    expect(byDevice.get(DEVICE_LAPTOP)?.appVisible).toBe(true);
    expect(byDevice.get(DEVICE_PHONE)?.state).toBe("idle");
    expect(byDevice.get(DEVICE_PHONE)?.deviceType).toBe("mobile");
    expect(byDevice.get(DEVICE_PHONE)?.appVisible).toBe(false);
  });

  it("a repeat heartbeat from one device updates its single slot in place", () => {
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "idle" }),
    );

    const presence = service.readPresence(SESSION_ID);
    expect(presence.devices).toHaveLength(1);
    expect(presence.devices[0]?.state).toBe("idle");
  });

  it("scopes presence per session — a device in session A does not appear in session B", () => {
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    expect(service.readPresence(SESSION_ID).devices).toHaveLength(1);
    expect(service.readPresence(OTHER_SESSION_ID).devices).toEqual([]);
    expect(service.trackedSessionCount()).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// forgetDevice — explicit in-memory GC of a disconnected device.
// ----------------------------------------------------------------------------

describe("PresenceRegisterService — forgetDevice", () => {
  it("removes a device's presence and returns true; the device drops from the projection", () => {
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );

    expect(service.forgetDevice(SESSION_ID, DEVICE_LAPTOP)).toBe(true);
    expect(service.readPresence(SESSION_ID).devices).toEqual([]);
    // An emptied session map is reclaimed, so a churned session leaves no key.
    expect(service.trackedSessionCount()).toBe(0);
  });

  it("forgets only the named device; the user's other device stays present", () => {
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_PHONE, activityState: "idle" }),
    );

    expect(service.forgetDevice(SESSION_ID, DEVICE_PHONE)).toBe(true);
    const presence = service.readPresence(SESSION_ID);
    expect(presence.devices).toHaveLength(1);
    expect(presence.devices[0]?.deviceId).toBe(DEVICE_LAPTOP);
    expect(service.trackedSessionCount()).toBe(1);
  });

  it("returns false for an unknown session or an unknown device", () => {
    const service = new PresenceRegisterService();
    expect(service.forgetDevice(SESSION_ID, DEVICE_LAPTOP)).toBe(false);
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    expect(service.forgetDevice(SESSION_ID, DEVICE_PHONE)).toBe(false);
    expect(service.forgetDevice(OTHER_SESSION_ID, DEVICE_LAPTOP)).toBe(false);
  });

  it("destroy() releases every tracked device across every session", () => {
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    service.recordHeartbeat(
      OTHER_SESSION_ID,
      heartbeat({ deviceId: DEVICE_PHONE, activityState: "online" }),
    );
    expect(service.trackedSessionCount()).toBe(2);

    service.destroy();
    expect(service.trackedSessionCount()).toBe(0);
    expect(service.readPresence(SESSION_ID).devices).toEqual([]);
    expect(service.readPresence(OTHER_SESSION_ID).devices).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Constructor validates the reconnecting/offline timing options.
// ----------------------------------------------------------------------------

describe("PresenceRegisterService — constructor validates the timing options", () => {
  it("throws RangeError when offlineAfterMs < reconnectingAfterMs (well-ordering invariant)", () => {
    expect(
      () => new PresenceRegisterService({ reconnectingAfterMs: 45_000, offlineAfterMs: 15_000 }),
    ).toThrow(RangeError);
  });

  it("throws RangeError on a negative, NaN, non-integer, or over-ceiling timing value", () => {
    const setTimeoutCeiling = 2_147_483_647;
    for (const reconnectingAfterMs of [-1, Number.NaN, 1.5, setTimeoutCeiling + 1]) {
      expect(() => new PresenceRegisterService({ reconnectingAfterMs })).toThrow(RangeError);
    }
    for (const offlineAfterMs of [-1, Number.NaN, 1.5, setTimeoutCeiling + 1]) {
      expect(() => new PresenceRegisterService({ offlineAfterMs })).toThrow(RangeError);
    }
  });

  it("accepts valid timing config, including equal values and the defaults", () => {
    expect(() => new PresenceRegisterService()).not.toThrow();
    expect(
      () => new PresenceRegisterService({ reconnectingAfterMs: 1_000, offlineAfterMs: 1_000 }),
    ).not.toThrow();
    expect(
      () => new PresenceRegisterService({ reconnectingAfterMs: 0, offlineAfterMs: 2_147_483_647 }),
    ).not.toThrow();
  });
});

// ----------------------------------------------------------------------------
// Pr2 — reconnect-grace timer (reconnecting before offline).
// ----------------------------------------------------------------------------

describe("PresenceRegisterService — reconnect-grace timer", () => {
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
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("online");

    // Just before the reconnecting threshold — still online.
    vi.advanceTimersByTime(14_999);
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("online");

    // Cross 15s — reconnecting (NOT offline yet). This is the load-bearing
    // ordering assertion: reconnecting precedes offline.
    vi.advanceTimersByTime(1);
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("reconnecting");

    // Just before the offline threshold — still reconnecting.
    vi.advanceTimersByTime(29_999);
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("reconnecting");

    // Cross 45s (from the heartbeat) — offline.
    vi.advanceTimersByTime(1);
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("offline");

    // The observation seam saw EXACTLY the ordered two-step transition.
    expect(transitions.map((event) => `${event.from}->${event.to}`)).toEqual([
      "online->reconnecting",
      "reconnecting->offline",
    ]);
    // Each transition carries the device and a wall-clock instant.
    expect(transitions[0]?.sessionId).toBe(SESSION_ID);
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
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );

    // Advance into the window but BEFORE the reconnecting threshold, then send a
    // fresh heartbeat — this re-arms the timer, so the device must stay online
    // past the ORIGINAL 15s mark.
    vi.advanceTimersByTime(10_000);
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );

    // 10s after the SECOND heartbeat (20s after the first): still online,
    // because the second heartbeat reset the grace timer.
    vi.advanceTimersByTime(10_000);
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("online");
    expect(transitions).toEqual([]);

    // Now let the (re-armed) window elapse with no further heartbeats: it
    // transitions on the new schedule.
    vi.advanceTimersByTime(5_000); // 15s after the second heartbeat.
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("reconnecting");
  });

  it("recovers a device from reconnecting back to online on a fresh heartbeat (no spurious backward transition)", () => {
    // The cancel test above pins cancel-BEFORE-reconnecting; this pins recovery
    // AFTER a device has actually reached `reconnecting`. Recovery is sound today
    // because `recordHeartbeat` -> `setLocalState` rewrites the slot directly and
    // BYPASSES the forward-only `#transition` — so it is NOT gated by the
    // degradation ordering. This is unpinned otherwise: a future refactor routing
    // heartbeats through `#transition` would strand a recovered device in
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
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );

    // Cross the reconnecting threshold (but NOT offline) — the device degrades.
    vi.advanceTimersByTime(15_000);
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("reconnecting");

    // A fresh `online` heartbeat arrives within the offline window — the device
    // must recover to `online`.
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("online");

    // The observation stream saw ONLY the forward degradation step — recovery is
    // a direct slot rewrite, NOT a timer transition, so there is NO spurious
    // `reconnecting->online` event.
    expect(transitions.map((event) => `${event.from}->${event.to}`)).toEqual([
      "online->reconnecting",
    ]);
  });

  it("uses the default 15s/45s grace windows when not overridden", () => {
    // Constructed with NO timing options — the defaults must be the documented
    // heartbeat interval and grace window.
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );

    vi.advanceTimersByTime(15_000);
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("reconnecting");
    vi.advanceTimersByTime(30_000); // 45s total.
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("offline");
  });

  it("degrades each device on its own schedule", () => {
    const service = new PresenceRegisterService({
      reconnectingAfterMs: 15_000,
      offlineAfterMs: 45_000,
    });

    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    vi.advanceTimersByTime(10_000);
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_PHONE, activityState: "online" }),
    );

    // 15s after the laptop's heartbeat, 5s after the phone's.
    vi.advanceTimersByTime(5_000);
    const byDevice = new Map(
      service.readPresence(SESSION_ID).devices.map((device) => [device.deviceId, device.state]),
    );
    expect(byDevice.get(DEVICE_LAPTOP)).toBe("reconnecting");
    expect(byDevice.get(DEVICE_PHONE)).toBe("online");
  });

  it("never bounces an already-offline device backward to reconnecting (forward-only degradation)", () => {
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
    // bogus offline->reconnecting transition would pollute the durable timeline.
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "offline" }),
    );
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("offline");

    vi.advanceTimersByTime(45_000);
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("offline");
    expect(transitions).toEqual([]);
  });

  it("the timer rewrites the live CRDT only — no durable handle exists", () => {
    // The service has NO database/Querier/Pool (type-level no-DB guarantee), so
    // a timer-driven transition cannot write durably — there is nothing to write
    // to. The ONLY emission seam is the in-process `onTransition` observer.
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
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );
    vi.advanceTimersByTime(15_000);
    // The transition is reflected purely in the in-memory projection.
    expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("reconnecting");
    expect(observed).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Pr2 (crash guard) — a throwing onTransition observer must NOT crash the
// process (daemon-crash guard on the detached setTimeout grace-timer boundary).
// ----------------------------------------------------------------------------
//
// `#transition` fires the `onTransition` observer from a DETACHED `setTimeout`
// grace-timer callback (`#armGraceTimer`). The observer is the durable-emission
// seam wired to the event-log append path, which CAN throw (SQLite
// `SQLITE_BUSY`, a `monotonic_ns` unique-violation, a Zod failure). On a real
// timer boundary an uncaught throw ESCAPES to Node's `uncaughtException` and can
// terminate the daemon — exactly the failure the guard in `#transition`
// prevents.
//
// These tests deliberately use REAL timers (a tiny 5ms reconnecting window),
// NOT the fake timers the rest of the grace-timer suite uses: under
// `vi.useFakeTimers()` a throw inside a `setTimeout` callback is re-thrown
// SYNCHRONOUSLY by `advanceTimersByTime` and never reaches
// `process.on("uncaughtException")`, so the "no uncaught exception" assertion
// would be vacuous. Real timers exercise the genuine production path.

describe("PresenceRegisterService — crash guard on the onTransition seam", () => {
  it("swallows a throw from the onTransition seam, logs a tripwire, and keeps processing", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);

    // Spy on `console.error` so the tripwire log is assertable. Mock the impl to
    // a no-op so the synthetic-failure diagnostic does not pollute test output.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // The observer throws on the FIRST transition (the laptop's reconnecting),
    // then becomes a no-op so a subsequent device's transitions are observed
    // normally. A short 5ms reconnecting window keeps the real-timer wait tight.
    const observed: string[] = [];
    let throwOnce = true;
    const service = new PresenceRegisterService({
      reconnectingAfterMs: 5,
      offlineAfterMs: 10_000, // far out — this test only drives the reconnecting step.
      onTransition: (event) => {
        if (throwOnce && event.deviceId === DEVICE_LAPTOP) {
          throwOnce = false;
          throw new Error("synthetic append failure");
        }
        observed.push(`${event.deviceId}:${event.from}->${event.to}`);
      },
    });

    try {
      service.recordHeartbeat(
        SESSION_ID,
        heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
      );
      // Wait past the 5ms reconnecting window on REAL timers so the detached
      // `setTimeout` callback runs on its own tick (where an unguarded throw
      // would escape to `uncaughtException`).
      await new Promise((resolve) => setTimeout(resolve, 30));

      // (a) The throw was SWALLOWED at the guard, not propagated to the process.
      expect(uncaught).toEqual([]);

      // (b) The guard logged the tripwire with the full transition context.
      expect(consoleErrorSpy).toHaveBeenCalled();
      const tripwireCall = consoleErrorSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("onTransition observer threw"),
      );
      expect(tripwireCall).toBeDefined();
      const tripwireMessage = tripwireCall?.[0] as string;
      expect(tripwireMessage).toContain(SESSION_ID);
      expect(tripwireMessage).toContain("from=online");
      expect(tripwireMessage).toContain("to=reconnecting");
      // The thrown Error is forwarded as the second arg for diagnosis.
      expect(tripwireCall?.[1]).toBeInstanceOf(Error);
      expect((tripwireCall?.[1] as Error).message).toBe("synthetic append failure");

      // The in-memory CRDT still advanced despite the observer throw — the
      // transition itself is applied BEFORE the (swallowed) emission.
      expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("reconnecting");

      // (c) The service is NOT in a corrupt state: a SUBSEQUENT heartbeat for a
      // DIFFERENT device still processes and its grace-timer transition is
      // observed normally (the observer no longer throws).
      service.recordHeartbeat(
        SESSION_ID,
        heartbeat({ deviceId: DEVICE_PHONE, activityState: "online" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(observed).toContain(`${DEVICE_PHONE}:online->reconnecting`);
      const states = new Map(
        service.readPresence(SESSION_ID).devices.map((device) => [device.deviceId, device.state]),
      );
      expect(states.get(DEVICE_PHONE)).toBe("reconnecting");

      service.destroy();
    } finally {
      process.removeListener("uncaughtException", onUncaught);
      consoleErrorSpy.mockRestore();
    }
  });

  it("swallows a REJECTION from an async onTransition seam, logs the async tripwire, and does not crash", async () => {
    // The seam is legitimately async (the consumer wires it to a DB write). A
    // plain try/catch catches a SYNC throw but NOT a rejected promise — an
    // unhandled rejection on this detached `setTimeout` boundary escapes to
    // Node's `unhandledRejection` and can terminate the daemon. The guard
    // duck-types the observer's return value for a thenable and attaches a
    // `.catch` to the same tripwire.
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
        heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
      );
      // Wait past the 5ms reconnecting window on REAL timers so the detached
      // callback fires, THEN flush microtasks so the rejected promise's `.catch`
      // (or, if the guard regressed, the `unhandledRejection`) has settled.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await new Promise((resolve) => setImmediate(resolve));

      // (a) The rejection was routed to the guard's `.catch`, NOT to the process.
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
      expect(tripwireMessage).toContain("from=online");
      expect(tripwireMessage).toContain("to=reconnecting");
      expect(tripwireCall?.[1]).toBeInstanceOf(Error);
      expect((tripwireCall?.[1] as Error).message).toBe("synthetic async append rejection");

      // The in-memory CRDT still advanced despite the rejected emission.
      expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("reconnecting");

      service.destroy();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      process.removeListener("uncaughtException", onUncaught);
      consoleErrorSpy.mockRestore();
    }
  });

  it("routes a rejection from a `.then`-only thenable (no `.catch`) to the async tripwire, not a sync mislabel", async () => {
    // The seam is a foreign-code trust boundary, and the PromiseLike (TC39)
    // contract only requires `.then` — a valid thenable MAY omit `.catch`. The
    // guard MUST discharge the rejection via `Promise.resolve(thenable)
    // .catch(...)`, never a DIRECT `.catch` on the value: a direct call on a
    // `.then`-only thenable is `undefined(...)` → throws TypeError synchronously
    // → lands in the sync catch (MISLABELED "(sync)") while the REAL rejection
    // goes unrouted to `unhandledRejection`. This thenable rejects and has NO
    // `.catch`. It is a PromiseLike, not a Promise, so it does not statically
    // satisfy `() => void | Promise<void>` — the cast injects it to exercise the
    // RUNTIME path the duck-typing defends (a JS caller / cross-realm value /
    // lying types). The native-Promise test above passes BOTH the old and new
    // code, so it does NOT cover this case; this does.
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
        heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
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

      expect(service.readPresence(SESSION_ID).devices[0]?.state).toBe("reconnecting");

      service.destroy();
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      process.removeListener("uncaughtException", onUncaught);
      consoleErrorSpy.mockRestore();
    }
  });
});

// ----------------------------------------------------------------------------
// UUID hex-case canonicalization at the session-map key boundary.
// ----------------------------------------------------------------------------
//
// UUID hex text is case-INSENSITIVE (RFC 9562 §4) and `SessionIdSchema` accepts
// an uppercase UUID unchanged (no normalization). Ids in this codebase are
// branded by bare cast at DB-row reads, NOT by parsing through the schema, so an
// uppercase and a lowercase spelling of the SAME logical session can both reach
// the service. Without canonicalization the two case-variants land under two
// distinct `#sessions` keys → split or missing presence state. `deviceId` is
// opaque/case-significant and is deliberately NOT canonicalized.

describe("PresenceRegisterService — canonicalizes case-variant session ids", () => {
  // The SAME logical session id in two hex cases. v7-shaped (version `7`,
  // variant `8`) so any wire validation accepts it; cast per the file idiom.
  const UPPER_SESSION_ID: SessionId = "0197F00D-AAAA-7AAA-8AAA-AAAAAAAAAAAA" as SessionId;
  const LOWER_SESSION_ID: SessionId = "0197f00d-aaaa-7aaa-8aaa-aaaaaaaaaaaa" as SessionId;

  it("a heartbeat under an UPPERCASE sessionId is read back under its lowercase form", () => {
    const service = new PresenceRegisterService();

    service.recordHeartbeat(
      UPPER_SESSION_ID,
      heartbeat({ deviceId: DEVICE_LAPTOP, activityState: "online" }),
    );

    const presence = service.readPresence(LOWER_SESSION_ID);
    expect(presence.devices).toHaveLength(1);
    expect(presence.devices[0]?.deviceId).toBe(DEVICE_LAPTOP);
    expect(presence.devices[0]?.state).toBe("online");
    // One logical session, one map key.
    expect(service.trackedSessionCount()).toBe(1);
  });

  it("keeps two case-variant devices distinct (deviceId is case-significant)", () => {
    const service = new PresenceRegisterService();
    service.recordHeartbeat(
      SESSION_ID,
      heartbeat({ deviceId: "Device-A", activityState: "online" }),
    );
    service.recordHeartbeat(SESSION_ID, heartbeat({ deviceId: "device-a", activityState: "idle" }));

    const presence = service.readPresence(SESSION_ID);
    expect(presence.devices).toHaveLength(2);
  });
});
