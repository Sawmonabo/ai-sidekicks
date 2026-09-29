// Drives one composer's provider-command enumeration from the command list, and reads it back.

import { useEffect, useSyncExternalStore } from "react";

import type { ConsoleBridge } from "@renderer/services/platform/platform-bridge.js";
import type { ComposerTarget } from "../../composer-target.js";
import type { ProviderCommandEnumeration } from "../provider-command-enumeration.js";
import type { ProviderCommandReadState } from "../provider-command-read.js";

/**
 * Drive one composer's enumeration from the surface that opens it, and read it back.
 *
 * The DISCOVERY SURFACE calls this: opening is its decision, because the leading
 * slash in the line is what makes the reading live. Every other reader observes the
 * same holder without opening anything, so the composer never asks twice and never
 * asks because somebody wanted to look at the answer.
 */
export function useProviderCommandEnumeration(options: {
  readonly enumeration: ProviderCommandEnumeration;
  readonly bridge: ConsoleBridge;
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
