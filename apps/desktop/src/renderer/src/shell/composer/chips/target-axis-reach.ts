// Whether this composer may move the addressed agent's provider axes, and on what.
//
// THE DECISION IS HERE RATHER THAN IN THE CHIP because it is a decision, not a
// layout: six states with six different sentences, and a component branching on
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
//
// WHICH IS WHY THE WHOLE READING COMES IN AND NOT JUST ITS ROW. The row is absent in
// four different situations and they are four different sentences: nobody asked, the
// read is travelling, the read refused, and the roster served and holds no such agent.
// This resolver took the row alone, so all four reached one arm whose sentence — "this
// agent's roster row has not been read" — is false for three of them and drops the
// daemon's own reason for one. `PayingAccount.tsx`, one file over, renders the same
// four correctly; the phase is what tells them apart and it rides the reading.

import type {
  AgentBindingSwitchHolder,
  DriverCatalogHolder,
} from "../../../console/agents/index.js";
import type { AgentRosterEntry, AgentSwitchSettlement } from "../../../console/bridge/index.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import type { ConsoleRefusal } from "../../../console/core/index.js";
import type { AgentBindingReading } from "./agent-binding-read.js";

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
 * A closed union rather than an optional control beside a boolean: each arm is a
 * different sentence a person is owed, and optional members would make combinations
 * representable that nothing could answer. The four middle arms are the roster
 * reading's own phases, which is what keeps this vocabulary from drifting from the
 * reading it is derived from — a fifth phase there is a compile error here.
 */
export type TargetAxisReach =
  /** This build carries no operation that moves an axis, whatever the roster says. */
  | { readonly reach: "unreachable" }
  /** Nobody has asked the daemon what this agent is bound to. */
  | { readonly reach: "not-checked" }
  /** The roster read is travelling. */
  | { readonly reach: "loading" }
  /** The roster read refused, with the reason it carried where it carried one. */
  | { readonly reach: "refused"; readonly refusal: ConsoleRefusal | undefined }
  /** The roster served and this session holds no such agent. */
  | { readonly reach: "no-such-agent" }
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
  binding: AgentBindingReading,
  catalog: DriverCatalogHolder,
  switching: AgentBindingSwitchHolder,
): TargetAxisReach {
  if (!carriesAxisMutation(bridge)) {
    return { reach: "unreachable" };
  }
  if (binding.phase === "refused") {
    return { reach: "refused", refusal: binding.refusal };
  }
  if (binding.phase === "not-checked") {
    return { reach: "not-checked" };
  }
  if (binding.phase === "loading") {
    return { reach: "loading" };
  }
  // The roster served. A row is present exactly where it named this agent, and its
  // absence here is the one remaining fact: this session holds no such agent.
  return binding.agent === undefined
    ? { reach: "no-such-agent" }
    : { reach: "offered", control: { agent: binding.agent, catalog, switching } };
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
  const settlement = axes.control.switching.settled?.settlement;
  return settlement !== undefined && settlement.status === "failed" ? settlement : undefined;
}

/**
 * Why the axis mutation this window issued did not happen, or nothing.
 *
 * A SIBLING OF {@link failedSwitchOf} AND A DIFFERENT FACT. That one is the daemon's
 * answer that the switch failed; this one is the call itself not landing — a transport
 * failure, a permission refusal, or the latch's own arm. Both belong on the chip for
 * the same reason: the refusal reaches only the popover's form, which is portalled and
 * carries no `keepMounted`, so base-ui unmounts it on an outside click or Escape. A
 * participant who pressed Apply and clicked back into the message line to keep typing
 * was then told nothing at all — the one outcome a mutation surface may not have.
 */
export function switchRefusalOf(axes: TargetAxisReach | undefined): ConsoleRefusal | undefined {
  return axes === undefined || axes.reach !== "offered"
    ? undefined
    : axes.control.switching.refusal;
}
