// The agent plane as this console NAMES it: the method strings it calls, the event
// kinds that refresh each read, and the closed vocabularies its renderers check a
// value against.
//
// WHERE THE REPLY SHAPES ARE, AND WHY THEY ARE NOT HERE
//
// `packages/contracts` registers the `agent.config_updated` event type and every
// driver shape the two catalog reads answer with — `ListModelsResult`,
// `ListCapabilitiesResult`, `ProviderModel`, `DriverCapabilityFlag`,
// `ProviderOutputSpeedState`, `DeclaredLossKind`. What it does NOT register is the
// roster reply, the config-update settlement, or the child-run link read, and a module
// in a VIEW FAMILY is the wrong place to declare a wire shape. So those shapes are
// `bridge/wire-shapes/agent-plane.ts` and this module consumes them like any other
// caller.
//
// WHAT STAYS. Three things a family genuinely owns. The METHOD STRINGS, because which
// call a surface makes is this family's decision. The EVENT KINDS each read refreshes
// on, because that is a refresh story rather than a payload. And the CLOSED
// VOCABULARIES, because they answer "is this a value I know how to render", which is a
// different question from "what may the wire carry" — the reply shapes deliberately
// type these members as `string`, so a later amendment's member renders as ITSELF
// rather than vanishing: a settlement never drops an unrecognized reason.

import type { SessionEventType } from "@ai-sidekicks/contracts";

// --- Method names ---------------------------------------------------------
//
// ONLY THE TWO REGISTERED READS ARE NAMED HERE. The rest of the agent plane has no
// registered request/response pair, so no method string for it lives here: a constant
// would name a call nothing serves.

/** The per-driver model catalog, and with it every model's effort vocabulary. */
export const DRIVER_LIST_MODELS_METHOD = "driver.listModels";
/** The per-driver capability flags, and with them the output-speed vocabulary. */
export const DRIVER_LIST_CAPABILITIES_METHOD = "driver.listCapabilities";

/**
 * The registered lifecycle event that changes a roster.
 *
 * Typed as `SessionEventType` so a kind this workspace does not register is a
 * compile error rather than a signal that never fires. The switch terminals
 * (`agent.provider_switched`, `agent.provider_switch_failed`) are deliberately
 * absent: they are not registered, so no store admits them and no signal can
 * carry them.
 */
export const AGENT_LIFECYCLE_EVENT_KINDS: readonly SessionEventType[] = ["agent.config_updated"];

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

/** The five axes one `agent.configUpdate` may move. */
export const PROVIDER_AXES = [
  "driverName",
  "providerAccountId",
  "modelId",
  "effort",
  "outputSpeed",
] as const;
export type ProviderAxis = (typeof PROVIDER_AXES)[number];

/**
 * Where a switch lands. Quoted from the reply, never predicted from the axis names.
 *
 * @consumedBy the agent switch, which reads where a switch lands and how it settled
 */
export const SWITCH_BOUNDARIES = ["turn_boundary", "run_boundary"] as const;

/**
 * The settlement's four arms. Its presence on a reply is the switch discriminator.
 *
 * @consumedBy the agent switch, which reads where a switch lands and how it settled
 */
export const SWITCH_STATUSES = ["pending", "applied", "degraded", "failed"] as const;

/**
 * What the new binding can see. `degraded` is exactly `memo`; the status carries it.
 *
 * @consumedBy the agent switch, which reads where a switch lands and how it settled
 */
export const SWITCH_CONTINUITIES = ["in_place", "replayed", "memo"] as const;
