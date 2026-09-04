// What a switch settlement SAYS, as a projection of the reply and nothing else.
//
// `Spec-023 §Console Design (Meridian)` §Switch settlement, continuity, and declared
// losses fixes the one rule this module exists to hold: the reply's `status` is the
// discriminator and the renderer never re-derives it. `degraded` is exactly the
// `memo` continuity and `applied` is exactly the other two, and both facts are
// already on the wire — recomputing either here would make this a second source of
// truth for a settlement the daemon already settled.
//
// So this is a pure function over the reply. It holds no state, reaches no bridge,
// and renders nothing. Its output is a small record a component lays out, which is
// what lets the mapping be tested against every arm without a DOM.
//
// FOUR THINGS IT REFUSES TO DO
//
//   • It never presents a `memo` settlement as an ordinary success, and never
//     decorates a lossless one with a generic caution.
//   • It never renders the failed arm as a switch. The participant asked for a
//     change that did not happen.
//   • It never drops an unrecognized `reason` or continuity value: an unknown member
//     renders as itself, so a later amendment is visible rather than silently gone.
//   • It never invents a terminal for a superseded switch. A displaced intent
//     reaches no terminal event, and `replacedSwitchId` on the acknowledgment that
//     displaced it is the whole record.

import {
  SWITCH_BOUNDARIES,
  SWITCH_CONTINUITIES,
  SWITCH_FAILURE_REASONS,
  SWITCH_STATUSES,
  isKnownMember,
  type AgentSwitchSettlement,
} from "./agent-wire.js";

/** How a settlement reads: a plain statement, or the one arm that is a caution. */
export type SettlementTone = "stated" | "caution";

export interface SettlementRendering {
  readonly tone: SettlementTone;
  /** Whether `status` is a member this console knows. Unknown still renders. */
  readonly isKnownStatus: boolean;
  /** The one-line statement, in the participant's terms. */
  readonly headline: string;
  /**
   * What the new binding can see, where the settlement said. `undefined` on the
   * pending arm, which has settled nothing yet.
   */
  readonly continuityClause: string | undefined;
  /**
   * The named losses, in plain words. An EMPTY array on the reply is a positive
   * assertion that nothing was dropped and gets its own sentence; an ABSENT array
   * asserts nothing and gets none.
   */
  readonly lossClause: string | undefined;
  /** Set where this acknowledgment displaced an earlier intent. */
  readonly supersededSwitchId: string | undefined;
}

const BOUNDARY_PHRASES: Readonly<Record<string, string>> = {
  turn_boundary: "at the next turn boundary",
  run_boundary: "at the next run boundary",
};

const CONTINUITY_PHRASES: Readonly<Record<string, string>> = {
  in_place: "The running process carried the change; nothing was respawned and nothing replayed.",
  replayed: "The canonical transcript reached a fresh session.",
  memo: "The new provider is working from a summary rather than the conversation itself.",
};

const LOSS_PHRASES: Readonly<Record<string, string>> = {
  provider_private_reasoning: "the provider's private reasoning",
  context_truncated: "older exchanges, dropped whole",
  tool_call_history_repaired: "an unpaired tool call, repaired",
  conversation_history_summarized: "the conversation, summarized",
  turn_content_unavailable: "a turn whose text could not be read",
  turn_content_truncated: "a turn whose text was carried as a prefix",
};

const FAILURE_PHRASES: Readonly<Record<string, string>> = {
  driver_unavailable: "the driver was unavailable",
  model_unavailable: "the model was unavailable",
  effort_unavailable: "the effort level was unavailable",
  account_unavailable: "the account was unavailable",
  output_speed_unavailable: "the output speed was unavailable",
  interrupt_refused: "the interrupt was refused",
  target_unstartable: "the target could not be started",
};

/**
 * Read one settlement into the line a person sees.
 *
 * `agentLabel` is the caller's already-resolved name for the agent — this module
 * resolves no identity, because the roster is the only place a name lives.
 */
export function describeSwitchSettlement(
  settlement: AgentSwitchSettlement,
  agentLabel: string,
): SettlementRendering {
  const isKnownStatus = isKnownMember(SWITCH_STATUSES, settlement.status);
  return {
    tone: settlement.status === "failed" ? "caution" : "stated",
    isKnownStatus,
    headline: headlineFor(settlement, agentLabel),
    continuityClause: continuityClauseFor(settlement),
    lossClause: lossClauseFor(settlement),
    supersededSwitchId: settlement.replacedSwitchId,
  };
}

function headlineFor(settlement: AgentSwitchSettlement, agentLabel: string): string {
  if (settlement.status === "pending") {
    return `${agentLabel} switches ${boundaryPhrase(settlement.appliesAt)}.`;
  }
  if (settlement.status === "failed") {
    return `${agentLabel} did not switch and stayed on its current binding — ${failurePhrase(settlement.reason)}.`;
  }
  if (settlement.status === "applied" || settlement.status === "degraded") {
    return `${agentLabel} switched.`;
  }
  // An unrecognized status renders as itself rather than as one of the four. The
  // alternative is to guess which arm a later amendment belongs to, and a wrong
  // guess reads as a success for a switch that may not have happened.
  return `${agentLabel}: the daemon reported a switch state this console does not know, "${settlement.status}".`;
}

/**
 * The one place a resolved boundary becomes a phrase.
 *
 * Exported because the agent card renders the SAME boundary on its pending line
 * from the durable agent row rather than from a reply, and two mappings of one
 * closed vocabulary would eventually disagree about a member.
 */
export function boundaryPhrase(appliesAt: string | undefined): string {
  if (appliesAt === undefined) {
    return "at a boundary the reply did not name";
  }
  if (isKnownMember(SWITCH_BOUNDARIES, appliesAt)) {
    // Every member of the closed vocabulary has a phrase; the lookup cannot miss.
    return BOUNDARY_PHRASES[appliesAt] ?? appliesAt;
  }
  return `at "${appliesAt}"`;
}

function failurePhrase(reason: string | undefined): string {
  if (reason === undefined) {
    return "the reply named no reason";
  }
  if (isKnownMember(SWITCH_FAILURE_REASONS, reason)) {
    // Every member of the closed vocabulary has a phrase; the lookup cannot miss.
    return FAILURE_PHRASES[reason] ?? reason;
  }
  return `the daemon reported "${reason}"`;
}

function continuityClauseFor(settlement: AgentSwitchSettlement): string | undefined {
  const { continuity } = settlement;
  if (continuity === undefined) {
    return undefined;
  }
  if (isKnownMember(SWITCH_CONTINUITIES, continuity)) {
    return CONTINUITY_PHRASES[continuity] ?? continuity;
  }
  return `The daemon reported a continuity this console does not know, "${continuity}".`;
}

function lossClauseFor(settlement: AgentSwitchSettlement): string | undefined {
  const losses = settlement.declaredLosses;
  if (losses === undefined) {
    return undefined;
  }
  if (losses.length === 0) {
    return "Nothing was dropped.";
  }
  const named = losses.map((loss) => LOSS_PHRASES[loss] ?? `an unnamed loss, "${loss}"`);
  return `Dropped: ${named.join("; ")}.`;
}
