// SecureDefaultOverrideEmitter — single-emit-per-startup audit-event surface.
//
// This module owns the I-007-4 invariant (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 84-87):
// every override emits exactly one `security.default.override=<behavior>`
// log event per startup — not per request, not per event batch. Per-request
// emission would flood the audit log and obscure single-event audit
// semantics; missing emission would silently hide an active override.
//
// Spec-027 rows this module covers (canonical text in
// docs/specs/027-self-host-secure-defaults.md):
//   * Line 81 — `Emit exactly one security.default.override=<behavior>
//     log event per startup, structured so it is greppable in self-host
//     logs and countable via /metrics.`
//   * Line 138 — `security.default.override` log event schema (rows 2,
//     5, 6, 8): structured log with fields `behavior` (integer 1–10),
//     `row` (`7a`/`7b` as string), `effective_value` (string),
//     `banner_printed_at` (ISO-8601).
//   * Line 146 — `every override path contributes a
//     security.default.override=* log event that feeds /metrics
//     (rows 9a daemon / 9b relay) and is visible to Spec-006 event
//     taxonomy.`
//
// BLOCKED-ON-C9. The event is marked-but-unregistered at Tier 1 — the
// canonical `security.default.override` event-type registration in
// Spec-006 §Event Type Summary and Plan-006 emitter table is owed by
// CP-007-5 (governance pickup). The emitter contract here is therefore
// "fire to whatever event sink the daemon bootstrap exposes"; this
// module deliberately introduces NO event-name registry, NO Spec-006
// taxonomy import, and NO new abstractions beyond the audit-cited
// inline payload shape. When CP-007-5 lands, the consuming sink will
// be the registered taxonomy emitter and the inline `Sink` shape here
// stays unchanged.
//
// Spec tension noted for the reviewer (BLOCKED-ON-C9): line 81 frames
// the event as `security.default.override=<behavior>` (Example 5 emits
// `security.default.override=insecure_bind`, suggesting `<behavior>`
// is a string token), while line 138 declares `behavior` as integer
// 1–10 in the structured payload schema. The audit cite explicitly
// dictates the payload shape from line 138; this module honors that
// tie-breaker. The string-token form is a stdout/log-line rendering
// concern, not a structured-payload concern, and is owned by the
// banner / log-format consumer (T-007p-1-3 / Plan-026 / Spec-006
// taxonomy registration). When CP-007-5 lands the canonical taxonomy
// row, the integer↔string-token mapping is recorded there.
//
// What this module does NOT do (deferred):
//   * Define a sink implementation. The orchestrator (T-007p-1-3) wires
//     the daemon's actual event sink into this module via `setSink`.
//   * Format the override into a stdout banner. Spec-027 row 10 banner
//     content is owned by the Plan-026 banner consumer.
//   * Register the event type with Spec-006 taxonomy (CP-007-5 / C9).
//   * Validate the payload shape. The inline types below are the
//     compile-time contract; Tier 1 trusts the in-process caller. A
//     future Zod-schema validation step lands once CP-007-5 declares
//     the canonical envelope.

// --------------------------------------------------------------------------
// Inline payload + sink types (BLOCKED-ON-C9 — replace with imported
// taxonomy types when Spec-006 §Event Type Summary registers
// `security.default.override` per CP-007-5).
// --------------------------------------------------------------------------

/**
 * `security.default.override` event payload, audit-derived from
 * Spec-027 line 138. `row` is typed as `string` rather than narrowed
 * to `"7a" | "7b"` because line 138 names rows 2, 5, 6, 8 in the same
 * breath — pre-narrowing the type would lock it to a Tier-1
 * assumption that excludes the broader override surface. Tightening
 * (if appropriate) is owed to CP-007-5's taxonomy registration.
 *
 * `behavior` is the integer override identity (1–10) per line 138;
 * dedupe (I-007-4) keys on this field. Two emissions sharing the
 * same `behavior` integer are the same override and collapse to one
 * sink call, regardless of differing `row` / `effective_value` /
 * `banner_printed_at` payloads supplied by retry callers.
 *
 * `banner_printed_at` is the ISO-8601 timestamp of the corresponding
 * Spec-027 row 10 banner emission. The emitter does NOT generate this
 * timestamp itself — the banner consumer (Plan-026) is the source of
 * truth for "when was the banner printed", and the emitter receives
 * it as already-stamped input. This avoids a clock-source split
 * between two modules that would otherwise need reconciliation.
 */
export interface SecurityDefaultOverrideEvent {
  readonly behavior: number;
  readonly row: string;
  readonly effective_value: string;
  readonly banner_printed_at: string;
}

/**
 * The event-sink contract. Synchronous because the override emission
 * sites (config-validation paths inside `SecureDefaults` and downstream
 * Tier-4 override surfaces) are themselves synchronous; introducing a
 * Promise here would force every override site through an `await`
 * without buying anything Tier 1 needs. When CP-007-5 lands an async
 * persistence path, the sink contract widens; downstream callers do
 * not change because the emit-once semantic is preserved.
 *
 * The sink MAY throw — sink-thrown errors propagate to the caller of
 * `emit`. Crucially, the dedupe state advances BEFORE the sink is
 * invoked (see `emit` below); a sink that throws on the first call
 * does NOT permit a retry to produce a second event. This matches
 * I-007-4's invariant text "exactly one … per startup" — duplicate
 * suppression must be unconditional on sink success.
 */
export type SecurityDefaultOverrideSink = (
  event: SecurityDefaultOverrideEvent,
) => void;

// --------------------------------------------------------------------------
// SecureDefaultOverrideEmitter — module-singleton state machine
// --------------------------------------------------------------------------
//
// State model: two module-private slots — the installed sink (or
// `null` before `setSink`) and the Set of behavior integers already
// emitted in this process. The class exposes only static methods,
// mirroring `SecureDefaults` so the orchestrator (T-007p-1-3) imports
// one symbol and calls without instance plumbing.
//
// Recommendation: static class + module singleton (mirrors
// `SecureDefaults`).
//
// Alternative considered: function-pair `setSink(sink)` +
// `emitSecurityDefaultOverride(sink, event)` with caller-supplied
// sink. The override emission sites would need to know the sink
// reference, forcing every Tier-4 override surface to import-and-pass
// the sink. The class form moves that knowledge into a single
// module-singleton install step.
//
// Why class wins: review-consistency with the sibling
// `SecureDefaults` module (one mental model for both bootstrap
// modules), and a single `__resetForTest()` hook that clears every
// piece of singleton state for test isolation.
//
// Trade-off accepted: module-singleton state requires a test-only
// reset hook. Identical trade-off the sibling module already
// accepted; review burden is zero-marginal.

let installedSink: SecurityDefaultOverrideSink | null = null;
const emittedBehaviors: Set<number> = new Set<number>();

export class SecureDefaultOverrideEmitter {
  // Static-only API: prevent accidental instantiation. Mirrors the
  // sibling `SecureDefaults` module's constructor-throw guard so a
  // stray `new SecureDefaultOverrideEmitter()` cannot bypass the
  // singleton state.
  private constructor() {
    throw new Error(
      "SecureDefaultOverrideEmitter: use static methods, not `new`",
    );
  }

  /**
   * Install the event sink the orchestrator wires during daemon
   * bootstrap. Must be called BEFORE any override-emission site fires
   * `emit`; calling `emit` without an installed sink throws (the
   * symmetric pre-condition to `SecureDefaults.effectiveSettings`'s
   * load-before-read throw).
   *
   * Idempotency: a second call REPLACES the previously installed
   * sink. The orchestrator wires the sink once during bootstrap; this
   * "replace" semantic exists to support a hypothetical wire-and-
   * rewire test sequence and is not a production code path. The
   * dedupe state (`emittedBehaviors`) is NOT cleared by a sink
   * replacement — I-007-4's "once per startup" semantic spans the
   * process lifetime, independent of which sink is wired.
   */
  static setSink(sink: SecurityDefaultOverrideSink): void {
    installedSink = sink;
  }

  /**
   * Emit a `security.default.override` event, deduplicated by the
   * `behavior` integer per I-007-4. The first call with a given
   * `behavior` invokes the installed sink with the supplied event;
   * subsequent calls with the same `behavior` are no-ops, regardless
   * of any differences in the other payload fields.
   *
   * Different `behavior` integers emit independently — each is
   * deduplicated against its own prior emissions but does not
   * suppress others. This matches AC5: "multiple override paths with
   * different behaviors emit independently but each only once."
   *
   * Ordering guarantee (I-007-4 sharpening): the dedupe set is
   * advanced BEFORE the sink is invoked. A sink that throws on the
   * first emission does NOT permit a caller to retry and produce a
   * second event for the same `behavior`. The emit-once invariant is
   * unconditional on sink success.
   *
   * Throws if no sink has been installed via `setSink` — the
   * symmetric programmer-error guard to `SecureDefaults`'s
   * load-before-read throw. This guard runs BEFORE the dedupe set
   * advances, so a misconfigured bootstrap that triggers an
   * override before wiring the sink does NOT poison the dedupe set
   * silently — once the sink is wired, the same `behavior` can still
   * fire its single event.
   */
  static emit(event: SecurityDefaultOverrideEvent): void {
    if (installedSink === null) {
      throw new Error(
        "SecureDefaultOverrideEmitter.emit: SecureDefaultOverrideEmitter.setSink(sink) must be called before emit() (orchestrator wiring is owed by T-007p-1-3)",
      );
    }
    if (emittedBehaviors.has(event.behavior)) {
      return;
    }
    // Mark-before-fire (I-007-4 sharpening): a sink that throws after
    // the Set.add still leaves the behavior marked as emitted, so a
    // retry with the same `behavior` is a no-op rather than a
    // duplicate emission. Failure to deliver the audit log is a
    // separate observability concern from the emit-once invariant.
    emittedBehaviors.add(event.behavior);
    installedSink(event);
  }

  /**
   * True iff a sink has been installed via `setSink` for the current
   * process. Exposed so the orchestrator (T-007p-1-3) can defensively
   * verify wiring state at boot without inspecting module-private
   * slots.
   */
  static hasSink(): boolean {
    return installedSink !== null;
  }

  /**
   * True iff `emit` has been called at least once with the supplied
   * `behavior` integer for the current process. Exposed primarily for
   * test introspection (W-007p-1-T5 asserts dedupe semantics) and as
   * a defensive check the orchestrator can use to prove an override
   * has fired. Production callers SHOULD NOT branch behavior on this
   * predicate — emit's idempotency is the contract.
   */
  static hasEmitted(behavior: number): boolean {
    return emittedBehaviors.has(behavior);
  }

  /**
   * Test-only reset hook. Vitest shares a single Node process across
   * cases; without this hook, tests that assert dedupe behavior
   * (W-007p-1-T5) would inherit `emittedBehaviors` and `installedSink`
   * state from any earlier test. Clears BOTH slots — leaving the
   * sink installed across cases would let the previous test's sink
   * (often a closure over a captured array) receive subsequent test
   * emissions silently. NOT for production use — there is no
   * daemon-runtime caller for this method.
   */
  static __resetForTest(): void {
    installedSink = null;
    emittedBehaviors.clear();
  }
}
