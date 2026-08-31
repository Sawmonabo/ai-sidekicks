// DriverCapabilityCache — the read-side capability cache behind
// `driver.listCapabilities` (Plan-005 Phase 4, T4.5).
//
// WHAT THIS IS FOR. `driver.listCapabilities` is a client-facing read that a
// renderer calls whenever it needs to know which controls to offer. Serving it
// by round-tripping the driver would put a provider process on the critical path
// of every capability question a client asks, and `ProviderDriver.getCapabilities()`
// is not a cheap call — on the pinned surfaces it is a session handshake. So the
// reply is served from cache, and the ONLY thing this class consults on a hit is
// its own memory.
//
// THREE LAYERS OF CACHE, AND THIS IS THE THIRD. Worth naming the other two so
// this one is not mistaken for a duplicate of either:
//   1. `driver_capabilities` / `driver_contract_meta` — the DURABLE cache. Rows
//      written by `DriverCapabilitiesWriter.declare()`; read back by its
//      `hydrate()`. Survives daemon restart; costs a SQLite read transaction.
//   2. `ProviderRegistry`'s per-driver snapshot — the in-memory capability
//      snapshot resolved once at driver registration, read by the fail-closed
//      `checkCapability` GATE. It answers "may this call proceed", never "what
//      should a client render", and it deliberately drops `tools` and
//      `cliVersion` because a gate needs neither.
//   3. THIS — the in-memory projection of (1) into the CLIENT-FACING report
//      shape, so a wire read costs neither a provider round-trip nor a durable
//      read on a hit.
// (2) and (3) are not merged because they answer different questions and fail
// differently: a registry miss means the driver is not loaded, while a miss here
// means the driver has never been declared into the durable cache — different
// states with different remedies, and collapsing them would make one
// indistinguishable from the other.
//
// WHAT THE REPLY CARRIES. `GetCapabilitiesResult` carries five members and this
// report carries two of them plus the driver's name. `Spec-005 §Capability discovery`
// scopes the client-facing payload to the flags, and `Spec-005 §Required Behavior`
// rules that the mechanism grades and `cliVersion` alike stop at the driver-side
// read — a consumer needing provenance or a version reads it through the daemon
// rather than off this reply. `tools` is a daemon-side ingress concern whose
// readers are `driver_tools` and the `runtime_node.capability_*` events, and no
// clause routes it to a client. Composing the whole wrapper here and letting the
// wire schema strip it would put the carve-out in the wrong place: the schema is
// `.strict()`, so it REJECTS rather than strips, and the mistake would surface
// as a failed read rather than as leaked provenance — but the composition is
// where the rule belongs, and the schema is the backstop that proves it held.
//
// `outputSpeedLevels` IS RE-DERIVED ON EVERY READ AND IS NEVER STORED — the one
// rule of this module worth stating twice. The vocabulary is a constant OF THE
// DRIVER (`./driver-output-speed.ts`), not a fact about any reading, so it is
// always re-derivable from the running build's own table. Storing it in a cache
// entry would create a second copy that a redeploy could silently stale: the
// build would publish one vocabulary while this cache kept serving the one
// captured before the process restarted, and a client would render a choice set
// the driver no longer accepts. The durable cache takes the same position for
// the same reason and mints no column for it, which is why `hydrate()` also
// re-derives rather than reading a row. A cache entry here therefore holds
// `DriverCapabilities` and NOTHING else; the vocabulary is composed at the
// moment of each read.
//
// INVALIDATION. A capability set changes when a driver is re-declared, which is
// exactly when `DriverCapabilitiesWriter` emits `runtime_node.capability_updated`.
// The daemon has no general audit-log fanout to subscribe to today (verified by
// repo grep: neither the node event emitter nor the event-log service exposes an
// observer seam), so this class takes the subscription as an INJECTED dependency
// — the same posture `session-subscribe.ts` takes for its upstream event source,
// where the bootstrap orchestrator owns the implementor. Supplying it is
// optional and its absence is a real degradation rather than a neutral default:
// without it the only invalidation is an explicit `invalidate()` call, so a
// caller that wires no source MUST call `invalidate()` from wherever it performs
// the re-declaration. That is stated here rather than left implicit because a
// stale capability reply is not a cosmetic failure — it is a client offering a
// control the driver no longer supports.
//
// Refs: Plan-005 §Phase 4 / T4.5, `Spec-005 §Capability discovery`,
// `Spec-005 §Required Behavior`, invariant I-005-2 (undeclared capability =
// unsupported), `docs/architecture/contracts/error-contracts.md §Driver`
// (`driver.unavailable`).

import type { DriverCapabilities, DriverCapabilityReport } from "@ai-sidekicks/contracts";

import type { DriverCapabilityHydrationResult } from "./driver-capabilities-writer.js";
import { declaredOutputSpeedLevelsFor } from "./driver-output-speed.js";
import { DriverUnavailableError } from "./provider-registry.js";

/**
 * Dependencies this cache reads through. Every one of them is a seam the
 * bootstrap orchestrator owns, so the cache itself holds no database handle, no
 * driver instance, and no timer.
 */
export interface DriverCapabilityCacheDeps {
  /**
   * Read a driver's capability snapshot back from the DURABLE cache — normally
   * `DriverCapabilitiesWriter.hydrate` bound to its writer.
   *
   * Synchronous by contract, matching the writer's own signature: the read runs
   * inside one deferred SQLite transaction and touches no driver process. A miss
   * (either cause) means this node cannot report the driver's capabilities
   * without a provider round-trip, which is precisely what this cache exists to
   * avoid, so the read refuses rather than degrading.
   */
  readonly hydrateDurableCapabilities: (driverName: string) => DriverCapabilityHydrationResult;

  /**
   * Resolve a driver's declared output-speed vocabulary. Defaults to
   * `declaredOutputSpeedLevelsFor`, the one table both read paths share.
   *
   * Injectable for one reason that matters: a test can prove the vocabulary is
   * re-derived PER READ rather than captured once, by supplying a resolver whose
   * answer changes between two reads of the same cached driver. No assertion
   * about a stored value could establish that property.
   */
  readonly resolveOutputSpeedLevels?: ((driverName: string) => readonly string[]) | undefined;

  /**
   * Subscribe to `runtime_node.capability_updated` for any driver, returning an
   * unsubscribe handle. The callback receives the driver name whose capabilities
   * changed; this cache drops that driver's entry so the next read re-hydrates.
   *
   * Optional, and see the file header for what its absence costs: with no source
   * wired, the only invalidation is an explicit `invalidate()` call from the
   * component that performed the re-declaration.
   */
  readonly subscribeToCapabilityUpdates?:
    | ((onCapabilityUpdated: (driverName: string) => void) => () => void)
    | undefined;
}

/**
 * One cached driver's entry.
 *
 * Holds `DriverCapabilities` — the flags and the contract version — and
 * deliberately nothing else. In particular it holds NO `outputSpeedLevels`: see
 * the file header for why that vocabulary is re-derived on every read instead.
 * The absence is load-bearing rather than incidental, so the shape states it by
 * having no member to put one in.
 */
interface CachedCapabilityEntry {
  readonly capabilities: DriverCapabilities;
}

export class DriverCapabilityCache {
  readonly #hydrateDurableCapabilities: (driverName: string) => DriverCapabilityHydrationResult;
  readonly #resolveOutputSpeedLevels: (driverName: string) => readonly string[];
  readonly #entries: Map<string, CachedCapabilityEntry> = new Map();

  // The live unsubscribe handle, or `undefined` when no source was wired (or
  // after `close()`). Not `readonly`: `close()` clears it so a second call is a
  // no-op rather than a double-unsubscribe against a source that may not be
  // idempotent.
  #unsubscribeFromCapabilityUpdates: (() => void) | undefined;

  constructor(deps: DriverCapabilityCacheDeps) {
    this.#hydrateDurableCapabilities = deps.hydrateDurableCapabilities;
    this.#resolveOutputSpeedLevels = deps.resolveOutputSpeedLevels ?? declaredOutputSpeedLevelsFor;

    // Subscribe at CONSTRUCTION, not lazily on first read. A capability update
    // that lands before anything has been read must still be seen: lazy
    // subscription would miss it, and the entry written by the first read after
    // that miss would be stale from birth with nothing left to invalidate it.
    if (deps.subscribeToCapabilityUpdates !== undefined) {
      this.#unsubscribeFromCapabilityUpdates = deps.subscribeToCapabilityUpdates((driverName) => {
        this.invalidate(driverName);
      });
    }
  }

  /**
   * Serve one driver's client-facing capability report.
   *
   * On a hit this touches nothing outside this object. On a miss it performs ONE
   * durable read (`hydrateDurableCapabilities`) and never a provider round-trip
   * — which is the whole contract of this class, and the reason a durable miss
   * is a refusal rather than a fallback to the driver.
   *
   * THROWS `DriverUnavailableError` (`driver.unavailable`) on a durable miss.
   * Both miss causes — never declared on this node, or declared before the
   * version columns existed — land here, because both mean the same thing to
   * this caller: there is no substantiated capability set to report, and
   * reporting an unsubstantiated one would violate I-005-2 in the direction that
   * matters (a client must never be told a capability is available when the
   * daemon cannot show that the driver declared it). Reusing the registry's
   * existing error class rather than minting a second one keeps the driver
   * namespace closed at its registered seven codes.
   */
  read(driverName: string): DriverCapabilityReport {
    const capabilities = this.#capabilitiesFor(driverName);

    // Re-derive, every time, from the running build's own table. See the file
    // header: this is the one member that must not be cached.
    //
    // The guard is `!== true`, not falsiness and not `=== false`, because
    // `flags` arrives from a durable row and I-005-2 makes an undeclared
    // capability UNSUPPORTED — the same fail-closed comparison
    // `ProviderRegistry.checkCapability` makes. A driver whose `output_speed` is
    // false or missing gets NO vocabulary member at all, which is the encoding
    // `Spec-005 §The output-speed axis` requires: absent means the axis is
    // unsettable, and an empty array would instead assert a settable axis with
    // nothing on it.
    if (capabilities.flags.output_speed !== true) {
      return { driverName, capabilities };
    }

    // Spread into a fresh array: the vocabulary table is deep-frozen and shared
    // by every reader on both read paths, so handing the frozen array itself to
    // a wire consumer would make a downstream mutation throw rather than corrupt
    // — but it would also let a consumer that merely SORTS the reply fail at a
    // distance. Publishers hand out copies.
    return {
      driverName,
      capabilities,
      outputSpeedLevels: [...this.#resolveOutputSpeedLevels(driverName)],
    };
  }

  /**
   * Drop one driver's entry. The next `read` re-hydrates from the durable cache.
   *
   * Idempotent and tolerant of an unknown name: the invalidation source reports
   * whichever driver was re-declared, and a driver this cache has never read is
   * a normal case rather than an error.
   */
  invalidate(driverName: string): void {
    this.#entries.delete(driverName);
  }

  /**
   * Drop every entry. For the coarse events that can change many drivers at once
   * — a node-wide capability refresh, a daemon-side reload — where invalidating
   * per driver would require the caller to enumerate a set it does not own.
   */
  invalidateAll(): void {
    this.#entries.clear();
  }

  /**
   * Detach from the invalidation source and drop every entry.
   *
   * Dropping the entries is not housekeeping: after this call nothing can
   * invalidate them any more, so keeping them would let a closed cache serve
   * reads that grow staler with every re-declaration. A closed cache that
   * re-hydrates on the next read is honest; one that serves frozen answers is
   * not.
   */
  close(): void {
    const unsubscribe = this.#unsubscribeFromCapabilityUpdates;
    this.#unsubscribeFromCapabilityUpdates = undefined;
    if (unsubscribe !== undefined) {
      unsubscribe();
    }
    this.#entries.clear();
  }

  /** Cached-or-hydrated `DriverCapabilities`, always returned as a fresh copy. */
  #capabilitiesFor(driverName: string): DriverCapabilities {
    const cached = this.#entries.get(driverName);
    if (cached !== undefined) {
      return { ...cached.capabilities, flags: { ...cached.capabilities.flags } };
    }

    const hydration = this.#hydrateDurableCapabilities(driverName);
    if (!hydration.hit) {
      throw new DriverUnavailableError(driverName);
    }

    // Store a CLONE of the nested shape rather than an alias of the hydration
    // result. `hydrate()` builds a fresh object today, so aliasing would be
    // correct today — and would silently become a shared-mutable-state bug the
    // first time any read path started returning a memoized wrapper. The same
    // reasoning `ProviderRegistry.register` records for its own snapshot.
    const capabilities: DriverCapabilities = {
      ...hydration.result.capabilities,
      flags: { ...hydration.result.capabilities.flags },
    };
    this.#entries.set(driverName, { capabilities });

    // Return a SECOND copy, not the stored one: a caller that mutated the object
    // it was handed would otherwise rewrite the cache for every later reader.
    return { ...capabilities, flags: { ...capabilities.flags } };
  }
}
