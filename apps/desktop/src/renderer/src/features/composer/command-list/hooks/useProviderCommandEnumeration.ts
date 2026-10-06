// Drives one composer's provider-command enumeration from the command list, and reads it back.

import { useEffect, useSyncExternalStore } from "react";

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { ComposerTarget } from "../../target.js";
import type { ProviderCommandEnumeration } from "../provider/enumeration.js";
import type { ProviderCommandReadState } from "../provider/read.js";

/**
 * Drive one composer's enumeration from the command list that opens it, and read it back. Opening
 * is the command list's decision, since the leading slash makes the reading live; other readers
 * observe the same holder without opening it, so the composer never asks twice.
 */
export function useProviderCommandEnumeration(options: {
  readonly enumeration: ProviderCommandEnumeration;
  readonly bridge: PlatformBridge;
  readonly target: ComposerTarget;
  readonly isOpen: boolean;
}): ProviderCommandReadState {
  const { enumeration, bridge, target, isOpen } = options;
  const sessionId = target.sessionId;
  const agentId = addressedAgentId(target);

  useEffect(() => {
    if (!isOpen || agentId === undefined) {
      enumeration.close();
      return;
    }
    enumeration.open({ bridge, sessionId, agentId });
  }, [enumeration, bridge, sessionId, agentId, isOpen]);

  return useSyncExternalStore(enumeration.subscribe, enumeration.snapshot, enumeration.snapshot);
}

/** The agent this composer would enumerate, or `undefined` when it addresses none. */
function addressedAgentId(target: ComposerTarget): string | undefined {
  return target.path === "provider-bound" ? target.agentId : undefined;
}
