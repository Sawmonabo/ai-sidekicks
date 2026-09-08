// The cast the agents scenario runs: two sidekicks, two drivers, two accounts.
//
// Split out of `agents.ts` because a scenario and its cast are two subjects: that
// module says what happens and in what order, and this says who it happens to. The
// tables here are read from both sides of every record — `agent.attached` and the
// `agent.list` entry are two views of one row, and two hand-written copies drift
// where nothing catches it.
//
// THE DRIVERS ARE DELIBERATELY MIXED. A fixture whose whole cast runs one provider
// cannot show an axis control what a two-provider session looks like.

import {
  DRIVER_CAPABILITY_FLAGS,
  ParticipantIdSchema,
  SessionIdSchema,
  type DeclaredLossKind,
  type DriverCapabilityFlag,
  type ParticipantId,
  type SessionId,
} from "@ai-sidekicks/contracts";

import type { AgentSwitchSettlement } from "../wire-shapes/agent-plane.js";

// Wire identifiers, spelled as the wire spells them — UUID v7 values whose leading
// bytes are this scenario's own start instant, so a rendered id still tells one
// fixture apart from another.
//
// MINTED THROUGH THE REGISTERED SCHEMAS RATHER THAN `as`-CAST. A scenario constant is
// where a fixture chooses the bytes, and a cast asserts a brand without checking it —
// so a malformed id surfaced at the first `.strict()` reply that carried it, which
// takes the whole reply down and names the reply rather than the value. Parsing at
// declaration fails the module instead, naming the constant. `AGENT_*` stays
// unbranded: the corpus registers no `AgentId` brand to mint one through.
export const SESSION_ID: SessionId = SessionIdSchema.parse("019b7952-5ec0-75e5-8510-ada11a5a44a5");
export const PARTICIPANT_YOU: ParticipantId = ParticipantIdSchema.parse(
  "019b7952-5ec0-79a4-8110-cca0117a0440",
);
export const AGENT_ARCHITECT = "019b7952-5ec0-7a6e-8110-d1a4c1150041";
export const AGENT_IMPLEMENTER = "019b7952-5ec0-7a6e-8120-d1a4c1150042";
export const PENDING_SWITCH_ID = "019b7952-5ec0-7b90-8110-d1a4c1150051";
export const SUPERSEDED_SWITCH_ID = "019b7952-5ec0-7b90-8120-d1a4c1150052";
export const APPLIED_SWITCH_ID = "019b7952-5ec0-7b90-8130-d1a4c1150053";
export const PROVIDER_ACCOUNT_WORK = "019b7952-5ec0-7d40-8110-d1a4c1150061";
export const PROVIDER_ACCOUNT_PERSONAL = "019b7952-5ec0-7d40-8120-d1a4c1150062";

/**
 * One driver's capability declaration, with every registered flag stated.
 *
 * Built from `DRIVER_CAPABILITY_FLAGS` rather than hand-listed, because
 * `DriverCapabilities.flags` is a TOTAL record over that tuple: a hand-written
 * literal would go stale the day the contract registers an eighteenth flag, and a
 * PARTIAL one would read as "the driver did not declare this" for every flag it
 * forgot — which is a different answer from `false` and the one
 * `agents/driver-catalog.ts` deliberately distinguishes.
 */
export function declaredFlags(
  enabled: readonly DriverCapabilityFlag[],
): Record<DriverCapabilityFlag, boolean> {
  const flags = {} as Record<DriverCapabilityFlag, boolean>;
  for (const flag of DRIVER_CAPABILITY_FLAGS) {
    flags[flag] = enabled.includes(flag);
  }
  return flags;
}

/** What the pinned Claude build declares. Notably no `output_speed`-less arm here. */
export const CLAUDE_FLAGS: readonly DriverCapabilityFlag[] = [
  "resume",
  "steer",
  "interactive_requests",
  "mcp",
  "tool_calls",
  "reasoning_stream",
  "model_mutation",
  "rollback",
  "session_goals",
  "callback_tools",
  "subagents",
  "cost_cap",
  "context_compaction",
  "provider_commands",
  "output_speed",
];

/**
 * What the pinned Codex build declares.
 *
 * `output_speed` is absent, and its absence is the case the axis control exists to
 * handle: the control is ABSENT rather than disabled for this driver, because a
 * disabled control asserts a capability exists and is momentarily unavailable, which
 * would be false.
 */
export const CODEX_FLAGS: readonly DriverCapabilityFlag[] = [
  "resume",
  "steer",
  "interactive_requests",
  "mcp",
  "tool_calls",
  "reasoning_stream",
  "model_mutation",
  "structured_output",
  "session_goals",
  "callback_tools",
  "subagents",
  "transcript_replay",
  "cost_cap",
  "context_compaction",
  "provider_commands",
];

/** One attached sidekick, as both the event and the roster entry read it. */
export interface AttachedAgent {
  readonly agentId: string;
  readonly eventId: string;
  readonly name: string;
  readonly driverName: string;
  readonly modelId: string;
  readonly effort: string;
  /** The declared level, or absent where the driver declares no speed axis at all. */
  readonly outputSpeed?: string | undefined;
  readonly providerAccountId: string;
  readonly attachedAtMs: number;
  readonly attachedAtIso: string;
}

/**
 * The two attached agents, as every view of them reads.
 *
 * One table rather than a literal per beat and a second per roster row, on
 * `flagship.ts`'s rule: `agent.attached` and the `agent.list` entry are two views of
 * one record, and two hand-written copies drift where nothing catches it. The
 * drivers are deliberately mixed — a fixture whose whole cast runs one provider
 * cannot show an axis control what a two-provider session looks like.
 */
export const ATTACHED_AGENTS: readonly [AttachedAgent, AttachedAgent] = [
  {
    agentId: AGENT_ARCHITECT,
    eventId: "019b7952-5ec0-7ea1-8120-e5e0d1150442",
    name: "Architect",
    driverName: "claude",
    modelId: "claude-opus-5[1m]",
    effort: "high",
    outputSpeed: "standard",
    providerAccountId: PROVIDER_ACCOUNT_WORK,
    attachedAtMs: 80,
    attachedAtIso: "2026-01-01T11:30:00.080Z",
  },
  {
    agentId: AGENT_IMPLEMENTER,
    eventId: "019b7952-5ec0-7ea1-8130-e5e0d1150443",
    name: "Implementer",
    driverName: "codex",
    modelId: "gpt-5.6-sol",
    effort: "medium",
    outputSpeed: undefined,
    providerAccountId: PROVIDER_ACCOUNT_PERSONAL,
    attachedAtMs: 140,
    attachedAtIso: "2026-01-01T11:30:00.140Z",
  },
];

/**
 * The settlement the scripted `agent.configUpdate` reply answers with.
 *
 * HERE RATHER THAN INLINE ON THAT REPLY, because it now has two readers: the
 * scenario answers with it, and the screenshot tier's settlement route renders the
 * line from it directly rather than driving a submit and a clock. A second literal
 * would be a second answer to what a settled switch looks like, and the picture
 * would stop being of the settlement the fixture serves.
 *
 * `continuity` is `replayed`, which is what makes a non-empty loss list possible at
 * all: an `in_place` carry drops nothing and a `memo` settlement drops the
 * transcript wholesale. The two losses are causally ordered rather than merely both
 * legal — stripping private reasoning orphans the tool calls that referenced it, and
 * the pairing repair that follows mints a synthetic result for each — and
 * `satisfies` holds them to the registered vocabulary, without which the renderer
 * built for the declared-loss path would be shown a response no daemon may emit.
 */
export const APPLIED_SWITCH_SETTLEMENT: AgentSwitchSettlement = {
  status: "applied",
  switchId: APPLIED_SWITCH_ID,
  appliesAt: "turn_boundary",
  continuity: "replayed",
  declaredLosses: [
    "provider_private_reasoning",
    "tool_call_history_repaired",
  ] satisfies readonly DeclaredLossKind[],
};
