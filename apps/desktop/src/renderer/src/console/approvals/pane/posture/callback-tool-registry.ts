// What this session's daemon-hosted tool registry holds, and whether it is exposed.
//
// THE READ IS PUT EVEN THOUGH NO WIRE ANSWERS IT. `callbackToolRegistryRead` is a
// growth-port operation: the registry travels on the driver-facing spawn parameter,
// which is not a client read, and both bridges answer `wire-unregistered`. Putting
// the call anyway is what makes this surface a consumer of the seam rather than a
// hard-coded page — the day the wire lands, the exposed arm below is already its
// reader — and it is what lets the surface NAME the missing read instead of implying
// it looked.
//
// WHAT THE REFUSAL DOES AND DOES NOT SETTLE. It settles that nothing read the
// registry. It does not settle that the registry is empty, and this module never
// reads it that way. What is withheld is a separate fact the corpus states outright:
// while the daemon's approval-create seam is unregistered, spawn withholds the
// registry, the tools are not exposed, and a stray invocation is answered `denied` by
// the host's runtime backstop with a driver diagnostic — never completed without a
// policy decision and never left unanswered. So the withheld arm carries BOTH: the
// registry's one born-withheld entry, and the refusal that says no read was answered.
//
// THE ENTRY IS THE CORPUS'S, NOT AN EXAMPLE. `workflow_start` is the first concrete
// session callback tool the corpus registers, its name, description and input schema
// are fixed by `api-payload-contracts.md`, and it is born-withheld by the same rule.
// Rendering it is not the console inventing a registry: it is the console rendering
// the one entry the contract says is there, in the state the contract says it is in.

import { useEffect, useState } from "react";

import { type SessionCallbackTool } from "@ai-sidekicks/contracts";

import { isUnbuiltWireRefusal, type ConsoleBridge } from "../../../bridge/index.js";
import { type ConsoleRefusal } from "../../../core/index.js";

/**
 * The registry, in the three states the surface refuses to collapse.
 *
 * `withheld` and `exposed` both carry entries, because withholding is about whether
 * an agent can REACH a tool rather than about whether one is registered. `unread` is
 * the arm for a refusal that is not the unregistered-wire one — a call that rejected,
 * or a fixture with nothing scripted — where the console genuinely does not know.
 */
export type CallbackToolRegistryReading =
  | { readonly kind: "unread"; readonly refusal: ConsoleRefusal }
  | {
      readonly kind: "withheld";
      readonly tools: readonly SessionCallbackTool[];
      /** The read that was put and answered with no wire, named rather than implied. */
      readonly unreadRefusal: ConsoleRefusal;
    }
  | { readonly kind: "exposed"; readonly tools: readonly SessionCallbackTool[] };

/**
 * The registry as the corpus registers it today: one entry, born withheld.
 *
 * Frozen at module scope rather than rebuilt per render, so the reading below is
 * referentially stable for the whole life of the process and a surface holding it
 * re-renders only when the read settles.
 */
const BORN_WITHHELD_REGISTRY: readonly SessionCallbackTool[] = [
  {
    name: "workflow_start",
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
 * Read the registry for one session, once per (bridge, session) pair.
 *
 * `undefined` until the read settles, which the caller renders as the not-checked
 * kind of nothing rather than as an empty registry. The settled reading carries its
 * inputs so a pane that rebinds to another session cannot report the previous
 * session's answer for the interval before the replacement lands.
 */
export function useCallbackToolRegistry(
  bridge: ConsoleBridge,
  sessionId: string,
): CallbackToolRegistryReading | undefined {
  const [settled, setSettled] = useState<
    | {
        readonly bridge: ConsoleBridge;
        readonly sessionId: string;
        readonly reading: CallbackToolRegistryReading;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    let abandoned = false;
    void (async () => {
      const reading = await readRegistry(bridge, sessionId);
      if (abandoned) {
        return;
      }
      setSettled({ bridge, sessionId, reading });
    })();
    return () => {
      abandoned = true;
    };
  }, [bridge, sessionId]);

  return settled !== undefined && settled.bridge === bridge && settled.sessionId === sessionId
    ? settled.reading
    : undefined;
}

/**
 * Put the read and map its answer onto the three arms.
 *
 * The rejection is caught here rather than left to the effect's promise, because a
 * seam that rejects instead of answering would otherwise pin the surface on the
 * in-flight state for the life of the mount.
 */
async function readRegistry(
  bridge: ConsoleBridge,
  sessionId: string,
): Promise<CallbackToolRegistryReading> {
  try {
    const outcome = await bridge.growth.callbackToolRegistryRead({ sessionId });
    if (outcome.status === "served") {
      return { kind: "exposed", tools: outcome.value };
    }
    // The wire is not registered anywhere in the corpus, which is the standing V1
    // condition — and the same condition under which spawn withholds the registry.
    // Both facts are carried; neither is inferred from the other.
    return isUnbuiltWireRefusal(outcome)
      ? { kind: "withheld", tools: BORN_WITHHELD_REGISTRY, unreadRefusal: outcome }
      : { kind: "unread", refusal: outcome };
  } catch {
    return { kind: "unread", refusal: CALLBACK_REGISTRY_READ_FAILURE };
  }
}

/** The refusal a seam that rejected is read as, so the surface still settles. */
const CALLBACK_REGISTRY_READ_FAILURE: ConsoleRefusal = {
  code: "call-rejected",
  detail:
    "The daemon-hosted tool registry read did not answer. Nothing here reports what an agent can reach until it does.",
  origin: "growth-port",
};
