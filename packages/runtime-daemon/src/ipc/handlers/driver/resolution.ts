// Finds the provider driver a handler acts through: by its name, by the run it runs, or by the
// session it serves. The address is refused before availability, so an id that never existed is
// not reported as a driver problem.
//
// These throw the registry's typed errors, which are daemon domain errors carrying their wire codes.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ProviderDriver } from "../../../provider/driver/contract.js";
import {
  DriverUnavailableError,
  type ProviderRegistry,
} from "../../../provider/driver/registry.js";
import { RunNotFoundError } from "../../../session/run/refusals.js";
import { SessionNotFoundError } from "../../session-errors.js";

/**
 * What a run-addressed handler needs to find the driver bound to a run. `resolveDriverForRun`
 * names that driver, or `undefined` when the run is unknown or not live; the handler does not
 * judge liveness.
 */
export interface DriverDispatchDeps {
  readonly providerRegistry: Pick<ProviderRegistry, "lookup">;
  readonly resolveDriverForRun: (runId: RunId) => ProviderName | undefined;
}

/**
 * What a session-addressed handler needs to find the driver its session runs on.
 * `resolveDriverForSession` names that driver, or `undefined` for a session that does not exist
 * here or is not bound to this node; one answer for both keeps the refusal the same.
 */
export interface SessionDriverDeps {
  readonly providerRegistry: Pick<ProviderRegistry, "lookup">;
  readonly resolveDriverForSession: (sessionId: SessionId) => ProviderName | undefined;
}

// A driver as a handler resolved it, with the name it is registered under.
interface ResolvedDriver {
  readonly driverName: ProviderName;
  readonly driver: ProviderDriver;
}

/**
 * The only throw site for the session mask: a constant message and no fields, so a session not
 * bound here is indistinguishable from an unknown one.
 */
export function refuseSessionNotFound(): never {
  throw new SessionNotFoundError("Session does not exist or is not accessible");
}

/** The loaded driver registered as `driverName`; throws `DriverUnavailableError` if none. */
export function lookupDriverOrThrow(
  providerRegistry: Pick<ProviderRegistry, "lookup">,
  driverName: ProviderName,
): ProviderDriver {
  const driver = providerRegistry.lookup(driverName);
  if (driver === undefined) {
    throw new DriverUnavailableError(driverName);
  }
  return driver;
}

/**
 * Resolves the driver bound to a run. Throws `run.not_found` for a run with no live binding, then
 * `DriverUnavailableError` for a driver this node has not loaded.
 */
export function resolveDriverForRunOrThrow(deps: DriverDispatchDeps, runId: RunId): ResolvedDriver {
  // Called once: the resolver reads live binding state, so a second call could disagree.
  const driverName = deps.resolveDriverForRun(runId);
  if (driverName === undefined) {
    throw new RunNotFoundError(runId);
  }
  return { driverName, driver: lookupDriverOrThrow(deps.providerRegistry, driverName) };
}

/**
 * Resolves the driver a session runs on. Throws `session.not_found` for a session this node does
 * not hold, then `DriverUnavailableError` for a driver this node has not loaded.
 */
export function resolveDriverForSessionOrThrow(
  deps: SessionDriverDeps,
  sessionId: SessionId,
): ResolvedDriver {
  const driverName = deps.resolveDriverForSession(sessionId);
  if (driverName === undefined) {
    refuseSessionNotFound();
  }
  return { driverName, driver: lookupDriverOrThrow(deps.providerRegistry, driverName) };
}
