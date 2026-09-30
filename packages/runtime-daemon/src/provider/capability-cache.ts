// Read-side capability cache behind `driver.listCapabilities`, served from memory:
// `ProviderDriver.getCapabilities()` is a session handshake on the pinned surfaces, so a client
// capability question must never put a provider process on its critical path.
//
//   * It is a third cache, not a duplicate: the durable `driver_capabilities` rows (a SQLite read)
//     and `ProviderRegistry`'s fail-closed snapshot (no `tools`, `cliVersion`) answer other
//     questions. A registry miss means the driver is not loaded; a miss here, never declared.
//   * The report is `GetCapabilitiesResult` without `tools`, `cliVersion` and `detectionSource`,
//     plus `driverName` and `builtInTools`, composed here (the wire schema is `.strict()`).
//   * `outputSpeedLevels` and `builtInTools` are driver constants, re-derived on every read and
//     never stored, so a redeploy cannot leave a client rendering choices the driver rejects. An
//     entry holds `DriverCapabilities` only.
//   * A re-declaration reporting `changed` invalidates through an injected subscription. Without
//     one, the caller must call `invalidate()` wherever it re-declares.

import type { DriverCapabilities, DriverCapabilityReport } from "@ai-sidekicks/contracts";

import type { DriverCapabilityHydrationResult } from "./driver-capabilities-writer.js";
import { builtInToolsFor } from "./driver-built-in-tools.js";
import { declaredOutputSpeedLevelsFor } from "./driver-output-speed.js";
import { DriverUnavailableError } from "./provider-registry.js";

/** Dependencies this cache reads through, so it holds no database handle, driver or timer. */
export interface DriverCapabilityCacheDeps {
  /**
   * Reads a driver's snapshot from the durable cache, normally `DriverCapabilitiesWriter.hydrate`.
   * Synchronous and touches no driver process; a miss makes the read refuse.
   */
  readonly hydrateDurableCapabilities: (driverName: string) => DriverCapabilityHydrationResult;

  /** Resolves a driver's output-speed vocabulary; defaults to `declaredOutputSpeedLevelsFor`. */
  readonly resolveOutputSpeedLevels?: ((driverName: string) => readonly string[]) | undefined;

  /**
   * Subscribes to capability changes for any driver, returning an unsubscribe handle; the cache
   * drops the named driver's entry so the next read re-hydrates.
   */
  readonly subscribeToCapabilityUpdates?:
    | ((onCapabilityUpdated: (driverName: string) => void) => () => void)
    | undefined;
}

// Deliberately has no `outputSpeedLevels` member (see the file header).
interface CachedCapabilityEntry {
  readonly capabilities: DriverCapabilities;
}

/** Serves `driver.listCapabilities` reports from memory, hydrating from the durable cache. */
export class DriverCapabilityCache {
  readonly #hydrateDurableCapabilities: (driverName: string) => DriverCapabilityHydrationResult;
  readonly #resolveOutputSpeedLevels: (driverName: string) => readonly string[];
  readonly #entries: Map<string, CachedCapabilityEntry> = new Map();

  // Cleared by `close()` so a second call cannot unsubscribe twice.
  #unsubscribeFromCapabilityUpdates: (() => void) | undefined;

  constructor(deps: DriverCapabilityCacheDeps) {
    this.#hydrateDurableCapabilities = deps.hydrateDurableCapabilities;
    this.#resolveOutputSpeedLevels = deps.resolveOutputSpeedLevels ?? declaredOutputSpeedLevelsFor;

    // At construction, not lazily: an update before the first read would leave a stale entry.
    if (deps.subscribeToCapabilityUpdates !== undefined) {
      this.#unsubscribeFromCapabilityUpdates = deps.subscribeToCapabilityUpdates((driverName) => {
        this.invalidate(driverName);
      });
    }
  }

  /**
   * Serves one driver's client-facing report; a miss does one durable read, never a provider
   * round-trip.
   *
   * @throws DriverUnavailableError (`driver.unavailable`) on a durable miss: with no declared
   * capability set, a client must not be told a capability is available.
   */
  read(driverName: string): DriverCapabilityReport {
    const capabilities = this.#capabilitiesFor(driverName);

    // `!== true` is the fail-closed comparison `ProviderRegistry.checkCapability` makes. Without
    // `output_speed` the member is absent (an empty array would claim a settable axis with no
    // values). The arrays are copied because the shared tables are frozen.
    const builtInTools = [...builtInToolsFor(driverName)];
    if (capabilities.flags.output_speed !== true) {
      return { driverName, capabilities, builtInTools };
    }
    return {
      driverName,
      capabilities,
      outputSpeedLevels: [...this.#resolveOutputSpeedLevels(driverName)],
      builtInTools,
    };
  }

  /** Drops one driver's entry; the next `read` re-hydrates. An unknown name is a no-op. */
  invalidate(driverName: string): void {
    this.#entries.delete(driverName);
  }

  /** Drops every entry, for events that can change many drivers at once. */
  invalidateAll(): void {
    this.#entries.clear();
  }

  /** Detaches from the invalidation source and drops every entry (none could be invalidated). */
  close(): void {
    const unsubscribe = this.#unsubscribeFromCapabilityUpdates;
    this.#unsubscribeFromCapabilityUpdates = undefined;
    if (unsubscribe !== undefined) {
      unsubscribe();
    }
    this.#entries.clear();
  }

  #capabilitiesFor(driverName: string): DriverCapabilities {
    const cached = this.#entries.get(driverName);
    if (cached !== undefined) {
      return { ...cached.capabilities, flags: { ...cached.capabilities.flags } };
    }

    const hydration = this.#hydrateDurableCapabilities(driverName);
    if (!hydration.hit) {
      throw new DriverUnavailableError(driverName);
    }

    // Cloned, not aliased: aliasing is safe only while `hydrate()` builds a fresh object.
    const capabilities: DriverCapabilities = {
      ...hydration.result.capabilities,
      flags: { ...hydration.result.capabilities.flags },
    };
    this.#entries.set(driverName, { capabilities });

    // A second copy, so a caller's mutation cannot rewrite the cache.
    return { ...capabilities, flags: { ...capabilities.flags } };
  }
}
