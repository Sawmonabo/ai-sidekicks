// The agent reads as the renderer takes them: the roster read, the configuration update,
// and the child-run link read, declared here because no contracts module carries them yet.
//
// `packages/contracts` carries the agent lifecycle EVENT types and every driver catalog
// shape, and none of the reply shapes below. `agent-definition.ts` next door is the same
// kind of module for the same reason.
//
// TOLERANCE IS DELIBERATE AND BOUNDED. `appliesAt`, `continuity`, `status`, `reason`, and
// `state` are typed `string` rather than as the closed vocabulary each is checked against,
// because a later amendment's member must render as ITSELF rather than vanish: a settlement
// never drops an unrecognized reason. The vocabularies themselves are in
// `agent-vocabularies.ts`, beside the question of whether a value is one a renderer knows,
// which is a different question from what the wire may carry.
//
// EVERY FIELD THE RENDERER HAS NO GUARANTEE OF IS OPTIONAL, and every surface renders its
// absence rather than a blank. A roster reply that carries identity and lifecycle and no
// binding is a real answer, and the card says which half it got.

import type { ProviderOutputSpeedState } from "@ai-sidekicks/contracts";

/** The effective provider axis: what the agent runs under now, never the pending one. */
export interface AgentEffectiveBinding {
  /** Absent means the provider's registered default, never "unset". */
  readonly providerAccountId?: string | undefined;
  /** Absent means the driver's default for that model. */
  readonly effort?: string | undefined;
  /** Absent means never set. Never rendered as "off". */
  readonly outputSpeed?: string | undefined;
}

/** One moved axis and the value it is moving to. */
export interface AgentPendingAxis {
  readonly axis: string;
  readonly value: string;
}

/** A switch the daemon has accepted and not yet applied. Exactly one per agent. */
export interface AgentPendingSwitch {
  readonly switchId: string;
  /** `turn_boundary` or `run_boundary`, resolved by the daemon against the driver. */
  readonly appliesAt: string;
  /** Never re-derived from `appliesAt`: a deferred and an interrupted switch agree. */
  readonly interruptRequested: boolean;
  readonly pendingAxes: readonly AgentPendingAxis[];
  /** Present where this intent displaced an earlier one. The only record of it. */
  readonly replacedSwitchId?: string | undefined;
}

/**
 * The configuration the agent resolved to when it joined the session, echoed back.
 *
 * The four snapshot axes are stamped on the agent row when it joins and are fixed for
 * its life — `agent.configUpdate` carries no member for any of them — so this echo
 * and the `agent.attached` payload are the only reads. The registry row behind a
 * definition may already have moved, which is why re-reading it would be wrong.
 */
export interface AgentResolvedConfiguration {
  readonly driverName?: string | undefined;
  readonly modelId?: string | undefined;
  readonly providerAccountId?: string | undefined;
  readonly effort?: string | undefined;
  readonly instructions?: string | undefined;
  readonly goal?: string | undefined;
  readonly toolAllowlist?: readonly string[] | undefined;
  readonly executionPostureMode?: string | undefined;
}

/** One row of the roster read. */
export interface AgentRosterEntry {
  readonly agentId: string;
  readonly name?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly driverName?: string | undefined;
  readonly modelId?: string | undefined;
  readonly config?: AgentEffectiveBinding | undefined;
  /**
   * The mode the provider DECLARED, beside the one that was requested.
   *
   * Never folded into `config.outputSpeed` and never substituted for it. Absence
   * has three causes and none of them is "the mode is off".
   */
  readonly observedOutputSpeed?: ProviderOutputSpeedState | undefined;
  readonly pendingSwitch?: AgentPendingSwitch | undefined;
  readonly resolvedFromDefinitionId?: string | undefined;
  readonly resolvedConfiguration?: AgentResolvedConfiguration | undefined;
}

export interface AgentRosterReading {
  readonly agents: readonly AgentRosterEntry[];
}

/** The `switch` member on a config-update reply. Absent on a pure rename or rebind. */
export interface AgentSwitchSettlement {
  /** One of {@link SWITCH_STATUSES}. The discriminator; `degraded` is never re-derived. */
  readonly status: string;
  readonly switchId?: string | undefined;
  readonly appliesAt?: string | undefined;
  /** The contract's `AgentBindingContinuity` on a settled switch. */
  readonly continuity?: string | undefined;
  /** An EMPTY array asserts nothing was dropped. Absent asserts nothing at all. */
  readonly declaredLosses?: readonly string[] | undefined;
  /** One of the contract's `AGENT_BINDING_CHANGE_FAILURE_REASONS` on the failed arm. */
  readonly reason?: string | undefined;
  readonly replacedSwitchId?: string | undefined;
}

/**
 * What a configuration update answers.
 *
 * @consumedBy the running agent's model, effort, speed and provider switch
 */
export interface AgentConfigUpdateReading {
  readonly switch?: AgentSwitchSettlement | undefined;
}

/** One parent-to-child link. */
export interface ChildRunLink {
  readonly childRunId: string;
  /** De-emphasized and never ejected: helper rows stay in audit history. */
  readonly internalHelper: boolean;
  readonly state?: string | undefined;
  readonly createdAt?: string | undefined;
}

/**
 * One refusal, folded from an `orchestration.rejected` event.
 *
 * A refusal is zero-residue — no run, no queue entry, no link row — so this fold is
 * the only path by which work that was asked for and denied is visible at all.
 */
export interface ChildRunRejection {
  readonly reason: string;
  readonly detail?: string | undefined;
  readonly occurredAt?: string | undefined;
  readonly targetAgentId?: string | undefined;
  readonly parentRunId?: string | undefined;
  /** Carried by the depth refusal. Rendered from the payload, never from a constant. */
  readonly maxDepth?: number | undefined;
}

export interface ChildRunLinkReading {
  readonly links: readonly ChildRunLink[];
  readonly rejectedCreates: readonly ChildRunRejection[];
}

/**
 * What a configuration update sends: the agent, the axes moved, and the boundary.
 *
 * `interruptAndSwitch` is a separate axis from the values because it decides WHEN a
 * switch lands rather than what it lands on, and folding it into the axis map would
 * make "interrupt" look like a sixth provider axis a driver could refuse.
 *
 * @consumedBy the running agent's model, effort, speed and provider switch
 */
export interface AgentConfigUpdateRequest {
  readonly agentId: string;
  readonly interruptAndSwitch: boolean;
  readonly driverName?: string | undefined;
  readonly providerAccountId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly effort?: string | undefined;
  readonly outputSpeed?: string | undefined;
}

/**
 * What one parent run's link read asks for.
 *
 * @consumedBy the child-run tree's link read
 */
export interface ChildRunLinkReadRequest {
  readonly parentRunId: string;
}

/**
 * What the roster read asks for.
 *
 * @consumedBy the agents pane's roster read
 */
export interface AgentListRequest {
  readonly sessionId: string;
}
