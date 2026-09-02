// The agent plane as this console READS it: the method names it calls, the closed
// vocabularies it renders, and the shape it expects each reply to have.
//
// WHY THE SHAPES ARE DECLARED HERE AND NOT IMPORTED
//
// `packages/contracts` registers the agent lifecycle EVENT TYPES (`agent.attached`,
// `agent.detached`, `agent.config_updated`) and every driver shape the two catalog
// reads answer with — `ListModelsResult`, `ListCapabilitiesResult`, `ProviderModel`,
// `DriverCapabilityFlag`, `ProviderOutputSpeedState`, `DeclaredLossKind`. Those are
// imported, never restated. What it does NOT register is the agent roster reply, the
// attach reply, the config-update reply's settlement member, the sidekick definition
// list, or the child-run link read. Those reach the console today only through the
// scenario fixture, and the console's growth slate carries one row against them
// (`agent-snapshot-axes`, owned by Spec-030 and Spec-016).
//
// So the reading types below are the CONSOLE's, on `bridge/growth-port.ts`'s stated
// precedent: they are derived from what these surfaces need and are not a claim
// about the eventual wire shape, which belongs to the owning document. Every field
// the console has no guarantee of is optional and every surface renders its absence
// rather than a blank — a roster reply that carries identity and lifecycle and no
// binding is a real answer, and the card says which half it got.
//
// TOLERANCE IS DELIBERATE AND BOUNDED. `appliesAt`, `continuity`, `status`, `reason`,
// `linkType`, and `state` are typed `string` beside the closed vocabulary they are
// checked against, because a later amendment's member must render as ITSELF rather
// than vanish (`Spec-023 §Console Design (Meridian)` — a settlement never drops an
// unrecognized reason). The vocabularies are exported so a renderer can say whether
// a value is one it knows, which is a different question from whether to show it.

import type { ProviderOutputSpeedState, SessionEventType } from "@ai-sidekicks/contracts";

// --- Method names ---------------------------------------------------------
//
// Named by `Spec-023 §Console Design (Meridian)`'s agent sections, which take them
// from their owning specs. The two `driver.*` reads are registered daemon methods
// today; the rest are answered by the scenario fixture and refuse under the live
// bridge, which is the state the surfaces render.

/** The roster read. Answers every agent attached to one session. */
export const AGENT_LIST_METHOD = "agent.list";
/** Put a configured sidekick into a session, by definition or inline. */
export const AGENT_ATTACH_METHOD = "agent.attach";
/** Move a running agent's provider axes. Never a second run control. */
export const AGENT_CONFIG_UPDATE_METHOD = "agent.configUpdate";
/** Move an agent to `disabled`. Reversible by re-attaching. */
export const AGENT_DETACH_METHOD = "agent.detach";
/** The definition picker's read. */
export const SIDEKICK_DEFINITION_LIST_METHOD = "sidekick.definitionList";
/** The session-scoped peer-invocation grant. */
export const SIDEKICK_PEER_INVOCATION_SET_METHOD = "sidekick.peerInvocationSet";
/** Parent-to-child links plus the refusal fold. */
export const CHILD_RUN_LINK_READ_METHOD = "orchestration.childRunLinkRead";
/** The per-driver model catalog, and with it every model's effort vocabulary. */
export const DRIVER_LIST_MODELS_METHOD = "driver.listModels";
/** The per-driver capability flags, and with them the output-speed vocabulary. */
export const DRIVER_LIST_CAPABILITIES_METHOD = "driver.listCapabilities";

/**
 * The three registered lifecycle events that change a roster.
 *
 * Typed as `SessionEventType` so a kind this workspace does not register is a
 * compile error rather than a signal that never fires. The switch terminals
 * (`agent.provider_switched`, `agent.provider_switch_failed`) are deliberately
 * absent: they are not registered, so no store admits them and no signal can
 * carry them.
 */
export const AGENT_LIFECYCLE_EVENT_KINDS: readonly SessionEventType[] = [
  "agent.attached",
  "agent.detached",
  "agent.config_updated",
];

// --- Closed vocabularies --------------------------------------------------

/** An agent's lifecycle state, closed at four (`Spec-016 §Interfaces And Contracts`). */
export const AGENT_STATES = ["configured", "ready", "disabled", "archived"] as const;

/** The five axes one `agent.configUpdate` may move. */
export const PROVIDER_AXES = [
  "driverName",
  "providerAccountId",
  "modelId",
  "effort",
  "outputSpeed",
] as const;
export type ProviderAxis = (typeof PROVIDER_AXES)[number];

/** Where a switch lands. Quoted from the reply, never predicted from the axis names. */
export const SWITCH_BOUNDARIES = ["turn_boundary", "run_boundary"] as const;

/** The settlement's four arms. Its presence on a reply is the switch discriminator. */
export const SWITCH_STATUSES = ["pending", "applied", "degraded", "failed"] as const;

/** What the new binding can see. `degraded` is exactly `memo`; the status carries it. */
export const SWITCH_CONTINUITIES = ["in_place", "replayed", "memo"] as const;

/** One vocabulary across the held-open reply and the terminal event. */
export const SWITCH_FAILURE_REASONS = [
  "driver_unavailable",
  "model_unavailable",
  "effort_unavailable",
  "account_unavailable",
  "output_speed_unavailable",
  "interrupt_refused",
  "target_unstartable",
] as const;

/** Three distinguishable relationships, never one word. */
export const CHILD_RUN_LINK_TYPES = ["spawn", "delegate", "handoff"] as const;
export type ChildRunLinkType = (typeof CHILD_RUN_LINK_TYPES)[number];

/** Daemon-projected from node liveness. Never inferred here. */
export const CHILD_RUN_VISIBILITIES = ["reachable", "unreachable"] as const;

/**
 * The two peer-invocation tools, with the link type each produces.
 *
 * Both are registered at spawn unconditionally and every call is adjudicated
 * per invocation, so this list is shown regardless of the session's enablement
 * state — filtering it by that state would describe a registry that does not
 * exist (`Spec-030 §Required Behavior`).
 */
export const PEER_INVOCATION_TOOLS: readonly {
  readonly toolName: string;
  readonly linkType: ChildRunLinkType;
}[] = [
  { toolName: "ask_sidekick", linkType: "spawn" },
  { toolName: "delegate_to_sidekick", linkType: "delegate" },
];

/** Whether a value is one of a closed vocabulary this console knows. */
export function isKnownMember(vocabulary: readonly string[], value: string): boolean {
  return vocabulary.includes(value);
}

// --- Reading shapes -------------------------------------------------------

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

/** One row of the definition picker's read. */
export interface SidekickDefinitionSummary {
  readonly definitionId: string;
  readonly name?: string | undefined;
  readonly driverName?: string | undefined;
  readonly modelId?: string | undefined;
  readonly providerAccountId?: string | undefined;
  readonly effort?: string | undefined;
  readonly instructions?: string | undefined;
  readonly goal?: string | undefined;
  readonly toolAllowlist?: readonly string[] | undefined;
  readonly executionPostureMode?: string | undefined;
}

export interface SidekickDefinitionListReading {
  readonly definitions: readonly SidekickDefinitionSummary[];
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
