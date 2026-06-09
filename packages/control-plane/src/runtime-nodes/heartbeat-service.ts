// HeartbeatService — Plan-003 Phase 3 (T3.6, runtime-node presence ingestion +
// sweep-driven degraded/offline transitions).
//
// Responsibilities (this task, T3.6) — the runtime-node LIVENESS axis on the
// coordination record `runtime_node_presence`, distinct from the attachment-slot
// axis (`runtime_node_attachments.state`) that AttachService / detach own:
//
//   * ingest — the daemon's periodic 15s heartbeat self-report (Spec-003
//     line 59). Upserts the node's `runtime_node_presence` row with the SERVER
//     clock (`now()`) and the daemon's 2-value self-reported `health_state`
//     (`online | degraded`). This is also the HYSTERESIS-RECOVERY path: a node
//     the sweep demoted to `degraded` that resumes heartbeating (reporting
//     `online`) is restored to `online` and its `last_heartbeat_at` bumped —
//     recovering WITHOUT ever passing through `offline` (Spec-003 line 60).
//
//   * sweepStaleness — the periodic, SERVER-DERIVED demotion (Spec-003
//     line 61). A single `UPDATE ... RETURNING` that demotes rows whose
//     `last_heartbeat_at` aged past the thresholds: `degraded` past 30s
//     (≈2 missed 15s beats), `offline` past 60s (≈4 missed beats). Demotion is
//     SWEEP-driven, never ingest-driven — a dead node sends nothing, so ingest
//     cannot demote it. The sweep ONLY demotes (it never restores `online`;
//     that is ingest's job), and it writes ONLY `runtime_node_presence` — there
//     is NO durable `runtime_node.*` session event for these transitions in V1
//     (gated to V1.1 per ADR-017 §Server-Derived Runtime-Node Lifecycle Events).
//
// Why these are single SQL statements (no `Querier.transaction(...)` wrapper):
//   Each method is ONE statement, which Postgres already executes atomically.
//   AttachService wraps a transaction only because it does read-floor-then-
//   upsert (multi-statement, needing one commit boundary). Wrapping a single
//   statement here would be cargo-culting the transaction without a multi-
//   statement invariant to protect.
//
// Server clock, not JS `Date`: both methods use SQL `now()` (the Postgres
// transaction-start timestamp) so `last_heartbeat_at` and the staleness math
// share ONE clock — consistent with `runtime_node_attachments.attached_at`
// (0003-runtime-nodes.ts line 111). A JS `Date` passed from the service would
// drift against the database clock and split the comparison across two clocks.
//
// Dependency injection (mirrors AttachService / MembershipService): the minimal
// `Querier` SQL surface declared in `sessions/migration-runner.ts`. The service
// body NEVER imports `pg`; the test substrate (in-process PGlite) and the
// eventual production surface (`pg.Pool`) stay interchangeable without a runtime
// branch.
//
// Cross-task boundaries (DO NOT CROSS in T3.6):
//   * The PERIODIC INVOCATION of `sweepStaleness()` — the Cloudflare Cron wiring
//     that calls it every `STALENESS_SWEEP_INTERVAL_MS` on the running host —
//     requires the production Querier (deferred to Tier 5; host.ts's production
//     surface throws on Querier use per I-008-2) plus Cloudflare Cron
//     deployment config (wrangler.toml `[triggers]` + a `scheduled()` Worker
//     export). It is NOT wired in Plan-003 Phase 3 — a scheduler driving the
//     sweep against the throwing placeholder Querier would be dead code. This
//     service ships the callable method + the interval constant ONLY; it has NO
//     `start()`/`stop()`/`setInterval` lifecycle (Cloudflare Workers are
//     request-scoped; the scheduling mechanism is environment-specific
//     deployment wiring, not service logic).
//   * The tRPC `runtimenode.heartbeat` procedure + router — owned by T3.8.
//     `ingest` returns `void`; the router maps it to the wire `null`
//     (`RuntimeNodeHeartbeatResponseSchema = z.null()`).
//   * `runtime_node_attachments` (the attachment-slot axis) — owned by attach /
//     detach (T3.2 / T3.7). This service touches ONLY `runtime_node_presence`.
//     The read-time roster reconciliation of the two axes
//     (`presence.health_state` liveness × `attachments.state` slot) is a
//     separate downstream concern, not T3.6.
//   * `runtime_node_presence` table DDL — owned by `migrations/0003-runtime-
//     nodes.ts`. This service only INSERT/UPDATEs rows; it never ALTERs the
//     schema.
//
// Refs: Spec-003 §Default Behavior lines 59 (15s cadence / ingestion) / 60
// (degraded@30s, offline@60s, hysteresis) / 61 (server-derived, sweep-driven,
// coordination-record transition, no durable event); ADR-017 §Server-Derived
// Runtime-Node Lifecycle Events (V1.1 event gate); docs/architecture/contracts/
// api-payload-contracts.md §Runtime-Node (RuntimeNodeHeartbeat request/response);
// `runtime-nodes/attach-service.ts` (the `Querier`-injected service idiom this
// mirrors).

import type { RuntimeNodeHeartbeatRequest } from "@ai-sidekicks/contracts";
import { RuntimeNodeHeartbeatRequestSchema } from "@ai-sidekicks/contracts";

import type { Querier } from "../sessions/migration-runner.js";

// Staleness sweep interval. EXPORTED for the eventual sweep scheduler (the
// Cloudflare Cron `scheduled()` wiring is Tier-5/deployment-deferred — see the
// `sweepStaleness()` cross-task boundary note above) to drive the periodic
// `sweepStaleness()` invocation. Set to 5s, FINER than the 15s
// heartbeat cadence (Spec-003 line 59) so a degraded/offline transition is
// recorded within one sweep of the threshold crossing — the Spec-003 line 61
// guarantee that a transition is "recorded within one sweep interval of a
// threshold crossing", with the sweep interval "set finer than the 15s cadence
// to keep that bound tight" (bounds detection lag to ≤5s).
export const STALENESS_SWEEP_INTERVAL_MS = 5_000;

// Demotion thresholds (Spec-003 line 60). A node is demoted to `degraded` once
// its last heartbeat is older than 30s (≈2 missed 15s beats) and to `offline`
// once older than 60s (≈4 missed beats). The 30–60s band is deliberate
// hysteresis: a node whose heartbeats resume within it is restored to `online`
// by `ingest` WITHOUT passing through `offline`.
const DEGRADED_AFTER_SECONDS = 30;
const OFFLINE_AFTER_SECONDS = 60;

// The two states the sweep is permitted to ASSIGN. The sweep ONLY demotes — it
// never assigns `online` (restoration to `online` is `ingest`'s job, Spec-003
// line 60). `offline` is liveness-death and is SERVER-derived here, never
// daemon-self-reported (the wire health enum is `online | degraded` only,
// Spec-003 line 61).
const DEGRADED_STATE = "degraded";
const OFFLINE_STATE = "offline";

// The narrow result type of `sweepStaleness`: only the two states the sweep can
// assign, never `online`. Surfaced for the eventual sweep
// scheduler/observability (Tier-5/deployment-deferred) and the tests.
export interface SweptTransition {
  readonly nodeId: string;
  readonly healthState: "degraded" | "offline";
}

// Internal row shape returned by `pg.Pool#query` / `PGlite#query` for the
// sweep's `RETURNING`. Postgres folds column identifiers to lowercase and the
// schema uses snake_case, so both drivers map onto these keys (mirrors the
// `AttachmentRow` idiom in attach-service.ts).
interface SweptRow {
  readonly node_id: string;
  readonly health_state: string;
}

export class HeartbeatService {
  readonly #querier: Querier;

  constructor(querier: Querier) {
    this.#querier = querier;
  }

  /**
   * Ingest a runtime-node heartbeat (Spec-003 line 59; Plan-003 T3.6).
   *
   * Upserts the node's `runtime_node_presence` row with the SERVER clock
   * (`now()`) and the daemon's 2-value self-reported `health_state`. This is the
   * heartbeat-reception side of the 15s cadence AND the hysteresis-recovery path
   * (Spec-003 line 60): a `degraded` node that resumes heartbeating with
   * `healthState: "online"` is restored to `online` and its `last_heartbeat_at`
   * bumped, recovering WITHOUT passing through `offline`.
   *
   * @param request the heartbeat payload. Validated at the boundary
   *   (`RuntimeNodeHeartbeatRequestSchema.parse`) before any row is written — a
   *   service-layer fail-fast that surfaces schema drift (e.g. an unknown key,
   *   or a daemon attempting to self-report `offline`, which the 2-value wire
   *   enum rejects) before touching the database, mirroring
   *   AttachService.attach's boundary parse.
   * @returns `void`. The wire response is `null`
   *   (`RuntimeNodeHeartbeatResponseSchema = z.null()`); the T3.8 router maps
   *   this `void` to `null`. Deliberately returns no value.
   */
  async ingest(request: RuntimeNodeHeartbeatRequest): Promise<void> {
    // Trust-boundary validation — parse rather than trust the caller. Surfaces
    // schema drift (and rejects a daemon-asserted `offline`, unrepresentable in
    // the 2-value enum) before the upsert, mirroring AttachService.attach.
    const { nodeId, healthState } = RuntimeNodeHeartbeatRequestSchema.parse(request);

    // Single-statement upsert with the SERVER clock. On first heartbeat the
    // INSERT creates the presence row; on every subsequent beat the DO UPDATE
    // bumps `last_heartbeat_at` and overwrites `health_state` with the daemon's
    // current self-report — which is precisely how a sweep-demoted `degraded`
    // row is restored to `online` (the hysteresis-recovery path). `now()` is the
    // Postgres transaction-start timestamp (the SQL function; the JS `now()`
    // restriction does not apply inside SQL text), keeping ingestion and the
    // staleness math on ONE clock.
    await this.#querier.query(
      `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at, health_state)
       VALUES ($1, now(), $2)
       ON CONFLICT (node_id) DO UPDATE
         SET last_heartbeat_at = now(), health_state = $2`,
      [nodeId, healthState],
    );
  }

  /**
   * Sweep stale presence rows and demote them (Spec-003 line 61; Plan-003
   * T3.6). The periodic, SERVER-DERIVED demotion — NOT ingest-driven (a dead
   * node sends nothing, so its demotion MUST come from this sweep).
   *
   * A single `UPDATE ... RETURNING`:
   *   - rows aged > 60s are set to `offline`;
   *   - rows aged 30–60s are set to `degraded`;
   *   - rows aged < 30s are left untouched (they keep their ingest-set state —
   *     the sweep never restores `online`).
   *
   * Idempotent + transition-only: the WHERE clause guards on the COMPUTED
   * TARGET, so a row whose `health_state` already equals its target is NOT
   * rewritten and is NOT returned. A production sweep runs every
   * `STALENESS_SWEEP_INTERVAL_MS` forever; without this guard it would re-write
   * every already-`offline` row and re-report it each tick (write-amplification
   * + observability noise). The `interval '1 second'` multiplications cast the
   * threshold bind params to `int` (`$1::int` etc.) so the `* interval` operator
   * resolves identically on `pg` and PGlite rather than relying on implicit
   * coercion of an untyped bind param.
   *
   * @returns the rows that ACTUALLY transitioned this sweep, each as
   *   `{ nodeId, healthState }` with `healthState` narrowed to
   *   `"degraded" | "offline"` (the sweep never assigns `online`). An empty
   *   array means nothing crossed a threshold (or every stale row was already at
   *   its target). Mapped for the eventual sweep scheduler/observability
   *   (Tier-5/deployment-deferred).
   *
   * Writes ONLY `runtime_node_presence`. Touches NO other table and emits NO
   * durable event (there is no control-plane event log — ADR-017).
   */
  async sweepStaleness(): Promise<ReadonlyArray<SweptTransition>> {
    // Scale note: this is a NON-SARGABLE full-table scan run every
    // `STALENESS_SWEEP_INTERVAL_MS`. The `now() - last_heartbeat_at > interval`
    // predicate cannot use a btree index over the volatile `now()` expression,
    // and there is no index on `last_heartbeat_at`, so every tick scans all of
    // `runtime_node_presence`. Acceptable at V1 runtime-node counts (a handful
    // of rows). Revisit if `runtime_node_presence` grows: a functional/partial
    // index on `last_heartbeat_at` (e.g. `WHERE health_state <> 'offline'`) is
    // worth the write cost only at scale.
    //
    // Why the `health_state <> $4` (offline) guard, separate from the CASE-target
    // guard below: an explicitly-detached node is parked at `offline` with its
    // `last_heartbeat_at` left at the final beat (detach flips the state, not the
    // timestamp). While that beat ages through the 30-60s band the CASE computes
    // `degraded`, so the transition guard alone (`offline <> degraded`) would
    // PROMOTE a retired node back to `degraded` until it crossed 60s. Excluding
    // `offline` rows up front keeps the sweep demotion-only: an `offline` row is
    // terminal for the sweep (only `ingest` can resurrect it). The two guards are
    // complementary, not redundant — the CASE-target guard still suppresses the
    // re-write of a row already AT its computed target (e.g. a `degraded` row in
    // the 30-60s band), which the offline guard does not cover.
    const swept = await this.#querier.query<SweptRow>(
      `UPDATE runtime_node_presence
       SET health_state = CASE
             WHEN now() - last_heartbeat_at > ($2::int * interval '1 second') THEN $4
             ELSE $3
           END
       WHERE now() - last_heartbeat_at > ($1::int * interval '1 second')
         AND health_state <> $4
         AND health_state <> CASE
             WHEN now() - last_heartbeat_at > ($2::int * interval '1 second') THEN $4
             ELSE $3
           END
       RETURNING node_id, health_state`,
      [DEGRADED_AFTER_SECONDS, OFFLINE_AFTER_SECONDS, DEGRADED_STATE, OFFLINE_STATE],
    );

    return swept.rows.map((row) => ({
      nodeId: row.node_id,
      // The WHERE clause guarantees every returned row is at `degraded` or
      // `offline` (the only states the CASE assigns), so this narrowing cast is
      // sound — the sweep never returns an `online` row.
      healthState: row.health_state as "degraded" | "offline",
    }));
  }
}
