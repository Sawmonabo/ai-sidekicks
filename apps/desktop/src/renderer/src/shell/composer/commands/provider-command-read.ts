// One enumeration request, and the states one can settle into.
//
// The REQUEST and its readings live here; the lifetime rule that decides when one is
// live — keyed on the addressed agent, discarded before a re-read, discarded when the
// surface closes — is `provider-command-holder.ts`'s, because two zones observe that
// decision and only one of them may make it. Splitting them keeps this module a pure
// round trip a test can drive without a component, and keeps the holder free of the
// parsing.
//
// THE READ GOES THROUGH THE ONE DOOR AND HOLDS NO PARSE OF ITS OWN. `callDaemon`
// parses the request before it is sent and the reply against the shape the corpus
// registers for `driver.listProviderCommands`, and answers `served` or `refused`
// without ever rejecting — so a reply this console cannot read, a request it could
// not build, and the daemon's own `driver.unavailable` all arrive as one refusal
// carrying its own code verbatim. What is left here is the pair of identifiers,
// parsed through their registered schemas, and the three settled states a surface
// renders.

import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts";

import { refuse, type ConsoleRefusal } from "../../../console/core/index.js";
import { callDaemon, readSessionId, type ConsoleBridge } from "../../../console/bridge/index.js";

/** The subsystem name every refusal this read raises carries. */
export const PROVIDER_COMMAND_READ_ORIGIN = "composer-command-discovery";

/**
 * Why the console refused an enumeration on its own side.
 *
 * One code, closed, and it is NOT the unreadable reply — that one belongs to the
 * call door, which owns the whole `DaemonReplyRefusalCode` vocabulary, and a second
 * spelling of it here would be a second name for one failure. What remains is the
 * question the door cannot answer: this composer is addressed at something whose
 * identifiers the registered request would not accept, so nothing was asked.
 */
export const PROVIDER_COMMAND_READ_REFUSAL_CODES = ["addressed-agent-unparseable"] as const;

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
  const parsedSessionId = readSessionId(sessionId);
  if (parsedSessionId === undefined) {
    return { phase: "refused", refusal: unparseableAddress() };
  }
  const reply = await callDaemon(bridge, "driver.listProviderCommands", {
    sessionId: parsedSessionId,
    agentId,
  });
  // The daemon's own refusal reads as itself. `driver.unavailable` is the ordinary
  // one here — an agent holding no live binding has nothing to enumerate.
  return reply.status === "refused"
    ? { phase: "refused", refusal: reply.refusal }
    : { phase: "served", groups: reply.value.bindings };
}

/** The refusal for a composer addressed at identifiers the wire would not accept. */
function unparseableAddress(): ConsoleRefusal {
  const code: ProviderCommandReadRefusalCode = "addressed-agent-unparseable";
  return refuse(
    PROVIDER_COMMAND_READ_ORIGIN,
    code,
    "The console is holding identifiers for this agent that the daemon would not accept, so it asked for no enumeration. Reopen the session so its identifiers are read again.",
  );
}
