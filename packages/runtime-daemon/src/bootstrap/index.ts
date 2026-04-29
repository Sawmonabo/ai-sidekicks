// Daemon bootstrap orchestrator — sequences `SecureDefaults.load` ahead of any
// listener bind, and exposes the load-before-bind guard seam Phase 2's
// gateway will consume.
//
// This module owns the I-007-1 invariant at its orchestrator surface
// (canonical text in docs/plans/007-local-ipc-and-daemon-control.md
// §Invariants lines 65-69):
//   `SecureDefaults.load(config)` MUST run before any daemon listener
//   binds. Attempting to bind a listener before `SecureDefaults.load`
//   completes is a programmer error and MUST throw.
//
// Spec coverage: Spec-027 row 4 (loopback bind by default — daemon).
//
// Tier 1 architectural pointer. There is no real `bind()` operation in
// this PR — Plan-007-partial Phase 2 (T-007p-2-1) ships the
// `local-ipc-gateway` listener. T-007p-1-3 ships the orchestrator
// pattern + the `assertLoadedForBind()` guard SEAM that Phase 2's
// gateway is expected to call as the first line of its bind path. The
// runtime guard rests on the `SecureDefaults` module-singleton state
// (`SecureDefaults.isLoaded()`); see the decision rationale below.
//
// What this module does NOT do (deferred):
//   * Open any listener / call any `bind()` — Phase 2 (T-007p-2-1).
//   * Wire the `SecureDefaultOverrideEmitter` event sink — deferred per
//     the audit-text scope of T-007p-1-3 ("scopes T-007p-1-3 to
//     SecureDefaults.load wiring + the orchestrator throw only"). The
//     sink is wired by the Phase 2 / Tier 4 path that owns the actual
//     override-emission sites.
//   * Re-export `bootstrap` / `assertLoadedForBind` from the package
//     root (`packages/runtime-daemon/src/index.ts`). Phase 2 / Plan-001
//     Phase 5 picks up the consumer surface when it needs it.
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
// one out-of-band. The audit text specifies the throw at the
// orchestrator surface, not a type-level constraint, and W-007p-1-T1
// will assert against a callable that materializes that throw. Option A
// also lets every future bind path call `assertLoadedForBind()`
// synchronously without threading a handle through constructors.
//
// Trade-off accepted: Phase 2's gateway must remember to call
// `assertLoadedForBind()` at the top of its bind path. The W-007p-1-T1
// test (authored by T-007p-1-4) asserts the orchestrator-level throw;
// gateway-level enforcement (the actual call site) is a Phase 2 review
// concern. That boundary is correct — Tier 1 ships the seam, Tier 4
// widens it.

import type { SecureDefaultsConfig } from "./secure-defaults.js";
import { SecureDefaults } from "./secure-defaults.js";

/**
 * Run the daemon bootstrap sequence.
 *
 * Sequence at Tier 1 is a single step — `SecureDefaults.load(config)` —
 * which MUST precede any listener `bind()` per I-007-1. Phase 2 will
 * extend this orchestrator with the gateway / registry construction
 * steps; those steps land AFTER `SecureDefaults.load(config)` returns,
 * never before.
 *
 * Daemon-as-execution-authority context: the local runtime daemon is
 * the machine-local execution authority for worktree-backed runs (see
 * docs/decisions/006-worktree-first-execution-mode.md — ADR-006
 * `accepted` 2026-04-15, worktree-first writable execution mode). The
 * bootstrap sequence governs every listener the daemon exposes to the
 * client SDK + CLI + desktop shell; running `SecureDefaults.load` first
 * guarantees the validated bind surface (Spec-027 row 4 loopback-only)
 * is in force before any IPC entry point is reachable.
 *
 * Idempotency: a second `bootstrap` call re-runs `SecureDefaults.load`
 * (which itself replaces the previously loaded settings on success per
 * its idempotency contract). This module's contract is "the most
 * recent successful bootstrap wins"; production callers SHOULD invoke
 * `bootstrap` exactly once per daemon process lifetime.
 *
 * Throws `SecureDefaultsValidationError` on any validation failure
 * (fail-closed per I-007-2) — the previous loaded state, if any, is
 * preserved on failure (see `SecureDefaults.load`).
 *
 * Returns `void` deliberately. Downstream consumers read
 * `SecureDefaults.effectiveSettings()` directly when they need the
 * validated view; making `bootstrap` a value-producer would echo
 * Option B's handle pattern this module rejected above.
 */
export function bootstrap(config: SecureDefaultsConfig): void {
  // ADR-006 inline citation: the daemon is the worktree-backed
  // execution authority (docs/decisions/006-worktree-first-execution-mode.md).
  // `SecureDefaults.load` runs FIRST so every listener the daemon
  // subsequently exposes is gated on the validated bind surface
  // (Spec-027 row 4, loopback-only at Tier 1) per I-007-1.
  SecureDefaults.load(config);
}

/**
 * Load-before-bind guard. Phase 2's `local-ipc-gateway` (T-007p-2-1)
 * is expected to call this as the first line of its bind path; any
 * future Tier 4 listener (HTTP, non-loopback, TLS) does the same.
 *
 * Enforces I-007-1 at runtime by checking the `SecureDefaults`
 * module-singleton load state. A bootstrap-order inversion that calls
 * `bind()` before `SecureDefaults.load(config)` completes throws here
 * — this is the orchestrator-throw surface AC1 names ("bootstrap
 * orchestrator throws on attempted bind without prior
 * `SecureDefaults.load` completion") and the surface W-007p-1-T1
 * asserts against (T-007p-1-4 authors the test).
 *
 * Synchronous + side-effect-free on the success path. The throw is a
 * programmer-error guard, not a recoverable failure mode — callers
 * MUST NOT `try`/`catch` it to retry; the correct fix is to invoke
 * `bootstrap(config)` (or `SecureDefaults.load(config)` directly)
 * earlier in the daemon's startup sequence.
 *
 * Tier 1 has NO real `bind()` operation — Phase 2 ships the listener.
 * This guard exists at Tier 1 specifically so the load-before-bind
 * SEAM is testable now (W-007p-1-T1) and consumable by Phase 2 without
 * a re-implementation pass.
 */
export function assertLoadedForBind(): void {
  if (!SecureDefaults.isLoaded()) {
    throw new Error(
      "assertLoadedForBind: SecureDefaults.load(config) must complete before any listener bind() (I-007-1)",
    );
  }
}
