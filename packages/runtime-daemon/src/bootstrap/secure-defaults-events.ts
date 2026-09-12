// SecureDefaultOverrideEmitter — single-emit-per-startup audit-event surface.
//
// This module owns one invariant: every override emits exactly one
// `security.default.override=<behavior>` log event per startup — not per
// request, not per event batch. The event is structured so it is greppable in
// self-host logs and countable via /metrics, with fields `behavior` (integer
// 1–10), `effective_value` (string), `banner_printed_at` (ISO-8601), and an
// OPTIONAL `row` (`7a`/`7b` as string).
//
// The emitter contract here is "fire to whatever event sink the daemon
// bootstrap exposes" via `setSink`, so this module's runtime stays decoupled
// from whoever consumes the event. The inline `Sink` shape below is
// intentional: the emitter surface and the event taxonomy can evolve
// independently without coupling.
//
// `behavior` rides the wire as an integer 1–10 even though the human-readable
// banner spells a string token (for example `insecure_bind`); the
// integer↔string-token mapping lives with the banner, not here.
//
// What this module does NOT do:
//   * Define a sink implementation. The orchestrator wires the daemon's
//     actual event sink into this module via `setSink`.
//   * Format the override into a stdout banner. Banner content belongs to the
//     banner consumer.
//   * Validate the payload shape. The inline types below are the
//     compile-time contract; the substrate trusts the in-process caller. A
//     future Zod-schema validation step can layer on top.

// --------------------------------------------------------------------------
// Inline payload + sink types. This module owns the emitter surface; the
// canonical `security.default.override` taxonomy row lives elsewhere. The two
// can evolve independently — Zod-schema validation against the taxonomy can
// layer on top in a follow-up without changing the call surface here.
// --------------------------------------------------------------------------

/**
 * `security.default.override` event payload, audit-derived. `row` is OPTIONAL —
 * the `7a`/`7b` sub-row discriminator is supplied only for behavior 7 and omitted
 * for the single-integer behaviors (rows 2, 5, 6, 8, 9 carry no sub-row). When
 * present it is typed as `string` rather than narrowed to `"7a" | "7b"` because
 * schema names rows 2, 5, 6, 8, 9 in the same breath — pre-narrowing the type
 * would lock it to an assumption that excludes the broader override
 * surface. Tightening (if appropriate) is owed to the taxonomy registration.
 *
 * `behavior` is the integer override identity (1–10) per that schema;
 * dedupe keys on this field. Two emissions sharing the same
 * `behavior` integer are the same override and collapse to one sink
 * call, regardless of differing `row` / `effective_value` /
 * `banner_printed_at` payloads supplied by retry callers.
 *
 * `banner_printed_at` is the ISO-8601 timestamp of the corresponding
 * row 10 banner emission. The emitter does NOT generate this
 * timestamp itself — the banner consumer is the source of truth for
 * "when was the banner printed", and the emitter receives it as
 * already-stamped input. This avoids a clock-source split between two
 * modules that would otherwise need reconciliation.
 */
export interface SecurityDefaultOverrideEvent {
  readonly behavior: number;
  readonly row?: string;
  readonly effective_value: string;
  readonly banner_printed_at: string;
}

/**
 * Synchronous because the override emission sites (config-validation
 * paths inside `SecureDefaults` and downstream override
 * surfaces) are themselves synchronous; introducing a Promise here
 * would force every override site through an `await` without buying
 * anything needed here. If an async persistence path lands, the sink
 * contract widens; downstream callers do not change because the
 * emit-once semantic is preserved.
 *
 * The sink MAY throw — sink-thrown errors propagate to the caller of
 * `emit`. Crucially, the dedupe state advances BEFORE the sink is
 * invoked (see `emit` below); a sink that throws on the first call
 * does NOT permit a retry to produce a second event. This matches
 * the invariant text "exactly one … per startup" — duplicate
 * suppression must be unconditional on sink success.
 */
export type SecurityDefaultOverrideSink = (event: SecurityDefaultOverrideEvent) => void;

// --------------------------------------------------------------------------
// SecureDefaultOverrideEmitter — module-singleton state machine
// --------------------------------------------------------------------------
//
// State model: two module-private slots — the installed sink (or
// `null` before `setSink`) and the Set of behavior integers already
// emitted in this process. The class exposes only static methods,
// mirroring `SecureDefaults` so the orchestrator imports one symbol
// and calls without instance plumbing.
//
// Recommendation: static class + module singleton (mirrors
// `SecureDefaults`).
//
// Alternative considered: function-pair `setSink(sink)` +
// `emitSecurityDefaultOverride(sink, event)` with caller-supplied
// sink. The override emission sites would need to know the sink
// reference, forcing every override surface to import-and-pass
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
    throw new Error("SecureDefaultOverrideEmitter: use static methods, not `new`");
  }

  /**
   * Install the event sink the orchestrator wires during daemon
   * bootstrap. Must be called BEFORE any override-emission site fires
   * `emit`; calling `emit` without an installed sink throws (the
   * symmetric pre-condition to `SecureDefaults.effectiveSettings`'s
   * load-before-read throw).
   *
   * Idempotency: a second call REPLACES the previously installed
   * sink. The dedupe state (`emittedBehaviors`) is NOT cleared by a
   * sink replacement — the "once per startup" semantic spans the
   * process lifetime, independent of which sink is wired.
   */
  static setSink(sink: SecurityDefaultOverrideSink): void {
    installedSink = sink;
  }

  /**
   * Emit a `security.default.override` event, deduplicated by the
   * `behavior` integer. The first call with a given `behavior`
   * invokes the installed sink with the supplied event; subsequent
   * calls with the same `behavior` are no-ops, regardless of any
   * differences in the other payload fields.
   *
   * Different `behavior` integers emit independently — each is
   * deduplicated against its own prior emissions but does not
   * suppress others. This matches: "multiple override paths with
   * different behaviors emit independently but each only once."
   *
   * Ordering guarantee (sharpening): the dedupe set is advanced
   * BEFORE the sink is invoked. A sink that throws on the first
   * emission does NOT permit a caller to retry and produce a second
   * event for the same `behavior`. The emit-once invariant is
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
        "SecureDefaultOverrideEmitter.emit: SecureDefaultOverrideEmitter.setSink(sink) must be called before emit() (orchestrator wiring is owed)",
      );
    }
    if (emittedBehaviors.has(event.behavior)) {
      return;
    }
    // Mark-before-fire (sharpening): a sink that throws after the
    // Set.add still leaves the behavior marked as emitted, so a retry
    // with the same `behavior` is a no-op rather than a duplicate
    // emission. Failure to deliver the audit log is a separate
    // observability concern from the emit-once invariant.
    emittedBehaviors.add(event.behavior);
    installedSink(event);
  }

  /**
   * True iff a sink has been installed via `setSink` for the current
   * process. Exposed so the orchestrator can defensively verify
   * wiring state at boot without inspecting module-private slots.
   */
  static hasSink(): boolean {
    return installedSink !== null;
  }

  /**
   * True iff `emit` has been called at least once with the supplied
   * `behavior` integer for the current process. Exposed primarily for
   * test introspection (the dedupe-semantics test asserts it) and as
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
   * (its test) would inherit `emittedBehaviors` and `installedSink`
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
