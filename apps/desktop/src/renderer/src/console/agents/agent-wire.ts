// The agent plane as this console NAMES it: the method strings it calls, the event
// kinds that refresh each read, and the closed vocabularies its renderers check a
// value against.
//
// WHERE THE REPLY SHAPES ARE, AND WHY THEY ARE NOT HERE
//
// `packages/contracts` registers the agent lifecycle EVENT TYPES (`agent.attached`,
// `agent.detached`, `agent.config_updated`) and every driver shape the two catalog
// reads answer with — `ListModelsResult`, `ListCapabilitiesResult`, `ProviderModel`,
// `DriverCapabilityFlag`, `ProviderOutputSpeedState`, `DeclaredLossKind`. What it does
// NOT register is the roster reply, the attach reply, the config-update settlement,
// or the child-run link read, and a module in a VIEW FAMILY is the wrong place to
// declare a wire shape: the growth port is what states that a wire is missing, who
// owes it, and what the console stands in with, and none of that machinery can see a
// declaration up here. So those shapes are `bridge/wire-shapes/agent-plane.ts` and this module
// consumes them like any other caller.
//
// WHAT STAYS. Three things a family genuinely owns. The METHOD STRINGS, because which
// call a surface makes is this family's decision. The EVENT KINDS each read refreshes
// on, because that is a refresh story rather than a payload. And the CLOSED
// VOCABULARIES, because they answer "is this a value I know how to render", which is a
// different question from "what may the wire carry" — the reply shapes deliberately
// type these members as `string`, so a later amendment's member renders as ITSELF
// rather than vanishing (`Spec-023 §Console Design (Meridian)` — a settlement never
// drops an unrecognized reason).

import type { SessionEventType } from "@ai-sidekicks/contracts";

// --- Method names ---------------------------------------------------------
//
// Named by `Spec-023 §Console Design (Meridian)`'s agent sections, which take them
// from their owning specs.
//
// ONLY THE TWO REGISTERED READS ARE NAMED HERE. The rest of the agent plane —
// `agent.list`, the three `agent.*` writes, `sidekick.definitionList`,
// `sidekick.peerInvocationSet`, and `orchestration.childRunLinkRead` — has no
// registered request/response pair anywhere in the corpus, so each is a growth
// operation rather than a call: the string lives on its ledger row's
// `expectedWireMethod` in `bridge/growth-operations/`, and a surface reaches it as
// `bridge.growth.<operation>(…)`. A constant here would be a second home for a
// string the ledger already owns, and the one that goes stale is the one no gate
// reads.

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

/**
 * The two registered kinds that move one parent run's child links.
 *
 * A child run reaches the session stream as `run.queued`, and a create the daemon
 * refused reaches it as `orchestration.rejected` — which is the ONLY record of
 * refused work, since a refusal is zero-residue and leaves no link row behind. Typed
 * as `SessionEventType` for the same reason as the roster's set: a kind this
 * workspace does not register is a compile error rather than a signal that never
 * fires.
 */
export const CHILD_RUN_LINKAGE_EVENT_KINDS: readonly SessionEventType[] = [
  "run.queued",
  "orchestration.rejected",
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
//
// The wire's own reply shapes are NOT here. They are `bridge/wire-shapes/agent-plane.ts`, beside
// the growth signatures that send and receive them — a module above the bridge
// cannot declare what a wire carries without putting that declaration where no gate
// looks. What stays here is the definition picker's reading, which is this family's
// own projection of a registry row the bridge already declares.

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
