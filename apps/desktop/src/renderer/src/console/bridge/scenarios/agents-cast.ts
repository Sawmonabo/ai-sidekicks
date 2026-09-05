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

import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

// Wire identifiers, spelled as the wire spells them — UUID v7 values whose leading
// bytes are this scenario's own start instant, so a rendered id still tells one
// fixture apart from another.
export const SESSION_ID = "019b7952-5ec0-75e5-8510-ada11a5a44a5";
export const PARTICIPANT_YOU = "019b7952-5ec0-79a4-8110-cca0117a0440";
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

/**
 * The two attached agents, as every view of them reads.
 *
 * One table rather than a literal per beat and a second per roster row, on
 * `flagship.ts`'s rule: `agent.attached` and the `agent.list` entry are two views of
 * one record, and two hand-written copies drift where nothing catches it. The
 * drivers are deliberately mixed — a fixture whose whole cast runs one provider
 * cannot show an axis control what a two-provider session looks like.
 */
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
