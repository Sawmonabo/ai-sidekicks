// One enumeration request and the states it settles into. When a reading is live is decided by
// `provider-command-enumeration.ts`; this stays a pure round trip through `callDaemon`, which
// parses request and reply and never rejects: an unreadable reply and `driver.unavailable` alike
// arrive as a refusal. The round's signal is a parameter, since the holder owns the read.

import type { ProviderCommandBindingGroup } from "@ai-sidekicks/contracts/provider/driver/transcript";

import { refuse, type Refusal } from "@renderer/lib/refusal/refusal.js";
import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import { readSessionId } from "@renderer/services/daemon/wire/identifiers.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";

/** The subsystem name every refusal this read raises carries. */
export const PROVIDER_COMMAND_READ_ORIGIN = "composer-command-discovery";

/**
 * The console-side refusal codes. Not the unreadable reply, which `callDaemon` owns: this one
 * covers a composer addressed at identifiers the registered request would not accept.
 */
export const PROVIDER_COMMAND_READ_REFUSAL_CODES = ["addressed-agent-unparseable"] as const;

/** One such code, derived so the vocabulary is declared once. */
export type ProviderCommandReadRefusalCode = (typeof PROVIDER_COMMAND_READ_REFUSAL_CODES)[number];

/**
 * Where the enumeration read has got to. `not-checked` is not an empty list: a composer addressed
 * at the session has no agent to enumerate, and that renders differently from an empty answer.
 */
export type ProviderCommandReadState =
  | { readonly phase: "not-checked" }
  | { readonly phase: "not-loaded" }
  | { readonly phase: "served"; readonly groups: readonly ProviderCommandBindingGroup[] }
  | { readonly phase: "refused"; readonly refusal: Refusal };

/**
 * One enumeration request, resolved into exactly one settled state. Never throws. `signal` is the
 * round's: an already-abandoned line puts nothing on the wire and one abandoned mid-flight parses
 * nothing, both settling as `callDaemon`'s `read-abandoned` refusal, which the holder never
 * publishes.
 */
export async function settleEnumeration(
  bridge: PlatformBridge,
  sessionId: string,
  agentId: string,
  signal: AbortSignal,
): Promise<ProviderCommandReadState> {
  const parsedSessionId = readSessionId(sessionId);
  if (parsedSessionId === undefined) {
    return { phase: "refused", refusal: unparseableAddress() };
  }
  const reply = await callDaemon(
    bridge,
    "driver.listProviderCommands",
    {
      sessionId: parsedSessionId,
      agentId,
    },
    { signal },
  );
  // The daemon's own refusal reads as itself; `driver.unavailable` is the ordinary one (an agent
  // with no live binding).
  return reply.status === "refused"
    ? { phase: "refused", refusal: reply.refusal }
    : { phase: "served", groups: reply.value.bindings };
}

/** The refusal for a composer addressed at identifiers the wire would not accept. */
function unparseableAddress(): Refusal {
  const code: ProviderCommandReadRefusalCode = "addressed-agent-unparseable";
  return refuse(PROVIDER_COMMAND_READ_ORIGIN, code, "Could not load this session");
}
