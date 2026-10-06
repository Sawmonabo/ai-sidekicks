// What this session's daemon-hosted tool registry holds, and whether it is exposed. The caller
// supplies the read (the registry travels on the spawn parameter, not a client read), and a
// rejection surfaces unhandled. While the approval-create seam is unregistered the registry
// is withheld: entries are still listed, and a stray invocation is denied by the host.

import { useEffect, useState } from "react";

import type { SessionCallbackTool } from "@ai-sidekicks/contracts/provider/driver/tools";
import { WORKFLOW_RUN_TOOL } from "@ai-sidekicks/contracts/workflow/run/tool";

/**
 * The registry in the two states the callback tools section keeps apart. Both carry entries:
 * withholding is about whether an agent can reach a tool, not whether one is registered.
 */
export type CallbackToolRegistryReading =
  | { readonly kind: "withheld"; readonly tools: readonly SessionCallbackTool[] }
  | { readonly kind: "exposed"; readonly tools: readonly SessionCallbackTool[] };

/** Reads one session's registry; the caller supplies it. */
export type ReadCallbackToolRegistry = (request: {
  readonly sessionId: string;
}) => Promise<CallbackToolRegistryReading>;

/**
 * The registry's one entry, `workflow_run`, withheld.
 *
 * @consumedBy the agent definition's Tool allowlist
 */
export const BORN_WITHHELD_REGISTRY: readonly SessionCallbackTool[] = [WORKFLOW_RUN_TOOL];

/**
 * Reads the registry for one session, once per (read, session) pair. `undefined` while
 * pending, which the caller renders as not-checked rather than an empty registry. The settled
 * reading carries its inputs, so a rebound pane never shows the previous session's answer.
 *
 * @consumedBy the agent definition's Tool allowlist
 */
export function useCallbackToolRegistry(
  read: ReadCallbackToolRegistry,
  sessionId: string,
): CallbackToolRegistryReading | undefined {
  const [settled, setSettled] = useState<
    | {
        readonly read: ReadCallbackToolRegistry;
        readonly sessionId: string;
        readonly reading: CallbackToolRegistryReading;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    let abandoned = false;
    void (async () => {
      const reading = await read({ sessionId });
      if (abandoned) {
        return;
      }
      setSettled({ read, sessionId, reading });
    })();
    return () => {
      abandoned = true;
    };
  }, [read, sessionId]);

  return settled !== undefined && settled.read === read && settled.sessionId === sessionId
    ? settled.reading
    : undefined;
}
