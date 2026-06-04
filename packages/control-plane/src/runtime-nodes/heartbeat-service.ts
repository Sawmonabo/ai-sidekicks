// HeartbeatService — Plan-003 Phase 3 (T3.6, runtime-node heartbeat ingestion +
// degraded/offline staleness sweep).
//
// Two responsibilities, split across the ingest path and the sweep path:
//
//   * recordHeartbeat (ingestion) — a runtime node reports liveness on the
//     Spec-003 line 59 cadence (`15s` default). The control plane UPSERTs the
//     node's `runtime_node_presence` row, stamping `last_heartbeat_at` with the
//     SERVER clock (`now()`), NEVER a daemon-supplied timestamp (Spec-003 line 61
//     — health "is server-derived and owned by the control plane — never
//     self-reported"). A fresh heartbeat also CLEARS staleness: it promotes the
//     stored `health_state` back to the node's self-reported reachable level
//     (`online` or `degraded`), so the next sweep sees a current row and a
//     hysteresis re-demotion fires only after the node ages out AGAIN. Ingestion
//     EMITS NOTHING — the control plane has no event log (ADR-017); the durable
//     `runtime_node.*` append is the daemon's (Plan-006 Tier 4). Ingestion just
//     mutates the snapshot row.
//
//   * sweepStaleNodes (the staleness sweep — the SOLE emitter) — the periodic
//     server-side evaluation Spec-003 line 61 assigns to the control plane. It
//     reads `last_heartbeat_at` against the SERVER clock and DEMOTES a node whose
//     most recent heartbeat aged past the Spec-003 line 60 thresholds:
//       - older than `60s` (≈4 missed beats) → `offline`
//       - older than `30s` (≈2 missed beats) → `degraded`
//     The `30s` band between the two is the deliberate hysteresis Spec-003 line 60
//     calls out: a node whose heartbeats resume within that band returns to
//     `online` without ever passing through `offline`.
//     The sweep is DEMOTE-ONLY: it never promotes (promotion is the ingest path's
//     `health_state` reset above), so a node that recovered via a fresh heartbeat
//     is not re-demoted until it ages out again. Each genuine state CHANGE is
//     surfaced once via the `onTransition` observer seam (below) so the daemon-
//     side writer can append the durable `runtime_node.degraded` /
//     `runtime_node.offline` event. The sweep performs NO durable event write
//     itself.
//
// WHY THE SWEEP IS SQL-SIDE AND TRANSACTIONAL (not app-side read-classify-write).
// The control plane runs over a `pg.Pool` with concurrent requests: an ingest
// heartbeat and a sweep can interleave. An app-side "SELECT all rows → classify
// in JS → UPDATE" sequence opens a TOCTOU race — the sweep reads a stale row,
// a concurrent `recordHeartbeat` bumps `last_heartbeat_at = now()`, and the sweep
// then writes `degraded` over a now-fresh node, demoting a healthy node. The
// hardened fix keeps the WHOLE decision in SQL inside ONE `transaction()`:
//   1. The staleness THRESHOLD is compared in SQL (`last_heartbeat_at < now() -
//      interval '60 seconds'`), so the reference clock is the DATABASE clock, not
//      the app's `Date.now()` — there is no app/DB clock skew to reconcile, and
//      no second `SELECT now()` round-trip to stay on one clock.
//   2. Each demote is an `UPDATE ... FROM (SELECT ... FOR UPDATE) RETURNING`: the
//      inner `FOR UPDATE` takes the row lock that SERIALIZES against a concurrent
//      ingest (the ingest UPSERT blocks until this txn commits, then runs on top —
//      so a heartbeat that lands mid-sweep is never clobbered), AND the subquery
//      captures the PRE-update `health_state` (the `from` of the transition) —
//      `RETURNING` alone yields the NEW value, never the old, so the prior state
//      must be captured in the locking subquery.
//   3. Both passes run in the SAME transaction, so Postgres `now()` (stable for
//      the txn's lifetime) gives BOTH passes an identical reference instant — a
//      node exactly at a boundary is classified exactly once. The offline pass
//      runs FIRST; the degraded pass then excludes `health_state IN ('degraded',
//      'offline')` (a txn sees its own writes), so a node that crossed BOTH
//      thresholds is offlined, not degraded-then-offlined, and a node already at
//      its target state does not re-emit. This is the emit-once-per-transition
//      guarantee — idempotency lives in the stored `health_state`, not in app
//      memory.
// The `onTransition` notifications are collected INSIDE the txn (node id + prior
// state + the joined session id) and fired AFTER it commits, so an observer that
// blocks or throws cannot hold the row locks or roll back the demotion.
//
// presence → attachment session join. `runtime_node_presence` is keyed by
// `node_id` ALONE (it is a per-node snapshot, not per-session). The
// `runtime_node.degraded` / `.offline` payloads carry an OPTIONAL `sessionId`
// (`buildRuntimeNodeLifecycleBaseShape` → `sessionId?`). To populate it we LEFT
// JOIN the node's single ACTIVE attachment: I-003-5 guarantees at most ONE
// attachment per node in an active state (`state IN ('registering', 'online',
// 'degraded')` — the exact predicate of the `idx_node_attachments_active`
// partial-unique index, 0003-runtime-nodes.ts:131-132), so the join yields zero
// or one session id deterministically (no aggregation, no "which session?"
// ambiguity). A node with NO active attachment still has its presence demoted and
// still emits — `sessionId` is simply absent on that transition (the daemon
// writer treats a node-scoped lifecycle event as session-agnostic). Reading the
// active set through that exact predicate is how this task VERIFIES I-003-5 at
// the read boundary: the join cannot select two sessions because the index
// forbids two active rows.
//
// Dependency injection — mirrors AttachService / MembershipService /
// SessionDirectoryService:
//   * `Querier` — the minimal SQL surface declared in
//     `sessions/migration-runner.ts`. The body NEVER imports `pg`; the production
//     concretion is composed by `createHeartbeatServiceFromPool` at the bottom via
//     the shared `createPgPoolQuerier` adapter Plan-001 owns. Test (PGlite) and
//     production (`pg.Pool`) surfaces stay interchangeable with no runtime branch.
//   * `onTransition` (option) — the observation seam for the durable
//     `runtime_node.degraded` / `.offline` append. Wired by the daemon-side writer
//     (Plan-006 Tier 4); absent => the sweep mutates the snapshot only and surfaces
//     nothing. Mirrors `PresenceRegisterService`'s `onTransition` seam exactly
//     (presence-register-service.ts:475-516), including the crash-guard contract.
//   * `degradedAfterMs` / `offlineAfterMs` / `sweepIntervalMs` (options) — the
//     Spec-003 timing, injectable so tests can pin deterministic values and so a
//     future ops knob can override the defaults. Defaults are the Spec-003 line
//     59/60 + Plan-003 T3.6 figures (`30s` / `60s` / `5s`).
//
// Cross-plan / cross-task boundaries (DO NOT CROSS in T3.6):
//   * `runtime_node_presence` / `runtime_node_attachments` table DDL — owned by
//     `migrations/0003-runtime-nodes.ts` (T3.1). This service only UPSERT/SELECT/
//     UPDATEs rows; it never ALTERs the schema.
//   * The durable `runtime_node.*` event append — owned by the daemon-side writer
//     (Plan-006 Tier 4; `runtime-daemon` `node-event-emitter.ts`). This service
//     surfaces a TRANSITION RECORD via `onTransition`; it does NOT construct the
//     `runtime_node.degraded` payload object, append to any log, or take a
//     `SessionService` (ADR-017 — the control plane has no event log).
//   * The `runtime_node.revoked` payload SHAPE + the detach/revoke path — owned by
//     T3.7. This task authors only the `runtime_node.degraded` payload shape (its
//     producer is this sweep); it does not touch `revoked`.
//
// Refs: Spec-003 §Default Behavior (line 59 heartbeat cadence `15s`, line 60
// degraded `30s` / offline `60s` thresholds + hysteresis, line 61 control-plane-
// owned server-derived staleness sweep — never self-reported); Plan-003 Phase 3
// T3.6 §Step / §Test (sweep interval `5s`, AC P6); Plan-003 §Invariants I-003-5
// (≤1 active attachment per node — the presence→attachment join predicate);
// docs/architecture/schemas/shared-postgres-schema.md §"Runtime Node Attachments
// (Plan-003)"; contracts `runtime-node.ts` (`RuntimeNodeDegradedPayloadSchema`,
// authored in this task; `RUNTIME_NODE_EVENT_NAMES`).

import type {
  NodeId,
  RuntimeNodeHealthState,
  RuntimeNodeHeartbeatRequest,
  RuntimeNodeOfflinePayload,
  SessionId,
} from "@ai-sidekicks/contracts";
import { RuntimeNodeHeartbeatRequestSchema } from "@ai-sidekicks/contracts";
import type { Pool } from "pg";

import { createPgPoolQuerier } from "../sessions/session-directory-service.js";
import type { Querier } from "../sessions/migration-runner.js";

// --------------------------------------------------------------------------
// Spec-003 timing defaults (line 59 / line 60) + Plan-003 T3.6 sweep interval.
// --------------------------------------------------------------------------
//
// Exported so tests + the daemon wiring can reference the canonical figures by
// name rather than re-typing the millisecond literals (and so a spec amendment
// changes them in one place). Each is the Spec-003 / Plan-003 figure converted to
// milliseconds; the sweep itself compares against the DB clock in SQL using the
// SECONDS form (`interval 'N seconds'`), so these constants are the single source
// the SQL second-counts are derived from.

// Spec-003 line 60: heartbeat older than `30s` (≈2 missed `15s` beats) → degraded.
export const RUNTIME_NODE_DEGRADED_AFTER_MS = 30_000 as const;
// Spec-003 line 60: heartbeat older than `60s` (≈4 missed `15s` beats) → offline.
export const RUNTIME_NODE_OFFLINE_AFTER_MS = 60_000 as const;
// Plan-003 T3.6 §Step: the staleness sweep runs every `5s`. Fast enough that a
// node crosses the `30s` / `60s` thresholds within at most one extra interval of
// the boundary, cheap enough to run unconditionally on a small fleet.
export const RUNTIME_NODE_SWEEP_INTERVAL_MS = 5_000 as const;

// The `runtime_node.offline` `reason` this sweep stamps. A staleness-driven
// offline is `heartbeat_lost` (the node stopped reporting), distinct from an
// explicit shutdown or a network partition (the other two members of the offline
// `reason` enum, set by the detach path T3.7 / future producers). Type-bound to
// the contract's `reason` union so a contract change surfaces at `tsc`, never a
// silent string drift (mirrors the daemon `EmitOfflineInput` reason binding).
const HEARTBEAT_LOST_REASON: RuntimeNodeOfflinePayload["reason"] = "heartbeat_lost";

// --------------------------------------------------------------------------
// Internal row shapes — the lowercase snake_case keys `pg.Pool#query` /
// `PGlite#query` return (Postgres folds identifiers to lowercase). Mirrors the
// internal-row idiom in attach-service.ts / membership-service.ts.
// --------------------------------------------------------------------------

// One demoted row, as returned by a sweep pass's `UPDATE ... RETURNING`. Carries
// the PRE-update `health_state` (captured in the locking subquery — `RETURNING`
// alone would give the NEW value) plus the LEFT-joined active-attachment session
// id (NULL when the node has no active attachment — see the join rationale in the
// header). `last_heartbeat_at` is the demoting timestamp the offline transition
// carries forward as `lastHeartbeatAt`.
interface DemotedPresenceRow {
  readonly node_id: string;
  readonly previous_health_state: string;
  readonly last_heartbeat_at: Date | string;
  readonly session_id: string | null;
}

// `TIMESTAMPTZ` is hydrated as a JS `Date` by `pg` and as an ISO 8601 string by
// PGlite. Every consumer of `last_heartbeat_at` (the transition record's
// `lastHeartbeatAt: string`) needs ISO 8601, so normalize both forms. Mirrors
// `toIsoString` in attach-service.ts:149 / membership-service.ts — the Date-vs-
// string substrate difference is invisible to the PGlite test surface (which only
// ever sees a string), so normalizing uniformly is what keeps the `pg.Pool`
// production surface correct.
function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

// --------------------------------------------------------------------------
// Transition record — the discrete-field observation surface (NOT a pre-built
// payload).
// --------------------------------------------------------------------------
//
// Mirrors `PresenceTransitionEvent` (presence-register-service.ts:478-485): the
// seam carries DISCRETE FIELDS (`from`, `to`, `nodeId`, …), not a constructed
// `runtime_node.degraded` / `.offline` payload. Constructing the payload object
// (stamping `degradedCapabilities` / `detail`, validating with `.parse()`,
// appending) is the daemon-side writer's job (Plan-006 Tier 4) — that boundary is
// ADR-017 (the control plane has no event log). The discrete fields here map
// zero-impedance onto the daemon `EmitOfflineInput` / `EmitDegradedInput` discrete
// shapes (`node-event-emitter.ts`), so the writer reads these fields straight
// across.
//
// `nodeId` is the contract `NodeId` brand; `from` / `to` are
// `RuntimeNodeHealthState` UNIONED with `"offline"`: `runtime_node_presence.
// health_state` admits `online | degraded | offline` (0003-runtime-nodes.ts:139),
// and a transition's endpoints are exactly those three values — `offline` is a
// valid `to` (the offline demote) and a possible `from` is `online` or `degraded`
// (never `offline`, since the offline pass excludes already-`offline` rows and the
// degraded pass excludes `degraded | offline`). We do NOT reuse `NodeState` (the 5-
// value attachment-state union incl. `registering` / `revoked`): presence health
// is the THREE-value axis, and `registering` / `revoked` are attachment-state
// values that never appear in `runtime_node_presence.health_state`.
export type RuntimeNodePresenceHealth = RuntimeNodeHealthState | "offline";

export interface RuntimeNodeStalenessTransition {
  // The node whose presence health changed.
  readonly nodeId: NodeId;
  // The node's single active-attachment session, if any (I-003-5 → ≤1). Absent
  // when the node holds no active attachment — the lifecycle event is then
  // node-scoped / session-agnostic (see the join rationale in the header).
  readonly sessionId?: SessionId | undefined;
  // Pre-sweep stored health (`online` or `degraded` — never `offline`, per the
  // pass exclusions above).
  readonly from: RuntimeNodePresenceHealth;
  // Post-sweep stored health (`degraded` or `offline`).
  readonly to: RuntimeNodePresenceHealth;
  // The demoting node's most recent heartbeat (ISO 8601). This is the OFFLINE
  // payload's `lastHeartbeatAt` evidence; carried on every transition so the
  // writer has it without a second read.
  readonly lastHeartbeatAt: string;
  // The offline `reason` — present ONLY on an `offline` transition (always
  // `heartbeat_lost` from this sweep). ABSENT on a `degraded` transition: the
  // `runtime_node.degraded` payload has no `reason` field (it carries
  // `degradedCapabilities` / `detail` instead — synthesized by the writer, NOT
  // on this seam). Optional so a degraded transition does not carry a bogus
  // reason; type-bound to the offline payload's `reason` union.
  readonly reason?: RuntimeNodeOfflinePayload["reason"] | undefined;
}

// --------------------------------------------------------------------------
// Constructor options. ALL optional — `new HeartbeatService(querier)` with no
// options is a valid single-node / no-observer configuration (the sweep mutates
// the snapshot and surfaces nothing). Mirrors PresenceRegisterServiceOptions.
// --------------------------------------------------------------------------
export interface HeartbeatServiceOptions {
  // Observation seam for the durable `runtime_node.degraded` / `.offline` append.
  // Invoked once per genuine state change the sweep applies, AFTER the sweep
  // transaction commits. The return type admits `Promise<void>` because the
  // daemon-side writer wires this to an async append; `sweepStaleNodes` catches
  // BOTH a sync throw and an async rejection PER NODE so one failing observer
  // neither aborts the remaining nodes nor crashes the process on the detached
  // timer boundary. A plain `() => void` callback still satisfies it.
  readonly onTransition?: (transition: RuntimeNodeStalenessTransition) => void | Promise<void>;
  // Staleness thresholds (Spec-003 line 60 defaults: `30s` / `60s`). Read as the
  // age (ms) of the most recent heartbeat at which the node demotes to `degraded`
  // / `offline`. `offlineAfterMs` MUST be >= `degradedAfterMs` for the two-band
  // hysteresis to be well-ordered (asserted in the constructor).
  readonly degradedAfterMs?: number;
  readonly offlineAfterMs?: number;
  // Sweep cadence (Plan-003 T3.6 default: `5s`). The `start()` interval period.
  // Ignored by a direct `sweepStaleNodes()` call (tests drive the sweep directly,
  // bypassing the timer — see the test file).
  readonly sweepIntervalMs?: number;
}

export class HeartbeatService {
  readonly #querier: Querier;
  readonly #onTransition:
    | ((transition: RuntimeNodeStalenessTransition) => void | Promise<void>)
    | undefined;
  readonly #degradedAfterMs: number;
  readonly #offlineAfterMs: number;
  readonly #sweepIntervalMs: number;

  // The `start()` timer handle, or undefined when the sweep loop is not running.
  // `setInterval` returns a `NodeJS.Timeout`; we hold the opaque handle and clear
  // it in `stop()`. Mutable — it is the one piece of instance state that changes
  // over the service lifetime.
  #sweepTimer: ReturnType<typeof setInterval> | undefined = undefined;

  constructor(querier: Querier, options: HeartbeatServiceOptions = {}) {
    this.#querier = querier;
    this.#onTransition = options.onTransition;
    this.#degradedAfterMs = options.degradedAfterMs ?? RUNTIME_NODE_DEGRADED_AFTER_MS;
    this.#offlineAfterMs = options.offlineAfterMs ?? RUNTIME_NODE_OFFLINE_AFTER_MS;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? RUNTIME_NODE_SWEEP_INTERVAL_MS;

    // Hysteresis well-ordering (Spec-003 line 60: the `30s` degraded band sits
    // BELOW the `60s` offline band). If a caller inverts them the two-pass sweep
    // would be incoherent (the degraded pass could fire on a row the offline pass
    // already claimed, or never fire at all) — fail LOUD at construction rather
    // than silently mis-demote at runtime. Equal is permitted (a degenerate
    // single-band configuration), strictly-less is the bug.
    if (this.#offlineAfterMs < this.#degradedAfterMs) {
      throw new Error(
        `HeartbeatService: offlineAfterMs (${String(this.#offlineAfterMs)}) must be >= degradedAfterMs (${String(this.#degradedAfterMs)}) — the offline staleness band sits at or beyond the degraded band (Spec-003 line 60).`,
      );
    }
  }

  /**
   * Ingest a runtime-node heartbeat (Spec-003 line 59 cadence). UPSERTs the
   * node's `runtime_node_presence` row, stamping `last_heartbeat_at` with the
   * SERVER clock (`now()`) — NEVER a daemon-supplied timestamp (Spec-003 line 61:
   * health is server-derived, never self-reported). The stored `health_state` is
   * set to the node's self-reported REACHABLE level (`online` / `degraded`),
   * which also CLEARS any prior staleness demotion — a recovered node is promoted
   * back out of `degraded`/`offline` by its own next heartbeat, and the sweep
   * (demote-only) re-demotes only if it ages out again. EMITS NOTHING (ADR-017 —
   * the control plane has no event log; the durable append is the daemon's).
   *
   * @param request the validated-at-boundary `RuntimeNodeHeartbeatRequest`
   *   (`{ nodeId, healthState }`).
   */
  async recordHeartbeat(request: RuntimeNodeHeartbeatRequest): Promise<void> {
    // Trust-boundary validation — parse rather than trust the caller (mirrors
    // AttachService.attach). Surfaces schema drift before any row is written.
    const validated: RuntimeNodeHeartbeatRequest = RuntimeNodeHeartbeatRequestSchema.parse(request);

    // UPSERT the snapshot. `last_heartbeat_at = now()` is the SERVER clock — the
    // request carries NO timestamp, so there is nothing self-reported to trust
    // (Spec-003 line 61). `health_state = EXCLUDED.health_state` writes the node's
    // self-reported reachable level on every beat, which is what promotes a
    // previously-demoted node back to its reachable state (the sweep never
    // promotes). A first heartbeat INSERTs; a subsequent one updates in place.
    await this.#querier.query(
      `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at, health_state)
         VALUES ($1, now(), $2)
       ON CONFLICT (node_id) DO UPDATE
         SET last_heartbeat_at = now(),
             health_state      = EXCLUDED.health_state`,
      [validated.nodeId, validated.healthState satisfies RuntimeNodeHealthState],
    );
  }

  /**
   * Run ONE staleness sweep (Spec-003 line 61). DEMOTE-ONLY: evaluates every
   * `runtime_node_presence` row against the SERVER clock and demotes a node whose
   * most recent heartbeat aged past the `degradedAfterMs` / `offlineAfterMs`
   * thresholds (Spec-003 line 60). Returns the transitions it applied (also
   * surfaced individually via `onTransition`), so a direct caller (tests, an ops
   * trigger) can observe the sweep result without the observer seam.
   *
   * The two demote passes run in ONE `transaction()` so Postgres `now()` is stable
   * across both (a boundary node is classified once) and the offline pass's writes
   * are visible to the degraded pass (which excludes them) — see the SQL-side /
   * transactional rationale in the file header. `onTransition` is fired AFTER the
   * transaction commits, once per applied transition, each in its own crash guard.
   *
   * @returns the applied transitions (empty when no node aged out).
   */
  async sweepStaleNodes(): Promise<ReadonlyArray<RuntimeNodeStalenessTransition>> {
    // Convert each band to seconds for `make_interval(secs => $1)`. Pass the
    // FRACTIONAL value (no `Math.floor`): `make_interval`'s `secs` is `double
    // precision`, so the conversion is exact (30000→30.0, 60000→60.0 unchanged) AND
    // a future sub-second ops-knob override (e.g. `degradedAfterMs: 500`→0.5) lands
    // correctly. Flooring would collapse any sub-second band to `0`, turning the
    // staleness predicate into `last_heartbeat_at < now()` — which matches EVERY
    // row and mass-demotes the whole fleet on one sweep. The only constructor guard
    // is `offlineAfterMs >= degradedAfterMs`, so that floor-to-zero footgun is real
    // for any sub-second config; fractional seconds remove it at the source.
    const degradedAfterSeconds: number = this.#degradedAfterMs / 1000;
    const offlineAfterSeconds: number = this.#offlineAfterMs / 1000;

    // (1) Apply both demote passes atomically. Collect the transition records
    // INSIDE the txn; fire observers AFTER commit (step 2) so a blocking/throwing
    // observer can neither hold the row locks nor roll back a demotion.
    const transitions: RuntimeNodeStalenessTransition[] = await this.#querier.transaction(
      async (transaction) => {
        // OFFLINE PASS FIRST. Demote every reachable (`health_state != 'offline'`)
        // node whose heartbeat is older than the offline band. The inner
        // `SELECT ... FOR UPDATE` locks the target rows (serializing against a
        // concurrent `recordHeartbeat` UPSERT — a heartbeat landing mid-sweep
        // blocks until commit, so it cannot be clobbered) AND captures the
        // PRE-update `health_state` as `previous_health_state` (`RETURNING` alone
        // gives the NEW value). The LEFT JOIN resolves the node's single active-
        // attachment session (I-003-5 → ≤1; predicate = the active index's). The
        // threshold lives in SQL against `now()` so the staleness clock is the DB
        // clock, not the app's. `$1` = the offline-band second count.
        const offlineResult = await transaction.query<DemotedPresenceRow>(
          `UPDATE runtime_node_presence AS presence
              SET health_state = 'offline'
             FROM (
               SELECT stale.node_id,
                      stale.health_state AS previous_health_state,
                      stale.last_heartbeat_at,
                      active.session_id AS session_id
                 FROM runtime_node_presence AS stale
                 LEFT JOIN runtime_node_attachments AS active
                   ON active.node_id = stale.node_id
                  AND active.state IN ('registering', 'online', 'degraded')
                WHERE stale.health_state <> 'offline'
                  AND stale.last_heartbeat_at < now() - make_interval(secs => $1)
                FOR UPDATE OF stale
             ) AS prior
            WHERE presence.node_id = prior.node_id
          RETURNING presence.node_id,
                    prior.previous_health_state,
                    prior.last_heartbeat_at,
                    prior.session_id`,
          [offlineAfterSeconds],
        );

        // DEGRADED PASS. Demote every still-reachable node aged past the degraded
        // band but NOT YET past the offline band. The `health_state NOT IN
        // ('degraded', 'offline')` predicate excludes (a) nodes already at
        // `degraded` (emit-once — no re-emit on a node already there) and (b) the
        // rows the offline pass just wrote in THIS txn (a transaction sees its own
        // writes), so a node that crossed BOTH thresholds is offlined only, never
        // degraded-then-offlined. Same lock-and-capture subquery shape. `$1` = the
        // degraded-band second count.
        const degradedResult = await transaction.query<DemotedPresenceRow>(
          `UPDATE runtime_node_presence AS presence
              SET health_state = 'degraded'
             FROM (
               SELECT stale.node_id,
                      stale.health_state AS previous_health_state,
                      stale.last_heartbeat_at,
                      active.session_id AS session_id
                 FROM runtime_node_presence AS stale
                 LEFT JOIN runtime_node_attachments AS active
                   ON active.node_id = stale.node_id
                  AND active.state IN ('registering', 'online', 'degraded')
                WHERE stale.health_state NOT IN ('degraded', 'offline')
                  AND stale.last_heartbeat_at < now() - make_interval(secs => $1)
                FOR UPDATE OF stale
             ) AS prior
            WHERE presence.node_id = prior.node_id
          RETURNING presence.node_id,
                    prior.previous_health_state,
                    prior.last_heartbeat_at,
                    prior.session_id`,
          [degradedAfterSeconds],
        );

        const applied: RuntimeNodeStalenessTransition[] = [];
        for (const row of offlineResult.rows) {
          applied.push(this.#toTransition(row, "offline"));
        }
        for (const row of degradedResult.rows) {
          applied.push(this.#toTransition(row, "degraded"));
        }
        return applied;
      },
    );

    // (2) Surface each applied transition via the observer seam, AFTER commit.
    // Per-node crash guard (NOT one guard around the whole loop): one observer
    // that throws (sync) or rejects (async) must not abort the notifications for
    // the remaining nodes (the demotions are already durably committed). This
    // mirrors the PresenceRegisterService crash-guard contract exactly
    // (presence-register-service.ts:1106-1132): try/catch the sync throw,
    // duck-type the returned thenable and route its async rejection through
    // `Promise.resolve(thenable).catch(...)`. There is no structured logger in the
    // control plane today; `console.error` flips to it when one lands.
    // TRIPWIRE: replace `console.error` once a structured logger surfaces.
    if (this.#onTransition !== undefined) {
      for (const transition of transitions) {
        this.#notify(transition);
      }
    }

    return transitions;
  }

  /**
   * Start the periodic staleness sweep (Plan-003 T3.6 — every `sweepIntervalMs`,
   * default `5s`). Idempotent: a second `start()` while already running is a
   * no-op (it does not stack a second interval). The timer is `unref`'d so a
   * running sweep loop does not by itself keep the Node process alive (the daemon
   * owns process lifetime; the sweep is a background task).
   *
   * The detached `setInterval` callback drives `sweepStaleNodes()`, whose returned
   * promise is discharged with its OWN `.catch` — separate from the per-transition
   * crash guard. The per-transition guard only protects the `onTransition`
   * observer; the SWEEP promise itself can reject (the database is unreachable, a
   * lock times out), and an unhandled rejection escaping a detached timer callback
   * would surface as an `unhandledRejection` / crash the process. The scheduler-
   * level `.catch` keeps the loop alive across a transient DB failure — the next
   * tick retries. TRIPWIRE: replace `console.error` once a structured logger lands.
   */
  start(): void {
    if (this.#sweepTimer !== undefined) {
      return;
    }
    this.#sweepTimer = setInterval(() => {
      void this.sweepStaleNodes().catch((error: unknown) => {
        console.error(
          "[runtime-node] heartbeat staleness sweep failed (swallowed to keep the sweep loop alive); the next tick retries",
          error,
        );
      });
    }, this.#sweepIntervalMs);
    // Do not let the sweep timer alone hold the event loop open.
    this.#sweepTimer.unref?.();
  }

  /**
   * Stop the periodic staleness sweep. Idempotent: calling `stop()` when not
   * running is a no-op. Clears the interval and drops the handle. An in-flight
   * `sweepStaleNodes()` already dispatched by the last tick runs to completion
   * (its `.catch` still guards it); `stop()` only prevents FUTURE ticks.
   */
  stop(): void {
    if (this.#sweepTimer === undefined) {
      return;
    }
    clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
  }

  // ------------------------------------------------------------------------
  // Internal helpers.
  // ------------------------------------------------------------------------

  // Build a transition record from a demoted row + its target state. Narrows the
  // raw `previous_health_state` string (a DB scalar) to `RuntimeNodePresenceHealth`
  // and brands the ids — the row's `health_state` CHECK (online|degraded|offline,
  // 0003-runtime-nodes.ts:139) guarantees the cast is sound, and the pass
  // exclusions guarantee `from` is `online`/`degraded` (never `offline`). The
  // `reason` is stamped ONLY for the `offline` target (always `heartbeat_lost` —
  // a staleness-driven offline); the `degraded` target carries no `reason`.
  #toTransition(
    row: DemotedPresenceRow,
    to: RuntimeNodePresenceHealth,
  ): RuntimeNodeStalenessTransition {
    return {
      nodeId: row.node_id as NodeId,
      // `?? undefined`: the LEFT JOIN yields SQL NULL (hydrated as JS `null`) when
      // the node has no active attachment; the optional `sessionId` is `undefined`
      // in that case, never `null` (the contract `sessionId?` is `SessionId |
      // undefined`).
      sessionId: row.session_id === null ? undefined : (row.session_id as SessionId),
      from: row.previous_health_state as RuntimeNodePresenceHealth,
      to,
      lastHeartbeatAt: toIsoString(row.last_heartbeat_at),
      reason: to === "offline" ? HEARTBEAT_LOST_REASON : undefined,
    };
  }

  // Fire the `onTransition` observer for a single transition with the full crash
  // guard (sync throw + async rejection). Mirrors
  // PresenceRegisterService.#transition's observer dispatch
  // (presence-register-service.ts:1106-1132). Called only when `#onTransition` is
  // defined (the caller guards), and only AFTER the sweep txn has committed.
  #notify(transition: RuntimeNodeStalenessTransition): void {
    try {
      const observerResult: void | Promise<void> = this.#onTransition?.(transition);
      // Duck-type the thenable (NOT `instanceof Promise`) so a non-native thenable
      // a userland observer returns is still routed. Discharge via
      // `Promise.resolve(thenable).catch(...)`, NOT a direct `.catch` on the value:
      // the PromiseLike contract only requires `.then`, so a `.then`-only thenable
      // has no `.catch` and a direct call would throw a TypeError the outer
      // try/catch would mislabel "(sync)". `Promise.resolve` absorbs any thenable
      // into a native Promise whose `.catch` is guaranteed to exist.
      if (
        observerResult !== undefined &&
        observerResult !== null &&
        typeof (observerResult as { then?: unknown }).then === "function"
      ) {
        Promise.resolve(observerResult as PromiseLike<void>).catch((error: unknown) => {
          console.error(
            `[runtime-node] onTransition observer rejected (async); staleness transition notification dropped (swallowed to keep the sweep alive) for nodeId=${String(transition.nodeId)} from=${transition.from} to=${transition.to}`,
            error,
          );
        });
      }
    } catch (error) {
      console.error(
        `[runtime-node] onTransition observer threw (sync); staleness transition notification dropped (swallowed to keep the sweep alive) for nodeId=${String(transition.nodeId)} from=${transition.from} to=${transition.to}`,
        error,
      );
    }
  }
}

// --------------------------------------------------------------------------
// pg.Pool -> HeartbeatService factory
// --------------------------------------------------------------------------
//
// Production-wiring one-liner: composes a `Querier` from a `pg.Pool` via the
// shared `createPgPoolQuerier` adapter Plan-001 owns and constructs the service,
// mirroring `createAttachServiceFromPool` / `createMembershipServiceFromPool`.
// The sweep's per-pass `FOR UPDATE` locks inherit the held-client transaction
// semantics that adapter documents (BEGIN/COMMIT/ROLLBACK on one connection) — the
// lock that serializes the ingest-vs-sweep race is held only for the life of its
// transaction, so the two demote passes MUST run on the one held client, which the
// `Querier.transaction(...)` boundary guarantees.

/**
 * Compose a `HeartbeatService` from a `pg.Pool`.
 *
 * @param pool the control-plane `pg.Pool`.
 * @param options the service options (observer seam + timing overrides). Optional
 *   — omit for a no-observer, default-timing configuration.
 */
export function createHeartbeatServiceFromPool(
  pool: Pool,
  options: HeartbeatServiceOptions = {},
): HeartbeatService {
  return new HeartbeatService(createPgPoolQuerier(pool), options);
}
