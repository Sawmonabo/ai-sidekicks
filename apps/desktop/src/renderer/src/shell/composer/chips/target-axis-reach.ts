// Whether this composer may move the addressed agent's provider axes, and on what.
//
// THE DECISION IS HERE RATHER THAN IN THE CHIP because it is a decision, not a
// layout: three states with three different sentences, and a component branching on
// them inline would be the one place the order of the checks is written down. The
// order is the whole of it — reachability is settled BEFORE the roster is consulted,
// so a build that carries no way to move an axis says so whether or not it ever read
// the agent, and a control is never drawn against an operation nothing serves.
//
// THAT IS FAIL-CLOSED AND NOT DEFENSIVE. `Spec-023 §Console Design (Meridian)` rule 8
// forbids a control that could silently do nothing: the growth port is the console's
// seam for a wire it does not have, and an operation absent from the port is a press
// that reaches no call at all rather than one the daemon refuses. The two are
// different facts and the second one is renderable — the mutation's own refusal — so
// only the first is settled here.
//
// AND THE ROSTER ROW IS THE SECOND CONJUNCT, because the form the popover mounts is a
// difference FROM a binding. Without the row there is no binding to differ from, and
// an axis surface composed over an absent one would be offering the participant a
// change to values nobody has read.

import type {
  AgentRosterEntry,
  AgentSwitchSettlement,
  ConsoleBridge,
} from "../../../console/bridge/index.js";
import type {
  AgentBindingSwitchHolder,
  DriverCatalogHolder,
} from "../../../console/agents/index.js";

/**
 * Everything the axis popover's body needs, gathered by the rail that armed it.
 *
 * The two holders are handed over whole rather than unpacked into six members: they
 * are the agents family's own composition of one read and one latch, and a chip
 * spreading them would be a second statement of which halves belong together.
 */
export interface TargetAxisControl {
  /** The roster row, wire-verbatim. The binding the form is a difference from. */
  readonly agent: AgentRosterEntry;
  readonly catalog: DriverCatalogHolder;
  readonly switching: AgentBindingSwitchHolder;
}

/**
 * What the chip may say about changing this agent's axes.
 *
 * A closed three-arm union rather than an optional control beside a boolean: "no
 * control because this build cannot" and "no control because nothing has been read
 * yet" are different sentences a person is owed, and two optional members would make
 * "both" and "neither" representable with nothing able to answer them.
 */
export type TargetAxisReach =
  | { readonly reach: "unreachable" }
  | { readonly reach: "agent-not-read" }
  | { readonly reach: "offered"; readonly control: TargetAxisControl };

/**
 * Does this build carry the operation the popover dispatches?
 *
 * Asked of the PORT and not of the slate. A slate row says the corpus registers the
 * wire; what decides whether a press reaches a call is whether this bridge's growth
 * port has a method to call, which a live bridge answers as a typed refusal and a
 * build assembled without the operation answers not at all.
 */
function carriesAxisMutation(bridge: ConsoleBridge): boolean {
  return typeof bridge.growth.agentConfigUpdate === "function";
}

/** Settle what the chip may offer, in the order the header states. */
export function resolveTargetAxisReach(
  bridge: ConsoleBridge,
  agent: AgentRosterEntry | undefined,
  catalog: DriverCatalogHolder,
  switching: AgentBindingSwitchHolder,
): TargetAxisReach {
  if (!carriesAxisMutation(bridge)) {
    return { reach: "unreachable" };
  }
  if (agent === undefined) {
    return { reach: "agent-not-read" };
  }
  return { reach: "offered", control: { agent, catalog, switching } };
}

/**
 * The settlement that says the switch did NOT happen, or nothing.
 *
 * The IMMEDIATE arm of a failed switch — `agent.configUpdate`'s own response
 * disposition — and the only one this console can reach. The deferred arm rides
 * `agent.provider_switch_failed`, which `packages/contracts`' event union does not
 * register, so no fold can carry it and the growth slate holds the debt.
 *
 * `status` is the wire's discriminator and is never re-derived: a reply carrying a
 * reason on a non-failed arm is a reply about something else.
 */
export function failedSwitchOf(
  axes: TargetAxisReach | undefined,
): AgentSwitchSettlement | undefined {
  if (axes === undefined || axes.reach !== "offered") {
    return undefined;
  }
  const settlement = axes.control.switching.settlement;
  return settlement !== undefined && settlement.status === "failed" ? settlement : undefined;
}
