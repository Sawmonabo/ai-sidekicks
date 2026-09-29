// What this session's daemon-hosted tool registry holds, and whether it is exposed.
//
// THE READ IS AN ARGUMENT. The registry travels on the driver-facing spawn parameter,
// which is not a client read, so the caller supplies the read. The hook does not catch
// a rejection from it: a read that rejects surfaces as an unhandled rejection.
//
// WHAT IS WITHHELD IS A SEPARATE FACT. While the daemon's approval-create seam is not
// registered, spawn withholds the registry, the tools are not exposed, and a stray
// invocation is answered `denied` by the host's runtime backstop with a driver
// diagnostic — never completed without a policy decision and never left unanswered.
// The withheld arm still carries the registry's entries, because withholding is about
// whether an agent can REACH a tool, not whether one is registered.
//
// THE ENTRY IS THE CONTRACT'S, NOT AN EXAMPLE. `workflow_run` is the first concrete
// session callback tool the daemon registers, its name, description and input schema
// are fixed by the wire contract, and it is born-withheld by the same rule.

import { useEffect, useState } from "react";

import { type SessionCallbackTool } from "@ai-sidekicks/contracts";

/**
 * The registry, in the two states the callback tools section refuses to collapse.
 *
 * Both carry entries, because withholding is about whether an agent can REACH a tool
 * rather than about whether one is registered.
 */
export type CallbackToolRegistryReading =
  | { readonly kind: "withheld"; readonly tools: readonly SessionCallbackTool[] }
  | { readonly kind: "exposed"; readonly tools: readonly SessionCallbackTool[] };

/** Reads one session's registry; the caller supplies it. */
export type ReadCallbackToolRegistry = (request: {
  readonly sessionId: string;
}) => Promise<CallbackToolRegistryReading>;

/**
 * The registry's one entry, `workflow_run`, which is withheld.
 *
 * @consumedBy the agent definition's Tool allowlist
 */
export const BORN_WITHHELD_REGISTRY: readonly SessionCallbackTool[] = [
  {
    name: "workflow_run",
    description:
      "Start a workflow run in this session by definition name. Resolution is most-specific-first across the session, project, and shared scopes.",
    inputSchema: {
      type: "object",
      properties: {
        definitionName: { type: "string" },
        scope: { enum: ["session", "project", "shared"] },
      },
      required: ["definitionName"],
      additionalProperties: false,
    },
  },
];

/**
 * Read the registry for one session, once per (read, session) pair.
 *
 * `undefined` while the read is pending, which the caller renders as the not-checked
 * kind of nothing rather than as an empty registry. The settled reading carries its
 * inputs so a pane that rebinds to another session cannot report the previous
 * session's answer for the interval before the replacement lands.
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
