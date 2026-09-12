// PresenceRegisterService — in-memory device presence for the one user.
//
// Responsibilities:
//   * recordHeartbeat — ingest a `PresenceHeartbeat` into the in-memory Yjs
//     Awareness CRDT. Each (session, device) pair gets its own `Y.Doc` +
//     `Awareness` instance whose LOCAL state holds that device's presence;
//     subsequent heartbeats from the same device update that same local state
//     in place. NO SQLite or Postgres write occurs — the live CRDT state lives
//     in memory only. Every heartbeat also (re)arms the device's
//     reconnect-grace timer.
//   * readPresence — project the live in-memory Awareness state for a session
//     into the `PresenceReadResponse` wire shape: one entry per DEVICE. There
//     is no roster collapse, because there is no roster — every device belongs
//     to the same user, and each one's liveness is independently interesting.
//   * forgetDevice / destroy — explicit GC. `forgetDevice` releases one
//     (session, device) pair and clears its grace timer; `destroy` releases
//     every tracked device (leak-free shutdown).
//
// Why Yjs Awareness, not a plain Map: a `y-protocols/awareness` `Awareness`
// instance is fundamentally a SINGLE-local-client holder — it borrows one
// numeric `clientID` from its backing `Y.Doc`, and `setLocalState(...)` mutates
// only THAT client's slot (`getStates()` maps `clientID -> state`). To aggregate
// MANY devices on the server we therefore hold ONE `Awareness` per device, where
// each instance's local state IS that device's presence. A single shared
// `Awareness` could only ever carry one client's state.
//
// ----------------------------------------------------------------------------
// Boundaries (DO NOT CROSS)
// ----------------------------------------------------------------------------
//
//   * No durable presence storage. This service writes NO presence ROW to
//     SQLite or Postgres: it takes no querier and no pool, and no
//     presence-state table exists in the schema. Audit-relevant presence
//     transitions (`presence.online/idle/reconnecting/offline`) are emitted as
//     `session_events` by the consumer wired to the `onTransition` seam; that
//     event log — not this live CRDT — is the durable surface.
//   * No wire/transport layer for the JSON-RPC `PresenceUpdate` push or the
//     `PresenceRead` RPC binding — those are downstream; this service is the
//     in-process ingest/query core.
//   * No cross-node fan-out. One runtime node executes, so there is no peer
//     node to publish a device's Awareness slot to.

import type {
  PresenceHeartbeat,
  PresenceReadResponse,
  PresenceReadResponseDevice,
  PresenceState,
  SessionId,
} from "@ai-sidekicks/contracts";
// Value import (separate from the type-only import above): the runtime schemas
// used to revalidate a device snapshot read back out of its Awareness slot (see
// `validatePresenceDeviceState`).
import {
  ChannelIdSchema,
  DEVICE_ID_MAX_LEN,
  DEVICE_TYPE_MAX_LEN,
  PresenceStateSchema,
  SessionIdSchema,
  canonicalizeUuid,
  wireFreeFormString,
} from "@ai-sidekicks/contracts";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { z } from "zod";

// --------------------------------------------------------------------------
// Reconnect-grace timing.
// --------------------------------------------------------------------------
//
// The heartbeat interval is 15s with a reconnect grace window of 45s before
// offline — a TWO-threshold machine:
//
//   online/idle --(15s no heartbeat)--> reconnecting
//               --(45s total no heartbeat)--> offline
//
// i.e. `reconnecting` fires at the first missed heartbeat interval (15s after
// the last heartbeat), and `offline` fires at the full 45s grace window from
// the last heartbeat. Both thresholds are configurable via
// `PresenceRegisterServiceOptions`; these are the defaults.
const DEFAULT_RECONNECTING_AFTER_MS = 15_000;
const DEFAULT_OFFLINE_AFTER_MS = 45_000;

// --------------------------------------------------------------------------
// Offline-degradation ordering — the grace machine's forward-only progression.
// --------------------------------------------------------------------------
//
// The reconnect-grace timer moves a device toward offline as heartbeats lapse:
// a LIVE state (online/idle) degrades to `reconnecting` at 15s, then to
// `offline` at 45s. `#transition` consults this rank so a transition is applied
// ONLY when it moves the device strictly FORWARD in degradation — it must never
// bounce a device backward (an explicit `offline` heartbeat is terminal and is
// NOT dragged back to `reconnecting` when the timer fires). online and idle
// share rank 0: they are both "live", and the grace timer treats an idle device
// exactly like an online one (idle is a client-reported activity level, not a
// degradation step).
//
// This `Record<PresenceState, number>` is ALSO the single compile-time
// exhaustiveness tripwire for the state set: a future fifth `PresenceState` is
// a TYPE ERROR here until it is assigned a rank, with deliberate placement.
// RUNTIME membership enforcement lives in `PresenceDeviceStateSchema.state`,
// which reuses the contract's `PresenceStateSchema` enum — so the same contract
// enum drives both the compile-time rank table here and the parse-time
// validation, and they cannot drift.
const PRESENCE_PROGRESSION: Record<PresenceState, number> = {
  online: 0,
  idle: 0,
  reconnecting: 1,
  offline: 2,
};

// --------------------------------------------------------------------------
// Awareness local-state shape — what each device's CRDT slot carries.
// --------------------------------------------------------------------------
//
// The single source of truth for the local-state shape AND its revalidation.
// The derived `PresenceDeviceState` type cannot drift from what the validator
// actually enforces. Branded id fields reuse the contract schemas
// (`z.ZodType<Brand, Brand>`), so `z.infer` yields the same branded types the
// rest of the file consumes. `z.object` strips unknown keys.
//
// Largest ms epoch whose `new Date(ms).toISOString()` stays within the
// 4-digit-year ISO-8601 grammar that `PresenceReadResponseSchema.lastSeen`
// (`z.iso.datetime`) enforces — `Date.UTC(9999,11,31,23,59,59,999)`. Beyond
// this, `toISOString()` emits an expanded 6-digit year that the daemon's
// `presence.read` result-schema validation rejects with -32603.
const MAX_PRESENCE_LAST_SEEN_MS = 253_402_300_799_999;

// Node's `setTimeout` delay is a 32-bit signed value: the largest delay it
// honors verbatim is 2^31-1 ms (~24.8 days). A larger delay OVERFLOWS the
// 32-bit field, and Node coerces it to 1ms while emitting a
// `TimeoutOverflowWarning` — so a grace window set above this would fire the
// reconnecting/offline transition almost immediately, silently forcing the
// device offline. Both grace windows are validated to fit under this ceiling in
// the constructor, which keeps every delay `#armGraceTimer` actually passes to
// `setTimeout` (`reconnectingAfterMs` and `offlineAfterMs -
// reconnectingAfterMs`, each <= its input) safely in range.
const SET_TIMEOUT_MAX_MS = 2_147_483_647;

const PresenceDeviceStateSchema = z.object({
  // `deviceId` / `deviceType` mirror the heartbeat path's `wireFreeFormString`
  // guard so the read-back path enforces the SAME bound + length cap, and the
  // NUL log-injection vector `wireFreeFormString` exists to guard stays closed.
  deviceId: wireFreeFormString(DEVICE_ID_MAX_LEN, "PresenceDeviceState.deviceId"),
  state: PresenceStateSchema,
  deviceType: wireFreeFormString(DEVICE_TYPE_MAX_LEN, "PresenceDeviceState.deviceType"),
  focusedSessionId: SessionIdSchema.nullable(),
  focusedChannelId: ChannelIdSchema.nullable(),
  // Server-clock receipt time, NOT the wire `metadata.lastActivityAt`. See
  // `recordHeartbeat` for why the server clock is authoritative for `lastSeen`.
  // Bounded by `MAX_PRESENCE_LAST_SEEN_MS` — see that const's declaration for
  // the ISO-8601 4-digit-year ceiling rationale and the downstream -32603 chain.
  lastSeenAtMs: z.number().int().min(0).max(MAX_PRESENCE_LAST_SEEN_MS),
  // The client-reported "last user interaction" timestamp, preserved verbatim
  // from the wire for downstream consumers (e.g. an idle detector) that want
  // the activity time distinct from the receipt time.
  lastActivityAt: z.iso.datetime({ offset: true }),
  appVisible: z.boolean(),
});

// This is the value `setLocalState(...)` writes into the per-device Awareness
// slot and `getStates()` reads back. It mirrors the metadata the heartbeat
// carries plus the resolved presence `state`. `Readonly<...>` is a type-level
// modifier only (it does NOT freeze the parsed object — every `#transition`
// produces a fresh spread).
type PresenceDeviceState = Readonly<z.infer<typeof PresenceDeviceStateSchema>>;

// --------------------------------------------------------------------------
// Per-device holder.
// --------------------------------------------------------------------------
interface DevicePresence {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  // Reconnect-grace timer handle for THIS device; (re)armed on every
  // `recordHeartbeat`, cleared on `forgetDevice`/`destroy`. `undefined` until
  // the first heartbeat arms it. Tracked here so teardown is leak-free. Typed
  // with an explicit `| undefined` (not the `?` shorthand) so reassignment to
  // `undefined` is legal under `exactOptionalPropertyTypes`.
  graceTimer: ReturnType<typeof setTimeout> | undefined;
}

// Observation seam for durable-event emission. The service invokes this on
// every timer-driven device transition; the consumer wires it to the
// `session_events` append path. This service itself performs NO durable write.
export interface PresenceTransitionEvent {
  readonly sessionId: SessionId;
  readonly deviceId: string;
  readonly from: PresenceState;
  readonly to: PresenceState;
  readonly at: Date;
}

// --------------------------------------------------------------------------
// Constructor options — ALL fields optional, so `new PresenceRegisterService()`
// is a valid construction.
// --------------------------------------------------------------------------
export interface PresenceRegisterServiceOptions {
  // Reconnect-grace timing (defaults: 15s / 45s). Read as the delay (ms) from
  // the LAST heartbeat to the `reconnecting` and `offline` transitions
  // respectively. `offlineAfterMs` MUST be >= `reconnectingAfterMs` for the
  // two-step machine to be well-ordered.
  readonly reconnectingAfterMs?: number;
  readonly offlineAfterMs?: number;
  // Observation seam for durable presence-event emission (see
  // `PresenceTransitionEvent`). Absent => transitions are applied to the live
  // CRDT only (no observer). The return type admits `Promise<void>` because the
  // consumer wires this to the daemon's durable append path, an async DB write;
  // `#transition` catches BOTH a sync throw and an async rejection so either
  // failure mode degrades gracefully instead of crashing the daemon on the
  // detached timer boundary. A plain `() => void` callback still satisfies it.
  readonly onTransition?: (event: PresenceTransitionEvent) => void | Promise<void>;
}

export class PresenceRegisterService {
  // Live presence state, in memory ONLY. Keyed session -> deviceId ->
  // DevicePresence. Mutated on `recordHeartbeat` / `forgetDevice` / the grace
  // timer / `destroy`.
  readonly #sessions: Map<SessionId, Map<string, DevicePresence>> = new Map();

  readonly #reconnectingAfterMs: number;
  readonly #offlineAfterMs: number;
  readonly #onTransition: ((event: PresenceTransitionEvent) => void | Promise<void>) | undefined;

  constructor(options?: PresenceRegisterServiceOptions) {
    this.#reconnectingAfterMs = options?.reconnectingAfterMs ?? DEFAULT_RECONNECTING_AFTER_MS;
    this.#offlineAfterMs = options?.offlineAfterMs ?? DEFAULT_OFFLINE_AFTER_MS;
    this.#onTransition = options?.onTransition;

    // Fail-fast validation of the two timing options at construction. Both feed
    // `#armGraceTimer`'s `Math.max(0, … - elapsed)` + `setTimeout`, where a
    // negative / NaN / non-integer delay is a silent footgun (setTimeout coerces
    // NaN to 0, firing the transition immediately). An UPPER bound is just as
    // load-bearing: a delay above `SET_TIMEOUT_MAX_MS` (2^31-1) overflows
    // setTimeout's 32-bit field and is coerced to ~1ms
    // (TimeoutOverflowWarning), which would fire the reconnecting/offline
    // transition almost immediately — silently forcing the device offline, the
    // inverse of the intended long window. The well-ordering invariant
    // (`offlineAfterMs >= reconnectingAfterMs`) keeps the two-step
    // `reconnecting -> offline` machine monotone. RangeError names the offending
    // value so a misconfiguration is diagnosable at the call site.
    for (const [label, value] of [
      ["reconnectingAfterMs", this.#reconnectingAfterMs],
      ["offlineAfterMs", this.#offlineAfterMs],
    ] as const) {
      if (!Number.isInteger(value) || value < 0 || value > SET_TIMEOUT_MAX_MS) {
        throw new RangeError(
          `PresenceRegisterService: ${label} must be a non-negative integer (ms) not exceeding ${String(SET_TIMEOUT_MAX_MS)} (setTimeout ceiling); received ${String(value)}`,
        );
      }
    }
    if (this.#offlineAfterMs < this.#reconnectingAfterMs) {
      throw new RangeError(
        `PresenceRegisterService: offlineAfterMs (${String(this.#offlineAfterMs)}) must be >= ` +
          `reconnectingAfterMs (${String(this.#reconnectingAfterMs)}) for a well-ordered ` +
          `reconnecting -> offline transition`,
      );
    }
  }

  /**
   * Ingest a heartbeat into the in-memory Awareness CRDT for `sessionId` (no
   * durable write occurs) and (re)arm this device's reconnect-grace timer.
   *
   * The first heartbeat for a device lazily creates its `Y.Doc` + `Awareness`;
   * subsequent heartbeats update the same device's local Awareness slot in
   * place via `setLocalState(...)`. All four `PresenceState` values are accepted
   * and stored verbatim — including `"offline"` and `"reconnecting"` — because
   * the wire enum admits them and the ingest path stays total. An explicit
   * `"offline"` heartbeat is stored as-is; the timer-driven lifecycle is
   * independent (it fires only on the ABSENCE of heartbeats, never on a carried
   * state).
   *
   * `lastSeen` provenance: the server captures `Date.now()` at receipt and
   * stores it as `lastSeenAtMs`, rather than trusting the wire
   * `metadata.lastActivityAt`. Two reasons: (a) it defends against client
   * clock skew — a device with a wrong clock cannot forge a future/past
   * last-seen; (b) `lastActivityAt` is semantically "when the user last
   * interacted", which is distinct from "when the server last heard from the
   * device". The wire `lastActivityAt` is still preserved on the stored state.
   *
   * @param sessionId the session this presence belongs to. Presence is scoped
   *   per session (a device present in two sessions has two independent
   *   Awareness slots).
   * @param heartbeat the validated `PresenceHeartbeat` (boundary validation via
   *   `PresenceHeartbeatSchema` is the transport layer's job; this in-process
   *   core trusts the typed input).
   */
  recordHeartbeat(sessionId: SessionId, heartbeat: PresenceHeartbeat): void {
    const devices: Map<string, DevicePresence> = this.#devicesFor(sessionId);

    let device: DevicePresence | undefined = devices.get(heartbeat.deviceId);
    if (device === undefined) {
      const doc: Y.Doc = new Y.Doc();
      device = { doc, awareness: newAwareness(doc), graceTimer: undefined };
      devices.set(heartbeat.deviceId, device);
    }

    const deviceState: PresenceDeviceState = {
      deviceId: heartbeat.deviceId,
      state: heartbeat.activityState,
      deviceType: heartbeat.metadata.deviceType,
      focusedSessionId: heartbeat.metadata.focusedSessionId,
      focusedChannelId: heartbeat.metadata.focusedChannelId,
      lastSeenAtMs: Date.now(),
      lastActivityAt: heartbeat.metadata.lastActivityAt,
      appVisible: heartbeat.metadata.appVisible,
    };
    // Write into THIS device's Awareness slot. `setLocalState` mutates only the
    // doc's own clientID entry — exactly the single-local-client semantics that
    // make one-Awareness-per-device the correct aggregator.
    device.awareness.setLocalState(deviceState);

    // (Re)arm the reconnect-grace timer for this device off the fresh
    // heartbeat. A heartbeat arriving within the grace window cancels the
    // pending reconnecting/offline transition (the clear in `#armGraceTimer`).
    this.#armGraceTimer(sessionId, device, heartbeat.deviceId);
  }

  /**
   * Project the live in-memory presence for `sessionId` into the
   * `PresenceReadResponse` wire shape — one entry per DEVICE, in no guaranteed
   * order.
   *
   * Reads only the live in-memory state; performs no durable read. A session
   * with no live devices yields an empty `devices` array.
   *
   * @param sessionId the session to project.
   * @returns the per-device presence projection.
   */
  readPresence(sessionId: SessionId): PresenceReadResponse {
    const trackedDevices: Map<string, DevicePresence> | undefined = this.#getDevices(sessionId);
    if (trackedDevices === undefined) {
      return { devices: [] };
    }

    const devices: PresenceReadResponseDevice[] = [];
    for (const device of trackedDevices.values()) {
      const deviceState: PresenceDeviceState | undefined = validatePresenceDeviceState(
        device.awareness.getLocalState(),
      );
      if (deviceState === undefined) {
        // A device whose slot was cleared (e.g. set to null) contributes
        // nothing.
        continue;
      }
      devices.push({
        deviceId: deviceState.deviceId,
        deviceType: deviceState.deviceType,
        appVisible: deviceState.appVisible,
        state: deviceState.state,
        lastSeen: new Date(deviceState.lastSeenAtMs).toISOString(),
      });
    }
    return { devices };
  }

  /**
   * The number of sessions this node currently holds live presence for — an
   * operability gauge (how many session maps are resident in memory), and the
   * introspection seam that pins the empty-map reclaim: an empty session map
   * and a deleted one are observationally identical via `readPresence` (both
   * yield an empty `devices`).
   *
   * @returns the count of sessions with at least one tracked device.
   */
  trackedSessionCount(): number {
    return this.#sessions.size;
  }

  /**
   * Garbage-collect a single (session, device) holder's live presence — the
   * explicit hard-disconnect entry point.
   *
   * Clears the device's Awareness slot (`setLocalState(null)`), clears its
   * grace timer, and destroys the `Awareness` and its backing `Y.Doc`. The map
   * entry is removed; an emptied session map is removed too so a churned
   * session leaves no residual key.
   *
   * @param sessionId the session the device belonged to.
   * @param deviceId the specific device that disconnected.
   * @returns `true` if a device was found and removed; `false` if no such
   *   device was tracked.
   */
  forgetDevice(sessionId: SessionId, deviceId: string): boolean {
    const devices: Map<string, DevicePresence> | undefined = this.#getDevices(sessionId);
    if (devices === undefined) {
      return false;
    }
    const device: DevicePresence | undefined = devices.get(deviceId);
    if (device === undefined) {
      return false;
    }
    teardownDevice(device);
    devices.delete(deviceId);
    if (devices.size === 0) {
      this.#deleteDevices(sessionId);
    }
    return true;
  }

  /**
   * Release EVERY tracked device across all sessions — leak-free shutdown.
   * Clears every grace timer and destroys every Awareness/Y.Doc. After
   * `destroy()` the service holds no timers and no CRDT instances.
   */
  destroy(): void {
    for (const devices of this.#sessions.values()) {
      for (const device of devices.values()) {
        teardownDevice(device);
      }
      devices.clear();
    }
    this.#sessions.clear();
  }

  // ------------------------------------------------------------------------
  // Internal — reconnect-grace timer machine.
  // ------------------------------------------------------------------------

  /**
   * (Re)arm the reconnect-grace timer for a device off a fresh heartbeat.
   * Clears any pending timer first (a heartbeat within the grace window cancels
   * the pending transition), then schedules the two-step machine:
   *
   *   t + reconnectingAfterMs  -> transition to `reconnecting`
   *   t + offlineAfterMs       -> transition to `offline`
   *
   * Each transition rewrites the device's Awareness `state` IN MEMORY and fires
   * the `onTransition` observer. No durable write occurs here. A transition is
   * a no-op if the device's current state already equals (or has passed) the
   * target — e.g. an explicit `"offline"` heartbeat means the `reconnecting`
   * step has nothing to do.
   */
  #armGraceTimer(sessionId: SessionId, device: DevicePresence, deviceId: string): void {
    if (device.graceTimer !== undefined) {
      clearTimeout(device.graceTimer);
      device.graceTimer = undefined;
    }

    // Step 1: at reconnectingAfterMs, move online/idle -> reconnecting.
    const reconnectingTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      this.#transition(sessionId, device, deviceId, "reconnecting");
      // Step 2: at offlineAfterMs (relative to the heartbeat), move ->
      // offline. Scheduled as the remaining delta so the absolute offline
      // instant is offlineAfterMs from the last heartbeat.
      const remainingToOffline: number = Math.max(
        0,
        this.#offlineAfterMs - this.#reconnectingAfterMs,
      );
      device.graceTimer = setTimeout(() => {
        this.#transition(sessionId, device, deviceId, "offline");
        device.graceTimer = undefined;
      }, remainingToOffline);
    }, this.#reconnectingAfterMs);

    device.graceTimer = reconnectingTimer;
  }

  /**
   * Apply a timer-driven transition to a device: rewrite its Awareness `state`
   * in memory and fire the `onTransition` observer.
   *
   * No-op if the device's current state is already AT OR PAST the target on the
   * offline-degradation ordering (online/idle < reconnecting < offline; see
   * `PRESENCE_PROGRESSION`). The grace machine only ever moves FORWARD in
   * degradation — it must never bounce a device backward (e.g. an explicit
   * `offline` heartbeat must NOT be dragged back to `reconnecting` when the 15s
   * timer fires). This keeps the observed transition stream monotonic, which
   * matters for the observer's durable-event emission (a bogus
   * offline->reconnecting would pollute the timeline).
   */
  #transition(
    sessionId: SessionId,
    device: DevicePresence,
    deviceId: string,
    to: PresenceState,
  ): void {
    const current: PresenceDeviceState | undefined = validatePresenceDeviceState(
      device.awareness.getLocalState(),
    );
    if (current === undefined || PRESENCE_PROGRESSION[to] <= PRESENCE_PROGRESSION[current.state]) {
      // Slot cleared, or the current state is already at/past the target on the
      // degradation ordering (so this forward-only transition is a no-op).
      return;
    }
    const from: PresenceState = current.state;
    device.awareness.setLocalState({ ...current, state: to });

    // CRASH GUARD: `#transition` is reached from a DETACHED `setTimeout`
    // grace-timer callback (`#armGraceTimer`), so this stack has NO surrounding
    // try/catch and runs outside any caller's reach. The `onTransition` observer
    // is the durable-emission seam wired to the daemon's durable append path, an
    // ASYNC DB write that CAN fail two ways — a SYNCHRONOUS throw (a
    // guard/validation error before the await) OR a REJECTED promise (SQLite
    // `SQLITE_BUSY`, a `monotonic_ns` unique-violation, a Zod failure inside the
    // async body). On this detached timer boundary a sync throw escapes to
    // `uncaughtException` and an unhandled rejection escapes to
    // `unhandledRejection` — in Node 22 BOTH are capable of terminating the
    // daemon process. So we degrade gracefully on EITHER path: the try/catch
    // swallows the sync throw, and (because the seam is legitimately async) we
    // duck-type the return value for a thenable and attach a `.catch` that
    // routes a rejection to the SAME tripwire. A dropped observer notification
    // (recoverable on the next transition / via reconciliation) is the right
    // trade against crashing the daemon over one emission. The duck-typed
    // `.then` check (not `instanceof Promise`) tolerates a non-native thenable
    // (e.g. a userland promise library or a cross-realm Promise) the observer
    // might return. We discharge it via `Promise.resolve(thenable).catch(...)`
    // rather than calling `.catch` DIRECTLY on the value: the PromiseLike
    // contract (TC39) only requires `.then`, so a valid `.then`-only thenable
    // has no `.catch` — a direct `(value).catch(...)` would be `undefined(...)`
    // and throw a TypeError synchronously, which the outer try/catch would then
    // swallow and MISLABEL "(sync)" while the genuine async rejection went
    // unrouted. `Promise.resolve` absorbs ANY thenable into a native Promise
    // whose `.catch` is guaranteed to exist. There is no structured logger in
    // the control-plane today; this flips to it when one lands. TRIPWIRE:
    // replace `console.error` once a structured logger surfaces.
    try {
      const observerResult: void | Promise<void> = this.#onTransition?.({
        sessionId,
        deviceId,
        from,
        to,
        at: new Date(),
      });
      if (
        observerResult !== undefined &&
        observerResult !== null &&
        typeof (observerResult as { then?: unknown }).then === "function"
      ) {
        Promise.resolve(observerResult as PromiseLike<void>).catch((error: unknown) => {
          console.error(
            `[presence] onTransition observer rejected (async); transition notification dropped (swallowed to keep the daemon alive) for sessionId=${sessionId} from=${from} to=${to}`,
            error,
          );
        });
      }
    } catch (error) {
      console.error(
        `[presence] onTransition observer threw (sync); transition notification dropped (swallowed to keep the daemon alive) for sessionId=${sessionId} from=${from} to=${to}`,
        error,
      );
    }
  }

  // ------------------------------------------------------------------------
  // Outer `#sessions` map accessors — the SINGLE canonicalization boundary.
  // ------------------------------------------------------------------------
  //
  // `#sessions` is keyed by `SessionId`, a branded UUID whose validator is case-
  // INSENSITIVE (RFC 9562 section 4), and ids in this codebase are branded by bare cast
  // at DB-row reads (not parsed through the schema), so an uppercase and a
  // lowercase spelling of the SAME logical session can both reach this map.
  // Routing EVERY keyed access through these accessors (which canonicalize via
  // `canonicalizeUuid`) is what guarantees the two spellings collapse to one key
  // — so presence cannot split or go missing across case-variants. INVARIANT: no
  // direct `this.#sessions.get/set/delete` exists outside these methods
  // (whole-map `values()`/`clear()`/`size` in `destroy`/`trackedSessionCount`
  // operate on the map as a whole and need no per-key canonical form).
  //
  // The inner map is keyed by `deviceId`, which is NOT canonicalized — it is an
  // opaque `wireFreeFormString`, case-SIGNIFICANT, where two case-variant
  // strings are two genuinely different devices.
  #getDevices(sessionId: SessionId): Map<string, DevicePresence> | undefined {
    return this.#sessions.get(canonicalizeUuid(sessionId));
  }

  #deleteDevices(sessionId: SessionId): void {
    this.#sessions.delete(canonicalizeUuid(sessionId));
  }

  #devicesFor(sessionId: SessionId): Map<string, DevicePresence> {
    let devices: Map<string, DevicePresence> | undefined = this.#getDevices(sessionId);
    if (devices === undefined) {
      devices = new Map<string, DevicePresence>();
      this.#sessions.set(canonicalizeUuid(sessionId), devices);
    }
    return devices;
  }
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

// Construct an Awareness and immediately clear its built-in 30s
// `_checkInterval` (`outdatedTimeout`). We drive device lifecycle ourselves via
// the reconnect-grace timer, so the library's interval is pure overhead here.
// The interval does NOT threaten our state: with one Awareness per device (so
// the only meaningful slot is this instance's own clientID), the interval's 30s
// outdated-state DELETION branch is dead — y-protocols EXCLUDES the local client
// from deletion and instead RE-ANNOUNCES the local state at
// `outdatedTimeout / 2` to keep it alive. So the real reasons to clear it are
// (a) avoid leaking a 30s `setInterval` per connected device, and (b) avoid the
// spurious ~15s periodic re-announce churn. Clearing it is the documented
// y-protocols-bypass pattern when the host owns lifecycle. The `_checkInterval`
// field is typed `any` in the `.d.ts`; the cast tightens it to the timer-handle
// type so `clearInterval` is sound.
function newAwareness(doc: Y.Doc): Awareness {
  const awareness: Awareness = new Awareness(doc);
  const handle = (awareness as unknown as { _checkInterval?: ReturnType<typeof setInterval> })
    ._checkInterval;
  if (handle !== undefined) {
    clearInterval(handle);
  }
  return awareness;
}

// Tear down a single device holder: clear its grace timer, mark it offline in
// the CRDT (null local state — the y-protocols-documented "propagate a null
// state before disconnect" convention), then destroy the Awareness (releasing
// its internal check-interval timer) and the backing Y.Doc. Does NOT touch the
// owning session map (callers do).
function teardownDevice(device: DevicePresence): void {
  if (device.graceTimer !== undefined) {
    clearTimeout(device.graceTimer);
    device.graceTimer = undefined;
  }
  device.awareness.setLocalState(null);
  device.awareness.destroy();
  device.doc.destroy();
}

// Revalidation of a presence state object read back out of a device's Awareness
// slot. The input is parsed against `PresenceDeviceStateSchema` — the single
// source of truth for a valid snapshot (field shapes, branded-id UUID format,
// the canonical `PresenceState` enum, and the numeric range bounds). Returns
// `undefined` (reject) for any malformed shape; the caller drops the offending
// device rather than projecting corrupt state.
// `Awareness#getLocalState()` returns `Record<string, any> | null`, so the
// input is `unknown` and narrowed by the parse.
function validatePresenceDeviceState(raw: unknown): PresenceDeviceState | undefined {
  const parsed = PresenceDeviceStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
