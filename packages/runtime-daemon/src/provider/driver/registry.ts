// In-memory registry of live `ProviderDriver` instances and the capability-flag gate.
//
// Registering a driver caches the capability snapshot its read reported. The gate
// (`checkCapability`) reads that snapshot; it never calls the driver and never reads the database.
// The registry takes no store: capability persistence (`DriverCapabilitiesWriter`) and
// `RuntimeBindingStore` are separate components.
//
// The gate fails closed: a flag is supported only when its cached value is exactly `true`.
// `applyIntervention` is not gated here, because its degraded fallback must reach the driver.
//
// The error classes are daemon domain errors: a stable `driver.*` code and a leak-safe message,
// with structured detail the wire carries as `data.fields`.

import type {
  DriverCapabilities,
  DriverCapabilityFlag,
} from "@ai-sidekicks/contracts/provider/driver/capabilities";
import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

import { DaemonDomainError } from "../../ipc/domain-error.js";
import { DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE, type ProviderDriver } from "./contract.js";

/**
 * Thrown when a capability check targets a `driverId` that is not registered.
 *
 * `code` is `driver.unavailable`. The message is a fixed sentence and its detail carries only
 * `{ driverId }`, so nothing internal leaks.
 */
export class DriverUnavailableError extends DaemonDomainError {
  declare readonly code: "driver.unavailable";

  constructor(driverId: ProviderName) {
    super("Provider driver is currently unavailable", {
      code: "driver.unavailable",
      jsonRpcCode: JsonRpcErrorCode.InternalError,
      detail: { driverId },
    });
  }
}

/**
 * Thrown by the fail-closed gate when a flag is declared `false` or is absent from the cached
 * snapshot.
 *
 * `code` is `driver.capability_unsupported`. The message is a fixed sentence and its detail
 * carries only `{ driverId, flag }`.
 */
export class DriverCapabilityUnsupportedError extends DaemonDomainError {
  declare readonly code: "driver.capability_unsupported";

  constructor(driverId: ProviderName, flag: DriverCapabilityFlag) {
    // `InvalidRequest`: the params resolve and a protocol-state contract fails.
    super(DRIVER_CAPABILITY_UNSUPPORTED_MESSAGE, {
      code: "driver.capability_unsupported",
      jsonRpcCode: JsonRpcErrorCode.InvalidRequest,
      detail: { driverId, flag },
    });
  }
}

/** The driver instance plus the capability snapshot it was registered with. */
interface RegisteredDriver {
  readonly driver: ProviderDriver;
  readonly capabilities: DriverCapabilities;
}

/** Holds the registered drivers and gates capability-bound calls on their cached flags. */
export class ProviderRegistry {
  readonly #drivers: Map<ProviderName, RegisteredDriver> = new Map();

  /**
   * Registers a driver under `driverId`, or refreshes it, with the capabilities its read reported;
   * the registry keeps its own copy, so a later change to the caller's object changes no gate.
   * Re-registering replaces the snapshot.
   */
  register(driverId: ProviderName, driver: ProviderDriver, capabilities: DriverCapabilities): void {
    this.#drivers.set(driverId, {
      driver,
      capabilities: { ...capabilities, flags: { ...capabilities.flags } },
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
