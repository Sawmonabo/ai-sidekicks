// Read-side capability cache behind `driver.listCapabilities`, served from memory:
// `ProviderDriver.getCapabilities()` is a session handshake on the pinned surfaces, so a client
// capability question must never put a provider process on its critical path.
//
//   * It is a third cache, not a duplicate: the durable `driver_capabilities` rows (a SQLite read)
//     and `ProviderRegistry`'s fail-closed snapshot (no `tools`, `cliVersion`) answer other
//     questions. A registry miss means the driver is not loaded; a miss here, never declared.
//   * The report is `GetCapabilitiesResult` without `tools`, `cliVersion` and `detectionSource`,
//     plus `driverName` and `builtInTools`, composed here (the wire schema is `.strict()`).
//   * A driver's static `outputSpeedLevels` and its `builtInTools` are driver constants,
//     re-derived on every read and never stored, so a redeploy cannot leave a client rendering
//     choices the driver rejects. An entry holds `DriverCapabilities` only.
//   * A re-declaration reporting `changed` invalidates through an injected subscription. Without
//     one, the caller must call `invalidate()` wherever it re-declares.

import type { DriverCapabilities } from "@ai-sidekicks/contracts/provider/driver/driver";
import type { DriverCapabilityReport } from "@ai-sidekicks/contracts/provider/driver/wire";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/account/account";

import type { DriverCapabilityHydrationResult } from "./driver-capabilities-writer.js";
import {
  composeStaticOutputSpeedLevels,
  PROVIDER_DRIVER_DESCRIPTORS,
} from "./provider-driver-descriptors.js";
import { DriverUnavailableError } from "./provider-registry.js";

/** Dependencies this cache reads through, so it holds no database handle, driver or timer. */
export interface DriverCapabilityCacheDeps {
  /**
   * Reads a driver's snapshot from the durable cache, normally `DriverCapabilitiesWriter.hydrate`.
   * Synchronous and touches no driver process; a miss makes the read refuse.
   */
  readonly hydrateDurableCapabilities: (
    driverName: ProviderName,
  ) => DriverCapabilityHydrationResult;

  /**
   * Subscribes to capability changes for any driver, returning an unsubscribe handle; the cache
   * drops the named driver's entry so the next read re-hydrates.
   */
  readonly subscribeToCapabilityUpdates?:
    | ((onCapabilityUpdated: (driverName: ProviderName) => void) => () => void)
    | undefined;
}

// Deliberately has no `outputSpeedLevels` member (see the file header).
interface CachedCapabilityEntry {
  readonly capabilities: DriverCapabilities;
}

/** Serves `driver.listCapabilities` reports from memory, hydrating from the durable cache. */
export class DriverCapabilityCache {
  readonly #hydrateDurableCapabilities: (
    driverName: ProviderName,
  ) => DriverCapabilityHydrationResult;
  readonly #entries: Map<ProviderName, CachedCapabilityEntry> = new Map();

  // Cleared by `close()` so a second call cannot unsubscribe twice.
  #unsubscribeFromCapabilityUpdates: (() => void) | undefined;

  constructor(deps: DriverCapabilityCacheDeps) {
    this.#hydrateDurableCapabilities = deps.hydrateDurableCapabilities;

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
  read(driverName: ProviderName): DriverCapabilityReport {
    const capabilities = this.#capabilitiesFor(driverName);
    const descriptor = PROVIDER_DRIVER_DESCRIPTORS[driverName];

    // Copied because the descriptors are frozen.
    return {
      driverName,
      capabilities,
      ...composeStaticOutputSpeedLevels(driverName, capabilities.flags),
      builtInTools: [...descriptor.builtInTools],
    };
  }

  /** Drops one driver's entry; the next `read` re-hydrates. A driver never read is a no-op. */
  invalidate(driverName: ProviderName): void {
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

  #capabilitiesFor(driverName: ProviderName): DriverCapabilities {
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
