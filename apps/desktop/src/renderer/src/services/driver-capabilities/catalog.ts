// Both driver catalogs, read together for the provider, model and effort pickers. The capability
// report comes through the bridge's one capability reading, so a catalog read and a view gating on
// the flags share one `driver.listCapabilities` call.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { Clock } from "#renderer/lib/clock.js";
import type { DriverCatalogReading } from "#renderer/lib/provider-binding/driver-catalog.js";
import { PushDrivenRead } from "#renderer/store/reads/push-driven.js";
import { callDaemon, unwrapDaemonReply } from "../daemon/reply.js";
import { type PlatformBridge } from "../platform/bridge.js";
import { driverCapabilityReads } from "./read-cache.js";

/** The driver catalog read. */
export type DriverCatalogRead = PushDrivenRead<DriverCatalogReading>;

/**
 * Both driver catalogs, read together. The model catalog is per session; the capability report
 * belongs to the drivers and takes no session.
 */
export function createDriverCatalogRead(
  bridge: PlatformBridge,
  clock: Clock,
  sessionId: SessionId,
): DriverCatalogRead {
  return new PushDrivenRead<DriverCatalogReading>({
    clock,
    origin: DRIVER_CATALOG_ORIGIN,
    read: async (signal: AbortSignal) => {
      const [modelsReply, capabilities] = await Promise.all([
        callDaemon(bridge, "driver.listModels", { sessionId }, { signal }),
        driverCapabilityReads.reading(bridge, clock).readNextReply(signal),
      ]);
      return { models: unwrapDaemonReply(modelsReply), capabilities };
    },
    // Nothing on the wire announces that a provider's catalog moved, so the read runs once
    // and never re-arms.
    subscribe: () => () => undefined,
  });
}

/** Names the driver catalog read in a refusal. */
const DRIVER_CATALOG_ORIGIN = "driver-catalog";
