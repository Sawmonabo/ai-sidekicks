// Daemon bootstrap orchestrator — sequences `SecureDefaults.load` ahead of any
// listener bind, and exposes the load-before-bind guard seam Phase 2's
// gateway will consume.
//
// This module owns invariant at its orchestrator surface (canonical
// text):
//   `SecureDefaults.load(config)` MUST run before any daemon listener
//   binds. Attempting to bind a listener before `SecureDefaults.load`
//   completes is a programmer error and MUST throw.
//
// Row 4 (loopback bind by default — daemon).
//
// Architectural pointer. There is no real `bind()` operation in
// this PR — a later phase ships the `local-ipc-gateway` listener. This file
// ships the orchestrator pattern + the `assertLoadedForBind()` guard
// SEAM that Phase 2's gateway is expected to call as the first line of
// its bind path. The runtime guard rests on the `SecureDefaults`
// module-singleton state (`SecureDefaults.isLoaded()`); see the
// decision rationale below.
//
// What this module does NOT do (deferred):
//   * Open any listener / call any `bind()` — Phase 2.
//   * The sink is wired by the Phase 2 path that owns the
//     actual override-emission sites.
//   * Re-export `bootstrap` / `assertLoadedForBind` from the package
//     root (`packages/runtime-daemon/src/index.ts`). Phase 2 / picks up
//     the consumer surface when it needs it.
//
// Decision: stateless guard helper (`assertLoadedForBind`) + sequence
// orchestrator (`bootstrap`).
//
// Recommendation: Option A — `bootstrap(config): void` runs
// `SecureDefaults.load(config)`; `assertLoadedForBind(): void` is a
// stateless helper Phase 2's gateway calls at the top of its bind path.
//
// Alternative considered: Option B — `bootstrap(config): BootstrapHandle`
// where the handle is a required arg to bind paths (proof-of-load by
// type).
//
// Why Option A wins: the `SecureDefaults` module already owns the
// load-state singleton (`SecureDefaults.isLoaded()`); a `BootstrapHandle`
// would duplicate that state in a wrapper without adding runtime
// enforcement — handle-as-evidence is a TypeScript-only convention,
// not a runtime guard, and Phase 2's gateway could construct/import
// one out-of-band. The throw belongs at the orchestrator surface rather
// than as a type-level constraint, so the test asserts against a
// callable that materializes that throw. Option A
// also lets every future bind path call `assertLoadedForBind()`
// synchronously without threading a handle through constructors.
//
// Trade-off accepted: Phase 2's gateway must remember to call
// `assertLoadedForBind()` at the top of its bind path. The test
// asserts the orchestrator-level throw; gateway-level
// enforcement (the actual call site) is a Phase 2 review concern. That
// boundary is correct — this ships the seam, a later phase widens it.

// Imports below serve the sanctioned retention-sweeper wiring call at the foot
// of this file, and nothing else here.
import type {
  TurnSnapshotRetentionSweepHandle,
  TurnSnapshotRetentionSweepResult,
  TurnSnapshotServiceDeps,
} from "../git/turn-snapshot-service.js";
import {
  TurnSnapshotService,
  registerTurnSnapshotRetentionSweep,
} from "../git/turn-snapshot-service.js";

import type { SecureDefaultsConfig } from "./secure-defaults.js";
import { SecureDefaults } from "./secure-defaults.js";

/**
 * Run the daemon bootstrap sequence.
 *
 * The sequence is a single step — `SecureDefaults.load(config)` —
 * which MUST precede any listener `bind()`. Phase 2 will extend this
 * orchestrator with the gateway / registry construction steps; those
 * steps land AFTER `SecureDefaults.load(config)` returns, never before.
 *
 * Daemon-as-execution-authority context: the local runtime daemon is
 * the machine-local execution authority for worktree-backed runs
 * (`accepted` 2026-04-15, worktree-first writable execution mode). The
 * bootstrap sequence governs every listener the daemon exposes to the
 * client SDK + CLI + desktop shell; running `SecureDefaults.load` first
 * guarantees the validated bind surface (row 4 loopback-only) is in
 * force before any IPC entry point is reachable.
 *
 * Idempotency: a second `bootstrap` call re-runs `SecureDefaults.load`
 * (which itself replaces the previously loaded settings on success per
 * its idempotency contract). This module's contract is "the most
 * recent successful bootstrap wins"; production callers SHOULD invoke
 * `bootstrap` exactly once per daemon process lifetime.
 *
 * Throws `SecureDefaultsValidationError` on any validation failure
 * (fail-closed) — the previous loaded state, if any, is preserved
 * on failure (see `SecureDefaults.load`).
 *
 * Returns `void` deliberately. Downstream consumers read
 * `SecureDefaults.effectiveSettings()` directly when they need the
 * validated view; making `bootstrap` a value-producer would echo
 * Option B's handle pattern this module rejected above.
 */
export function bootstrap(config: SecureDefaultsConfig): void {
  // `SecureDefaults.load` runs FIRST so every listener the daemon subsequently
  // exposes is gated on the validated bind surface (loopback-only today).
  SecureDefaults.load(config);
}

/**
 * Phase 2's `local-ipc-gateway` is expected to call this as the
 * first line of its bind path; any future listener (HTTP,
 * non-loopback, TLS) does the same.
 *
 * Enforces at runtime by checking the `SecureDefaults`
 * module-singleton load state. A bootstrap-order inversion that calls
 * `bind()` before `SecureDefaults.load(config)` completes throws here
 * — the bootstrap orchestrator throws on an attempted bind without a
 * prior `SecureDefaults.load` completion, and that is the surface the
 * test asserts against.
 *
 * Synchronous + side-effect-free on the success path. The throw is a
 * programmer-error guard, not a recoverable failure mode — callers
 * MUST NOT `try`/`catch` it to retry; the correct fix is to invoke
 * `bootstrap(config)` (or `SecureDefaults.load(config)` directly)
 * earlier in the daemon's startup sequence.
 *
 * There is NO real `bind()` operation yet — Phase 2 ships the listener.
 * This guard exists specifically so the load-before-bind SEAM is
 * testable now and consumable by Phase 2 without a re-implementation
 * pass.
 */
export function assertLoadedForBind(): void {
  if (!SecureDefaults.isLoaded()) {
    throw new Error(
      "assertLoadedForBind: SecureDefaults.load(config) must complete before any listener bind()",
    );
  }
}

// ---------------------------------------------------------------------------
// The sanctioned turn-snapshot retention-sweeper wiring call
// ---------------------------------------------------------------------------
//
// A WIRING CALL, NOT OWNERSHIP. `packages/runtime-daemon/src/bootstrap/` is the
// single-owner directory `index.ts` for this sweeper, alongside the five
// `registerOnboarding*(registry, deps)` calls and the events wiring call.
//
// The shape follows those two precedents rather than inventing one. the
// `register*` functions live in its own namespace and only the CALL wires here;
// the sanctioned edit "constructs an `EventLogService`" in this very file and "a
// wiring call, not ownership". Importing the module into this file is the
// sanctioned shape, not a back door.
//
// TWO CLAUSES OF ROW ARE NOT SEQUENCED HERE — one satisfied elsewhere, one
// genuinely deferred. Named rather than dropped:
//
//   * "ordered after migrations" — MOVED, not deferred. This function takes an
//     already-open handle, which puts the ordering in the parameter where a
//     caller can see it rather than in a comment; `openDatabase` applies the
//     migrations, so the ordinary way to obtain that handle satisfies it. What is
//     NOT claimed: a handle opened some other way, without migrations, is still
//     the caller's mistake to avoid. It is not a quiet one — the service prepares
//     its retention statements in its CONSTRUCTOR, so an un-migrated handle
//     throws `SqliteError: no such table: run_execution_contexts` straight out of
//     this call, at wiring time. That is the better failure (it lands at the
//     composition root, not an hour later in a diagnostic nobody is watching),
//     but it is a THROW, and the @throws block below names it. The
//     `bootstrap()` above could not have delivered even this much: it runs
//     `SecureDefaults.load` and nothing else, with no migrations step in it.
//   * "dispose it on shutdown" — DEFERRED. This module has no shutdown surface
//     to hook: there is no `shutdown()` here and no composition root that owns
//     one (Phase 2 brings the listener lifecycle, per the header above).
//     The handle is RETURNED for that reason, so the disposal obligation is on
//     the caller and visible in the type rather than silently unowned. The
//     interval is `unref`'d as the interim backstop.
//
// The wiring call is not reachable from `bootstrap()` today, and deliberately is
// not folded into it: `bootstrap(config)` takes no database, and giving it one
// would change a function's signature — ownership, exactly what.

/** What a composition root hands {@link wireTurnSnapshotRetentionSweep}. */
export interface TurnSnapshotRetentionWiring {
  /**
   * Its own dependency bag, passed through verbatim — except that `database` is
   * REQUIRED here, where the service leaves it optional. The service is right
   * to: a turn-boundary capture/restore wiring holds no handle at all. A
   * SWEEPER without one is only ever a wiring defect, so the constraint is
   * carried in the type rather than in prose, and the runtime guard below stays
   * as the answer for an untyped caller.
   *
   * `retentionWindowMs` is the daemon-config retention window; omitting it takes
   * the exported default.
   */
  readonly turnSnapshot: TurnSnapshotServiceDeps &
    Required<Pick<TurnSnapshotServiceDeps, "database">>;
  /**
   * Omitted takes the `DEFAULT_TURN_SNAPSHOT_SWEEP_CADENCE_MS`; the registrar
   * refuses a value the platform's timers would silently reinterpret.
   */
  readonly sweepCadenceMs?: number;
}

/**
 * Construct the turn-snapshot retention sweeper with the daemon's configured
 * window and cadence, and start it.
 *
 * The whole of this file's edit. Returns the handle so the caller can dispose
 * the sweeper at shutdown (see the deferral note above).
 *
 * @throws TypeError when no `database` was supplied. The parameter type already
 * refuses this for a typed caller; the guard is what answers an untyped one. The
 * service itself tolerates the absence — a turn-boundary service holds no handle
 * at all — but a SWEEPER without one cannot answer the retention question and
 * would spend the daemon's life reporting a wiring defect once an hour. Refused
 * at the moment the mistake is made instead. @throws RangeError from the
 * constructor or the registrar for a retention window or a sweep cadence outside
 * its accepted range. @throws SqliteError (`no such table:
 * run_execution_contexts`) when the handle is open but un-migrated: the service
 * prepares its retention statements in the constructor, so schema drift surfaces
 * here rather than at the first sweep.
 */
export function wireTurnSnapshotRetentionSweep(
  wiring: TurnSnapshotRetentionWiring,
): TurnSnapshotRetentionSweepHandle {
  if (wiring.turnSnapshot.database === undefined) {
    throw new TypeError(
      "wireTurnSnapshotRetentionSweep: the retention sweeper needs an open `database` " +
        "(migrations applied) — a sweeper without one can only report the wiring defect",
    );
  }
  const turnSnapshotService: TurnSnapshotService = new TurnSnapshotService(wiring.turnSnapshot);
  return registerTurnSnapshotRetentionSweep({
    runRetentionSweep: (): Promise<TurnSnapshotRetentionSweepResult> =>
      turnSnapshotService.sweepPrunableRuns(),
    ...(wiring.sweepCadenceMs === undefined ? {} : { sweepCadenceMs: wiring.sweepCadenceMs }),
  });
}
