// One enumeration request, and the states one can settle into.
//
// The REQUEST and its readings live here; the lifetime rule that decides when one is
// live — keyed on the addressed agent, discarded before a re-read, discarded when the
// surface closes — is `provider-command-holder.ts`'s, because two zones observe that
// decision and only one of them may make it. Splitting them keeps this module a pure
// round trip a test can drive without a component, and keeps the holder free of the
// parsing.
//
// THE REPLY IS PARSED THROUGH THE REGISTERED SCHEMA AND NOTHING ELSE. A reply the
// schema will not accept is a refusal under this module's own code; a daemon refusal
// travels under the daemon's own code instead, never under that one.

import {
  ProviderCommandListResultSchema,
  type ProviderCommandBindingGroup,
} from "@ai-sidekicks/contracts";

import { wireRejectionToError } from "../../../../../shared/wire-errors.js";
import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";
import {
  LIST_PROVIDER_COMMANDS_METHOD,
  callUnregisteredDaemonMethod,
  type ConsoleBridge,
} from "../../../console/bridge/index.js";

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

/** One enumeration request, resolved into exactly one settled state. Never throws. */
export async function settleEnumeration(
  bridge: ConsoleBridge,
  sessionId: string,
  agentId: string,
): Promise<ProviderCommandReadState> {
  try {
    const reply = await callUnregisteredDaemonMethod(bridge, LIST_PROVIDER_COMMANDS_METHOD, {
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
    const wireError = wireRejectionToError(rejection, { total: true });
    return {
      phase: "refused",
      refusal: refuse(PROVIDER_COMMAND_READ_ORIGIN, wireError.name, wireError.message),
    };
  }
}
