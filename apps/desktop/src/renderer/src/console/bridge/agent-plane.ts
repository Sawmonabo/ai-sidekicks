// The agent plane as this console READS it: the reply shapes behind the four
// `agent.*` verbs, the child-run link read, and the per-session peer-invocation
// grant — declared here because no code package carries them.
//
// `Spec-016 §Interfaces And Contracts` and `Spec-030 §Interfaces And Contracts`
// register these operations and `api-payload-contracts.md` registers their payloads;
// `packages/contracts` carries the agent lifecycle EVENT types and every driver
// catalog shape, and none of the reply shapes below. A console that declared them
// inside a view family would be putting a wire shape where no gate can see it, which
// is what the growth slate exists to prevent — so they are declared here, on the
// substrate, behind the `agent-snapshot-axes` and `child-run-linkage` slate rows, and
// every call to them goes through the growth port.
//
// This is `sidekick-definition.ts`'s shape next door, for the same reason and with
// the same obligation.
//
// DELETION OBLIGATION. When `packages/contracts` registers these types, this module
// is DELETED and the `growth-signatures/` planes that name these shapes — the agent
// plane and the sidekick one — import them from the contracts package instead. The slate rows leave `growth-slate.ts` and `Plan-023 §Console growth
// slate` in the same PR, and `failure-modes.test.ts` then fails on the port entries
// that still claim fixture-only.
//
// TOLERANCE IS DELIBERATE AND BOUNDED. `appliesAt`, `continuity`, `status`,
// `reason`, `linkType`, and `state` are typed `string` rather than as the closed
// vocabulary each is checked against, because a later amendment's member must render
// as ITSELF rather than vanish (`Spec-023 §Console Design (Meridian)` — a settlement
// never drops an unrecognized reason). The vocabularies themselves stay in
// `agents/agent-wire.ts`, beside the renderers that ask whether a value is one they
// know — which is a different question from what the wire may carry.
//
// EVERY FIELD THE CONSOLE HAS NO GUARANTEE OF IS OPTIONAL, and every surface renders
// its absence rather than a blank. A roster reply that carries identity and lifecycle
// and no binding is a real answer, and the card says which half it got.

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
 * The configuration an attach resolved to, echoed back.
 *
 * The four snapshot axes are stamped on the agent row at attach and are fixed for
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
  /** One of {@link AGENT_STATES}; rendered verbatim when it is not. */
  readonly state?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly defaultNodeId?: string | undefined;
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
  /** One of {@link SWITCH_CONTINUITIES} on a settled switch. */
  readonly continuity?: string | undefined;
  /** An EMPTY array asserts nothing was dropped. Absent asserts nothing at all. */
  readonly declaredLosses?: readonly string[] | undefined;
  /** One of {@link SWITCH_FAILURE_REASONS} on the failed arm. */
  readonly reason?: string | undefined;
  readonly replacedSwitchId?: string | undefined;
}

export interface AgentConfigUpdateReading {
  readonly switch?: AgentSwitchSettlement | undefined;
}

export interface AgentAttachReading {
  readonly agentId: string;
  readonly resolvedConfiguration?: AgentResolvedConfiguration | undefined;
  readonly resolvedFromDefinitionId?: string | undefined;
}

/** One parent-to-child link. */
export interface ChildRunLink {
  readonly childRunId: string;
  /** One of {@link CHILD_RUN_LINK_TYPES}. */
  readonly linkType: string;
  /** De-emphasized and never ejected: helper rows stay in audit history. */
  readonly internalHelper: boolean;
  readonly producingNodeId?: string | undefined;
  /** One of {@link CHILD_RUN_VISIBILITIES}. Daemon-projected. */
  readonly visibility: string;
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
  readonly targetChannelId?: string | undefined;
  readonly targetAgentId?: string | undefined;
  readonly parentRunId?: string | undefined;
  /** Carried by the depth refusal. Rendered from the payload, never from a constant. */
  readonly maxDepth?: number | undefined;
}

export interface ChildRunLinkReading {
  readonly links: readonly ChildRunLink[];
  readonly rejectedCreates: readonly ChildRunRejection[];
}

/** The projected session-scoped grant. Absent is a third state, never `false`. */
export interface PeerInvocationReading {
  readonly enabled: boolean;
}

/**
 * What an attach sends: a definition reference, an inline configuration, or both.
 *
 * Every axis is optional because the registered request is a two-arm union — a
 * definition-only attach parses — and an explicitly-present member merges per field
 * over the definition it names. Requiring any one of them here would refuse an arm
 * the wire admits.
 *
 * DERIVED FROM THE ECHO RATHER THAN RESTATED. The configuration half of this request
 * is what {@link AgentResolvedConfiguration} describes — the same eight axes, which
 * is not a coincidence but the contract: what an attach may SEND is exactly what an
 * attach RESOLVES TO, and the daemon echoes the resolution back on the same seam.
 * Written out a second time, the two drifted the first time an axis landed on one
 * and not the other, and the compiler had nothing to say about it. What is stated
 * here is only the part that is NOT configuration: which session the agent joins,
 * which definition it resolves through, and what it is called.
 */
export type AgentAttachRequest = {
  readonly sessionId: string;
  readonly definitionId?: string | undefined;
  readonly name?: string | undefined;
} & AgentResolvedConfiguration;

/**
 * What a configuration update sends: the agent, the axes moved, and the boundary.
 *
 * `interruptAndSwitch` is a separate axis from the values because it decides WHEN a
 * switch lands rather than what it lands on, and folding it into the axis map would
 * make "interrupt" look like a sixth provider axis a driver could refuse.
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

/** What a detach sends. The agent moves to `disabled`; re-attaching reverses it. */
export interface AgentDetachRequest {
  readonly agentId: string;
}

/** What one parent run's link read asks for. */
export interface ChildRunLinkReadRequest {
  readonly parentRunId: string;
}

/** What the roster read asks for. */
export interface AgentListRequest {
  readonly sessionId: string;
}

/** What the peer-invocation grant sets, and for which session. */
export interface PeerInvocationSetRequest {
  readonly sessionId: string;
  readonly enabled: boolean;
}
