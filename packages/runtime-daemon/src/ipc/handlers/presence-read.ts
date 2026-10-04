// `presence.read`: the devices connected to this machine, and whether an app window is in
// front on each. Presence belongs to the machine, not a session, so the request is empty.
// The answer comes from the heartbeats held in memory, one per device; nothing is read from
// storage. The descriptor is not `mutating`, so a connection with an incompatible protocol
// version can still read it.
import type { MachinePresence } from "@ai-sidekicks/contracts/presence";
import type { MethodRegistry } from "@ai-sidekicks/contracts/jsonrpc-registry";
import { PRESENCE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts/presence";

import { registerDescribedMethod } from "./register-described-method.js";

/** What `presence.read` answers from. */
export interface PresenceReadDeps {
  /**
   * The devices connected to this machine now, as the machine last heard from
   * each. No device connected is an empty list, not an error.
   */
  readonly readPresence: () => Promise<MachinePresence>;
}

/** Binds `presence.read` onto the registry. A second binding on one registry throws. */
export function registerPresenceRead(registry: MethodRegistry, deps: PresenceReadDeps): void {
  registerDescribedMethod(registry, PRESENCE_METHOD_DESCRIPTORS["presence.read"], async () =>
    deps.readPresence(),
  );
}
