// The enumeration read: one live read, held for the composer's current target and
// nothing longer.
//
// `Spec-023 §Signature Feature Composition Sketches` §The Session Composer states the
// lifetime as a rule rather than as advice — "not persisted, not cached across
// sessions, and re-read rather than patched" — and the re-addressing behaviour as its
// consequence: pointing the composer at a different agent RE-READS the enumeration
// rather than filtering the one already in hand. A filter would offer a Claude-
// enumerated command in a composer addressed to a Codex agent, which is exactly the
// routing invariant `Spec-005 §The provider command and skill surface` exists to
// forbid.
//
// So the read is keyed on the addressed agent, and a key change DISCARDS before it
// re-reads. The intermediate state is `not-loaded` and never the previous agent's
// list: a list that survived a re-address for one frame would be one frame in which
// the surface offered the wrong binding's commands.
//
// LAZY ON PURPOSE. The read runs when the discovery surface is open, not when the
// composer mounts. A person who never types a slash never spends a provider round
// trip, and the enumeration a closed popover holds is a cache — which is the thing
// the lifetime rule above forbids.

import { useEffect, useState } from "react";
import {
  ProviderCommandListResultSchema,
  type ProviderCommandBindingGroup,
} from "@ai-sidekicks/contracts";

import { normalizeWireRejection } from "../../../../../shared/wire-errors.js";
import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";
import {
  LIST_PROVIDER_COMMANDS_METHOD,
  callDaemon,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";
import type { ComposerTarget } from "../chips/chip-models.js";

/** The subsystem name every refusal this read raises carries. */
export const PROVIDER_COMMAND_READ_ORIGIN = "composer-command-discovery";

/**
 * Why the console could not read the reply as an enumeration.
 *
 * One code, closed. It is raised only for a reply that does not parse as the
 * registered result — a daemon-composed shape the console has no reading for, which
 * is a composition bug rather than a person-facing outcome. A daemon REFUSAL travels
 * under the daemon's own code instead, never under this one.
 */
export const PROVIDER_COMMAND_READ_REFUSAL_CODES = ["reply-unreadable"] as const;

/** One such code. Derived, so the vocabulary is declared exactly once. */
export type ProviderCommandReadRefusalCode = (typeof PROVIDER_COMMAND_READ_REFUSAL_CODES)[number];

/**
 * Where the enumeration read has got to.
 *
 * `not-checked` is a first-class arm and not an empty list: a composer addressed at a
 * channel has no agent to enumerate, so nobody asked — which rule 8 renders
 * differently from a provider that answered with nothing.
 */
export type ProviderCommandReadState =
  | { readonly phase: "not-checked" }
  | { readonly phase: "not-loaded" }
  | { readonly phase: "served"; readonly groups: readonly ProviderCommandBindingGroup[] }
  | { readonly phase: "refused"; readonly refusal: ConsoleRefusal };

const NOT_CHECKED: ProviderCommandReadState = { phase: "not-checked" };

/** The agent this composer would enumerate, or `undefined` when it addresses none. */
function addressedAgentId(target: ComposerTarget): string | undefined {
  return target.path === "provider-bound" ? target.agentId : undefined;
}

/** Read the addressed agent's commands and skills while the discovery surface is open. */
export function useProviderCommandEnumeration(options: {
  readonly bridge: ConsoleBridge;
  readonly target: ComposerTarget;
  readonly isOpen: boolean;
}): ProviderCommandReadState {
  const { bridge, target, isOpen } = options;
  const sessionId = target.sessionId;
  const agentId = addressedAgentId(target);
  const [state, setState] = useState<ProviderCommandReadState>(NOT_CHECKED);

  useEffect(() => {
    if (!isOpen || agentId === undefined) {
      // Discarded rather than retained. Closing the popover ends the read's lifetime,
      // and re-addressing ends it too — both leave the surface with no enumeration
      // rather than with the previous binding's.
      setState(NOT_CHECKED);
      return;
    }
    let isCurrent = true;
    setState({ phase: "not-loaded" });
    void settleEnumeration(bridge, sessionId, agentId).then((settled) => {
      if (isCurrent) {
        setState(settled);
      }
    });
    return () => {
      // The reply of a read whose key has changed has nowhere to go: writing it would
      // put one binding's commands under another binding's address.
      isCurrent = false;
    };
  }, [bridge, sessionId, agentId, isOpen]);

  return state;
}

/** One enumeration request, resolved into exactly one settled state. Never throws. */
export async function settleEnumeration(
  bridge: ConsoleBridge,
  sessionId: string,
  agentId: string,
): Promise<ProviderCommandReadState> {
  try {
    const reply = await callDaemon(bridge, LIST_PROVIDER_COMMANDS_METHOD, {
      sessionId,
      agentId,
    });
    const parsed = ProviderCommandListResultSchema.safeParse(reply);
    if (!parsed.success) {
      const code: ProviderCommandReadRefusalCode = "reply-unreadable";
      return {
        phase: "refused",
        refusal: refuse(
          PROVIDER_COMMAND_READ_ORIGIN,
          code,
          "The command enumeration did not match the registered result shape, so the console read no list from it.",
        ),
      };
    }
    return { phase: "served", groups: parsed.data.bindings };
  } catch (rejection) {
    // The daemon's own refusal, under the daemon's own code. `driver.unavailable` is
    // the ordinary one here — an agent holding no live binding has nothing to
    // enumerate — and it reads as itself rather than as a console-invented sentence.
    const wireError = normalizeWireRejection(rejection, { total: true });
    return {
      phase: "refused",
      refusal: refuse(PROVIDER_COMMAND_READ_ORIGIN, wireError.name, wireError.message),
    };
  }
}
