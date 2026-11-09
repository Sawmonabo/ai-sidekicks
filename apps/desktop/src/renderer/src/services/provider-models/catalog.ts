// The driver catalog, read for the provider, model and effort pickers. What each driver declares
// beside its models (its built-in tools, its one speed list) is its section in the service's
// provider list, which the provider store keeps current; this read holds only the models.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { Clock } from "#renderer/lib/clock.js";
import type { DriverCatalogReading } from "#renderer/lib/provider-binding/driver-catalog.js";
import { PushDrivenRead } from "#renderer/store/reads/push-driven.js";
import { callDaemon, unwrapDaemonReply } from "../daemon/reply.js";
import { type PlatformBridge } from "../platform/bridge.js";

/** The driver catalog read. */
export type DriverCatalogRead = PushDrivenRead<DriverCatalogReading>;

/** The driver catalog of one session, whose own provider the service lists first. */
export function createDriverCatalogRead(
  bridge: PlatformBridge,
  clock: Clock,
  sessionId: SessionId,
): DriverCatalogRead {
  return new PushDrivenRead<DriverCatalogReading>({
    clock,
    origin: DRIVER_CATALOG_ORIGIN,
    read: async (signal: AbortSignal) => {
      const modelsReply = await callDaemon(
        bridge,
        "provider.model.list",
        { sessionId },
        { signal },
      );
      return { models: unwrapDaemonReply(modelsReply) };
    },
    // Nothing on the wire announces that a provider's catalog moved, so the read runs once
    // and never re-arms.
    subscribe: () => () => undefined,
  });
}

/** Names the driver catalog read in a refusal. */
const DRIVER_CATALOG_ORIGIN = "driver-catalog";
