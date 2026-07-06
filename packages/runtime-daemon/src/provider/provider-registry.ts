// ProviderRegistry — in-memory driver registry + capability-flag gate (Plan-005
// Phase 2, T2.3).
//
// The registry is the daemon-resident lookup + capability authority over the set
// of live `ProviderDriver` instances. It does ONE job each across two seams:
//   1. registration / lookup — bind a canonical driver id (e.g. `"claude"`,
//      `"codex"`) to a `ProviderDriver` instance and its capability snapshot.
//   2. capability gating — `checkCapability` is a throwing assertion that
//      ENFORCES I-005-2 (undeclared capability = unsupported) BEFORE a direct
//      capability-bound call reaches the driver.
//
// DELIBERATELY pure in-memory — NO database, NO `RuntimeBindingStore`, NO
// constructor dependencies. `runtime_bindings` persistence (T2.2) and the
// driver-capability DB cache (T2.4) are SEPARATE orchestration-layer seams; the
// Phase-2 integration (T2.5) wires `RuntimeBindingStore`, `ProviderRegistry`, and
// `DriverCapabilitiesWriter` as three independent components — the store is NOT
// nested inside this registry. Injecting a store this class never calls would be a
// dead constructor param, so it is intentionally absent.
//
// Capability-snapshot lifecycle: `register` `await`s `driver.getCapabilities()`
// EXACTLY ONCE and caches the resolved `DriverCapabilities` snapshot in-memory.
// The live gate (`checkCapability`) reads that cached snapshot — it does NOT
// round-trip the driver per check and does NOT read the DB. Re-registering an
// existing `driverId` OVERWRITES the cached snapshot (idempotent upsert — the
// in-memory refresh seam for "on driver registration + on capability-refresh
// events").
//
// I-005-2 (undeclared capability = unsupported), realized two ways:
//   * The contract type `Record<DriverCapabilityFlag, boolean>` makes a flag
//     structurally un-omittable (every flag must be answered) — the static half.
//   * `checkCapability` is the RUNTIME half: it FAIL-CLOSES on `!== true` (not
//     `=== false`), so a flag whose cached value is `false` OR `undefined` (e.g.
//     a bogus flag arriving via an untyped boundary) is rejected with
//     `driver.capability_unsupported`. A capability is supported ONLY when
//     explicitly declared `true`; absence and falsity are both "unsupported".
//
// Gating SCOPE: `checkCapability` gates ONLY direct capability-bound calls (a
// future `driver.steer` entrypoint, or `getCapabilities` against an unregistered
// driver). `applyIntervention` is EXCLUDED from pre-dispatch gating — its
// intervention-type-aware degraded-fallback per ADR-011 must reach the driver to
// return `{ status: 'degraded', fallbackAction }` (Spec-005:46). That exclusion
// is realized simply by `checkCapability` being the only gate and the registry
// never calling/special-casing `applyIntervention` — there is no exclusion branch.
//
// Typed-error convention: mirrors the immediate-neighbor `provider-output-
// validation.ts` (`ProviderOutputValidationError`) and `ipc/session-errors.ts` —
// a stable `code` literal in the `driver.*` dotted namespace and a leak-safe
// message + structured `fields`. Both error classes are exported because T2.5's
// integration test asserts the gate throws the right type/code.
//
// Spec coverage: Spec-005:43 (every provider integration implements a normalized
// driver contract — the registry is keyed on that contract), Spec-005:56 (runtime
// treats undeclared capabilities as unsupported — the `checkCapability` gate).
//
// Refs: Plan-005 §Phase 2 / T2.3, Spec-005 lines 43 + 48, invariant I-005-2,
// ADR-011 (capability flags + intervention modeling), error-contracts.md line 310
// (`driver.unavailable`, HTTP 503) + line 303 (`driver.capability_unsupported`,
// HTTP 400).

import type {
  DriverCapabilities,
  DriverCapabilityFlag,
  ProviderDriver,
} from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// Typed errors (co-located with the throwing module, per the
// provider-output-validation.ts / session-errors.ts precedent)
// --------------------------------------------------------------------------

/**
 * Thrown when a capability check targets a `driverId` that is not registered.
 *
 * `code === "driver.unavailable"` (error-contracts.md line 310, HTTP 503 —
 * "Provider driver is currently unavailable"). This covers the plan's
 * "`driver.getCapabilities` … called against an unregistered driver" case: a
 * direct capability-bound call cannot proceed against a driver the registry has
 * never seen.
 *
 * Leak-safe by construction: the message is the canonical stable sentence and
 * `fields` carries only the structured throw-site detail `{ driverId }` — no
 * stack, no secret, no raw internals.
 */
export class DriverUnavailableError extends Error {
  readonly code = "driver.unavailable" as const;
  readonly fields: { readonly driverId: string };

  constructor(driverId: string) {
    super("Provider driver is currently unavailable");
    this.name = "DriverUnavailableError";
    this.fields = { driverId };
  }
}

/**
 * Thrown when a registered driver is asked for a capability it has not declared
 * `true` — the primary runtime realization of I-005-2.
 *
 * `code === "driver.capability_unsupported"` (error-contracts.md line 311, HTTP
 * 400 — "Requested capability is not supported by the driver"). Raised by the
 * fail-closed gate for BOTH a declared-`false` flag AND a flag absent from the
 * cached snapshot (an undeclared/bogus flag), because "unsupported" is the
 * complement of "explicitly declared true".
 *
 * Leak-safe by construction: message is the canonical sentence; `fields` carries
 * only `{ driverId, flag }`.
 */
export class DriverCapabilityUnsupportedError extends Error {
  readonly code = "driver.capability_unsupported" as const;
  readonly fields: { readonly driverId: string; readonly flag: DriverCapabilityFlag };

  constructor(driverId: string, flag: DriverCapabilityFlag) {
    super("Requested capability is not supported by the driver");
    this.name = "DriverCapabilityUnsupportedError";
    this.fields = { driverId, flag };
  }
}

// --------------------------------------------------------------------------
// Cached snapshot
// --------------------------------------------------------------------------

/**
 * The in-memory record kept per registered `driverId`: the driver instance plus
 * the `DriverCapabilities` snapshot resolved ONCE at registration. The live gate
 * reads `capabilities.flags` from here, never re-invoking the driver.
 */
interface RegisteredDriver {
  readonly driver: ProviderDriver;
  readonly capabilities: DriverCapabilities;
}

// --------------------------------------------------------------------------
// ProviderRegistry
// --------------------------------------------------------------------------

export class ProviderRegistry {
  // Keyed by canonical driver id (a plain trusted-caller-supplied `string`, e.g.
  // `"claude"` — matching how `RuntimeBindingStore` models the same concept with
  // a plain `driverName` and the DB tables key on `driver_name TEXT`; no brand).
  readonly #drivers: Map<string, RegisteredDriver> = new Map();

  // Per-driver monotonic registration token. Each `register` increments the
  // driver's token BEFORE its `await`, then re-checks it AFTER resolving: a stale
  // (superseded) registration drops its result instead of installing it. This
  // realizes the LAST-CALL-WINS concurrency contract documented on `register`.
  readonly #registrationSeq: Map<string, number> = new Map();

  /**
   * Register (or refresh) a driver under `driverId`.
   *
   * `await`s `driver.getCapabilities()` EXACTLY ONCE and caches the resolved
   * `DriverCapabilities` snapshot alongside the driver instance. The live gate
   * reads that cached snapshot — it does not round-trip the driver per check.
   *
   * Re-registering an existing `driverId` OVERWRITES the cached snapshot
   * (idempotent upsert — the in-memory capability-refresh seam).
   *
   * CONCURRENCY CONTRACT — LATEST-INITIATED REGISTER WINS (last-call-wins): when
   * two `register` calls for the SAME `driverId` overlap, the LATER-INITIATED
   * call's snapshot is installed, REGARDLESS of which `getCapabilities()` resolves
   * first. This is the correct semantic for the refresh seam: this method is the
   * "on registration + on capability-refresh events" entrypoint, so a later call
   * always carries NEWER provider state — letting a stale earlier call win (just
   * because its async resolved later) would install an outdated snapshot the gate
   * would then enforce. A per-driver monotonic token (`#registrationSeq`),
   * captured BEFORE the await and re-checked AFTER, enforces this: a superseded
   * call detects a newer token and drops its result without writing the Map.
   */
  async register(driverId: string, driver: ProviderDriver): Promise<void> {
    // Claim a registration token BEFORE the await. A later `register` for the same
    // id claims a higher token, so the re-check below lets the latest-initiated
    // call win even if an earlier call's `getCapabilities()` resolves after it.
    const token: number = (this.#registrationSeq.get(driverId) ?? 0) + 1;
    this.#registrationSeq.set(driverId, token);

    const result = await driver.getCapabilities();

    // A newer `register` for this id superseded us while we awaited — drop this
    // now-stale result rather than installing an outdated snapshot the gate would
    // enforce (last-call-wins; see the concurrency contract above).
    if (this.#registrationSeq.get(driverId) !== token) {
      return;
    }

    // Snapshot `result.capabilities` (the `DriverCapabilities` — `flags` +
    // `contractVersion`), NOT `result` itself: `getCapabilities` returns a
    // `GetCapabilitiesResult` wrapper, and the gated `flags` live one level down
    // at `result.capabilities.flags`. `tools` (the ingress tool metadata) is a
    // T2.4 hydration concern, not a gating input, so it is not cached here.
    //
    // DEFENSIVE CLONE — not an alias. The class header promises an immutable
    // snapshot "resolved ONCE at registration"; caching `result.capabilities` by
    // reference would let a later driver-side mutation of its own `flags` object
    // silently drift `checkCapability` away from the advertised DB/event snapshot.
    // Clone the wrapper AND the nested `flags` object (a shallow `{...flags}` is
    // enough — flag values are booleans); `contractVersion` is a string primitive
    // and needs no clone.
    this.#drivers.set(driverId, {
      driver,
      capabilities: {
        ...result.capabilities,
        flags: { ...result.capabilities.flags },
      },
    });
  }

  /**
   * Look up a registered driver instance by id. Non-throwing accessor: returns
   * `undefined` on a miss (mirrors `RuntimeBindingStore.findById` /
   * node-registry — a miss is a normal state, not an error here; the throwing
   * path is `checkCapability`).
   */
  lookup(driverId: string): ProviderDriver | undefined {
    return this.#drivers.get(driverId)?.driver;
  }

  /**
   * The capability GATE. A throwing assertion (NOT a boolean predicate): returns
   * `void` when the capability is supported, and otherwise throws.
   *
   * Two failure branches:
   *   * unregistered `driverId` → `DriverUnavailableError`
   *     (`driver.unavailable`).
   *   * registered but the flag is not declared `true` →
   *     `DriverCapabilityUnsupportedError` (`driver.capability_unsupported`).
   *
   * FAIL-CLOSED: the second branch tests `!== true`, not `=== false`, so a flag
   * whose cached value is `undefined` (e.g. a bogus flag arriving via an untyped
   * boundary) is ALSO rejected. A capability is supported ONLY when explicitly
   * declared `true` — this is the runtime half of I-005-2.
   *
   * `applyIntervention` is intentionally NOT gated here — there is no branch for
   * it. Its ADR-011 degraded-fallback must reach the driver (Spec-005:46).
   */
  checkCapability(driverId: string, flag: DriverCapabilityFlag): void {
    const entry = this.#drivers.get(driverId);
    if (entry === undefined) {
      throw new DriverUnavailableError(driverId);
    }
    if (entry.capabilities.flags[flag] !== true) {
      throw new DriverCapabilityUnsupportedError(driverId, flag);
    }
  }

  /**
   * List the registered driver ids. Minimal by design (YAGNI) — the bare keys,
   * with no duplicates (re-registering an id is an upsert on a single Map entry).
   */
  listAvailable(): readonly string[] {
    return [...this.#drivers.keys()];
  }
}
