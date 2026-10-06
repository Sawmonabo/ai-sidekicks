// In-memory registry of live `ProviderDriver` instances and the capability-flag gate.
//
// Registering a driver caches its capability snapshot once. The gate (`checkCapability`) reads
// that snapshot; it never calls the driver and never reads the database. The registry takes no
// store: capability persistence (`DriverCapabilitiesWriter`) and `RuntimeBindingStore` are
// separate components.
//
// The gate fails closed: a flag is supported only when its cached value is exactly `true`.
// `applyIntervention` is not gated here, because its degraded fallback must reach the driver.
//
// The error classes carry a stable `driver.*` code and a leak-safe message with structured
// `fields`, like `ipc/session-errors.ts`.

import type {
  DriverCapabilities,
  DriverCapabilityFlag,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import {
  DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE,
  type ProviderDriver,
} from "./driver/provider-driver.js";

/**
 * Thrown when a capability check targets a `driverId` that is not registered.
 *
 * `code` is `driver.unavailable`. The message is a fixed sentence and `fields` carries only
 * `{ driverId }`, so nothing internal leaks.
 */
export class DriverUnavailableError extends Error {
  readonly code = "driver.unavailable" as const;
  readonly fields: { readonly driverId: ProviderName };

  constructor(driverId: ProviderName) {
    super("Provider driver is currently unavailable");
    this.name = "DriverUnavailableError";
    this.fields = { driverId };
  }
}

/**
 * Thrown by the fail-closed gate when a flag is declared `false` or is absent from the cached
 * snapshot.
 *
 * `code` is `driver.capability_unsupported`. The message is a fixed sentence and `fields`
 * carries only `{ driverId, flag }`.
 */
export class DriverCapabilityUnsupportedError extends Error {
  readonly code = "driver.capability_unsupported" as const;
  readonly fields: { readonly driverId: ProviderName; readonly flag: DriverCapabilityFlag };

  constructor(driverId: ProviderName, flag: DriverCapabilityFlag) {
    super(DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE);
    this.name = "DriverCapabilityUnsupportedError";
    this.fields = { driverId, flag };
  }
}

/** The driver instance plus the capability snapshot resolved once at registration. */
interface RegisteredDriver {
  readonly driver: ProviderDriver;
  readonly capabilities: DriverCapabilities;
}

/** Holds the registered drivers and gates capability-bound calls on their cached flags. */
export class ProviderRegistry {
  readonly #drivers: Map<ProviderName, RegisteredDriver> = new Map();

  // Per-driver registration token; a superseded `register` sees a newer token and drops its
  // result (see `register`).
  readonly #registrationSeq: Map<ProviderName, number> = new Map();

  /**
   * Registers a driver under `driverId`, or refreshes it: awaits `driver.getCapabilities()` once
   * and caches the snapshot with the driver. Re-registering replaces the snapshot.
   *
   * The latest-initiated call wins when two calls for the same id overlap, whichever
   * `getCapabilities()` resolves first, because a later call carries newer provider state.
   */
  async register(driverId: ProviderName, driver: ProviderDriver): Promise<void> {
    // Claim the token before the await so a later call can supersede this one.
    const token: number = (this.#registrationSeq.get(driverId) ?? 0) + 1;
    this.#registrationSeq.set(driverId, token);

    const result = await driver.getCapabilities();

    // A newer `register` superseded this call while it awaited; drop the stale snapshot.
    if (this.#registrationSeq.get(driverId) !== token) {
      return;
    }

    // Cache a copy of `result.capabilities` and its `flags`, not an alias, so a later
    // driver-side mutation of its own `flags` object cannot change what the gate enforces.
    this.#drivers.set(driverId, {
      driver,
      capabilities: {
        ...result.capabilities,
        flags: { ...result.capabilities.flags },
      },
    });
  }

  /** Returns the registered driver, or `undefined` on a miss; it never throws. */
  lookup(driverId: ProviderName): ProviderDriver | undefined {
    return this.#drivers.get(driverId)?.driver;
  }

  /**
   * Throws unless `flag` is declared `true` for `driverId`: `DriverUnavailableError` for an
   * unregistered driver, `DriverCapabilityUnsupportedError` otherwise. It tests `!== true`, so a
   * flag whose cached value is `undefined` (a bogus flag from an untyped caller) is rejected too.
   */
  checkCapability(driverId: ProviderName, flag: DriverCapabilityFlag): void {
    const entry = this.#drivers.get(driverId);
    if (entry === undefined) {
      throw new DriverUnavailableError(driverId);
    }
    if (entry.capabilities.flags[flag] !== true) {
      throw new DriverCapabilityUnsupportedError(driverId, flag);
    }
  }

  /** Returns the registered driver ids, one per driver. */
  listAvailable(): readonly ProviderName[] {
    return [...this.#drivers.keys()];
  }
}
