// `presence.read`: the devices connected to this machine, and whether an app
// window is in front on each.
//
// Presence is the machine's, never a session's, so the request is empty. The
// answer comes from the heartbeats the machine holds in memory, one per device;
// nothing is read from storage.
//
// `mutating: false` (from the descriptor): reading presence changes nothing, so a
// connection whose protocol version is incompatible can still read it.
import type { MachinePresence, MethodRegistry } from "@ai-sidekicks/contracts";
import { PRESENCE_METHOD_DESCRIPTORS } from "@ai-sidekicks/contracts";

import { registerDescribedMethod } from "./register-described-method.js";

/** What `presence.read` answers from. */
export interface PresenceReadDeps {
  /**
   * The devices connected to this machine now, as the machine last heard from
   * each. No device connected is an empty list, not an error.
   */
  readonly readPresence: () => Promise<MachinePresence>;
}

/** Bind `presence.read`. A second registration on the same registry throws. */
export function registerPresenceRead(registry: MethodRegistry, deps: PresenceReadDeps): void {
  registerDescribedMethod(registry, PRESENCE_METHOD_DESCRIPTORS["presence.read"], async () =>
    deps.readPresence(),
  );
}
