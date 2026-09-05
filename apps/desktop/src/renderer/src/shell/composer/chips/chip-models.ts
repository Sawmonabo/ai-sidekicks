// What the two chips SAY, derived from what the daemon has actually said.
//
// `Spec-023 §Console Design (Meridian)` gives the composer two chips and one job
// each: the target chip names where a message goes, and the posture chip names the
// posture the run got. Both are projections. Neither derives eligibility, neither
// guesses, and neither renders a value the wire has not supplied — so this module
// is where the derivation lives, separate from the components, because a derivation
// inside a render body is a derivation nobody can drive from a test.
//
// THE ADDRESSING VOCABULARY LIVES HERE AND NOT IN THE ROUTER, even though the
// router is what spends it. The chip is what a person reads the address off, and
// the router is what acts on it; putting the value beside the chip and letting the
// router import it keeps the one-way edge, and putting it beside the router would
// have made the chip import the thing it is a view of.
//
// EVERY FIELD IS `undefined`-ABLE ON PURPOSE. The console has no projector for the
// `agent` or `run` partitions today — each view family registers its own, and the
// registry that takes them is constructed above the composer seat — so these
// resolvers routinely answer with an incomplete target. That is the honest answer
// and the chips render it as an absence; the alternative, defaulting a missing
// field, is how a console starts asserting facts nobody established.
//
// AND WHAT IS READ OFF A BODY IS ONLY WHAT A BODY CARRIES. `ConsoleEntity.body` is
// an untyped bag, so a member read from it typechecks whatever its name is — which
// is how three chips came to render `providerAccountLabel`, `pendingSwitchBoundary`,
// and `providerSwitchFailureReason`, none of which exists in any contract, registry,
// or document, and none of which any daemon has ever sent. Those three facts have
// real carriers — the `agent.list` reply for the first two, and a mutation response
// or an event for the third — and they are read from those carriers in
// `agent-binding-read.ts`, which states which of them this console can reach today
// and which it cannot. What is left here is what the store's own log supplies.

import type { ExecutionPosture } from "@ai-sidekicks/contracts";

import { stampedExecutionPostureOf } from "../../../console/bridge/index.js";
import type { ConsoleEntity, ConsoleEntityRef } from "../../../console/store/index.js";
import type { ConsolePaneAddress } from "../../../console/seats/index.js";
import { resolveAddressedRun } from "./addressed-run.js";

/**
 * The two paths a composed message can travel (§Channel and provider paths).
 *
 * Closed, declared once, union derived — the whole of the `/` rule branches on this
 * discriminant, so a third path added to a hand-written union while this tuple
 * stayed at two would be a path the escape rules never heard of.
 */
export const COMPOSER_SEND_PATHS = ["channel-message", "provider-bound"] as const;

/** One send path. Derived from the enumeration, never restated. */
export type ComposerSendPath = (typeof COMPOSER_SEND_PATHS)[number];

/** A message addressed to a channel: the new-turn path. */
export interface ComposerChannelTarget {
  readonly path: "channel-message";
  readonly sessionId: string;
  /** Wire-verbatim, or absent when the session's default channel is implied. */
  readonly channelId: string | undefined;
  /** Wire-verbatim repo binding, absent for a non-repo run. */
  readonly workspaceId: string | undefined;
  /** What the placeholder names. Wire-verbatim; never composed from an id. */
  readonly channelLabel: string | undefined;
}

/** A message addressed to an agent's running turn: the steer path. */
export interface ComposerRunTarget {
  readonly path: "provider-bound";
  readonly sessionId: string;
  readonly agentId: string;
  /** Wire-verbatim display name, absent until the roster read supplies one. */
  readonly agentName: string | undefined;
  /**
   * The bound driver's wire-verbatim registry name, absent until the wire says.
   *
   * Carried on the target because the accessory rail gates the compaction control
   * on THIS driver's declaration: the capability reply names one report per driver
   * and the console holds one binding per agent, so a rail that could not name the
   * driver would have to intersect every report and hide a capable driver's control
   * whenever some other driver in the session lacked the flag.
   */
  readonly driverName: string | undefined;
  readonly targetRunId: string;
  /**
   * The optimistic-concurrency comparand (`RunStateChangeEvent.runVersion`).
   *
   * `undefined` until `run.subscribeState` has been read for this run. The wire
   * makes it MANDATORY and fail-closed on `run.intervene`, so an absent comparand
   * is a refusal to dispatch and never a zero: sending `0` would be a stale-replay
   * guard the caller supplied rather than one the daemon verified.
   */
  readonly expectedRunVersion: number | undefined;
  /** Wire-verbatim run state, rendered as received. */
  readonly runState: string | undefined;
  /**
   * The run terminal's `providerFailureDetail`, wire-verbatim.
   *
   * Carried rather than interpreted here: it has two producers on the wire — prose
   * from the resume-failure path and one fixed form from the outbound-frame
   * neutralization tripwire — and reading which is `neutralization-tripwire.ts`'s
   * one job. Splitting the read from the carry keeps this module free of a second
   * parser for a shape one contract comment governs.
   */
  readonly providerFailureDetail: string | undefined;
}

export type ComposerTarget = ComposerChannelTarget | ComposerRunTarget;

/** What the target chip renders, and nothing about how. */
export interface TargetChipModel {
  readonly target: ComposerTarget;
  /**
   * The binding in one clause — "claude · opus · high" — assembled from the
   * wire-supplied axes the agent entity carries. `undefined` when the wire has
   * supplied none: a binding clause the console composed from defaults would read
   * exactly like one the daemon reported.
   */
  readonly bindingClause: string | undefined;
}

/**
 * What the posture chip renders.
 *
 * `stamped` is the posture the run actually got, stamped on `run.running`. There is
 * deliberately no `requested` member: no wire member carries a posture request, so
 * a requested posture would be a value the console invented, and rendering it beside
 * a stamped one would make the two look like the same kind of fact.
 */
export interface PostureChipModel {
  readonly stamped: ExecutionPosture | undefined;
}

/** The wire-supplied axis keys the binding clause is assembled from, in read order. */
const BINDING_CLAUSE_AXES = ["driverName", "model", "effort"] as const;

/** The separator `Spec-023 §Console Design (Meridian)` uses between binding axes. */
const BINDING_CLAUSE_SEPARATOR = " · ";

/** What `resolveComposerTarget` is given. All of it comes from the composer seat. */
export interface ComposerTargetInput {
  readonly sessionId: string;
  /** The deck pane a person is looking at, or `undefined` when focus is elsewhere. */
  readonly focusedPane: ConsolePaneAddress | undefined;
  /** The session store's `agent` partition, read through its selector. */
  readonly agents: Readonly<Record<string, ConsoleEntity>>;
  /** The session store's `run` partition, read through its selector. */
  readonly runs: Readonly<Record<string, ConsoleEntity>>;
  /** The session store's `channel` partition, read through its selector. */
  readonly channels: Readonly<Record<string, ConsoleEntity>>;
}

/**
 * Resolve what this send is addressed to.
 *
 * The provider-bound path is taken ONLY when the focused pane names an agent AND
 * that agent has a run this store has seen whose state still admits a steer — the
 * two conditions the design states as "never sends a message with no target; never
 * guesses the target run". Everything else is the channel path, which is the
 * session's own default and needs no guess to reach.
 *
 * `addressed-run.ts` owns the second condition and says why an agent whose only
 * runs have settled addresses the channel rather than a run nothing can be sent to.
 */
export function resolveComposerTarget(input: ComposerTargetInput): ComposerTarget {
  const agentRef = focusedRefOfKind(input.focusedPane, "agent");
  const agent = agentRef === undefined ? undefined : input.agents[agentRef.id];
  const run = agentRef === undefined ? undefined : resolveAddressedRun(input.runs, agentRef.id);
  if (agentRef !== undefined && run !== undefined) {
    return {
      path: "provider-bound",
      sessionId: input.sessionId,
      agentId: agentRef.id,
      agentName: readWireString(agent?.body, "name"),
      driverName: readWireString(agent?.body, "driverName"),
      targetRunId: run.id,
      expectedRunVersion: readWireNumber(run.body, "runVersion"),
      runState: run.state,
      providerFailureDetail: readWireString(run.body, "providerFailureDetail"),
    };
  }
  // The channel arm addresses the pane's channel when the pane names one, and the
  // SESSION'S OWN DEFAULT otherwise — which is what omitting `channelId` states on
  // `run.queueCreate`, an answer the wire supports rather than a guess the console
  // made. Picking "the first channel in the partition" would be the guess.
  const channelRef = focusedRefOfKind(input.focusedPane, "channel");
  const channel = channelRef === undefined ? undefined : input.channels[channelRef.id];
  return {
    path: "channel-message",
    sessionId: input.sessionId,
    channelId: channelRef?.id,
    workspaceId: readWireString(channel?.body, "workspaceId"),
    channelLabel: readWireString(channel?.body, "name"),
  };
}

/** Build the target chip's model from the resolved target and the agent entity. */
export function resolveTargetChipModel(
  target: ComposerTarget,
  agents: Readonly<Record<string, ConsoleEntity>>,
): TargetChipModel {
  const agent = target.path === "provider-bound" ? agents[target.agentId] : undefined;
  return { target, bindingClause: composeBindingClause(agent?.body) };
}

/**
 * Build the posture chip's model.
 *
 * The posture is read off the target run's entity body and nowhere else. A session
 * default, a policy lookup, or a per-agent guess would each be the renderer deriving
 * a posture, which `Spec-012 §Required Behavior` puts at the daemon at run start.
 *
 * AND THE READ IS THE WIRE'S EDGE'S, NOT THIS MODULE'S. It used to check
 * `typeof mode === "string"` and `Array.isArray(writableRoots)` and then assert the
 * whole `ExecutionPosture` — which admits a body carrying no `networkAccess` at all,
 * the one member the chip actually renders, and a `mode` outside the closed union.
 * `stampedExecutionPostureOf` parses the candidate against the registered
 * `RunStateChangeEvent` shape, so a body the wire would not admit reaches the chip
 * as `undefined` and the chip renders `not-checked` rather than an empty label
 * beside two full ones.
 */
export function resolvePostureChipModel(
  target: ComposerTarget,
  runs: Readonly<Record<string, ConsoleEntity>>,
): PostureChipModel {
  if (target.path !== "provider-bound") {
    return { stamped: undefined };
  }
  return { stamped: stampedExecutionPostureOf(runs[target.targetRunId]) };
}

/**
 * The entity of one kind a focused pane names, or `undefined` when it names another.
 *
 * The `in` check is the narrowing and not a defensive guard: `ConsolePaneAddress` is
 * a union over pane kind, and a session-scoped arm carries no `entity` MEMBER at all
 * rather than one holding `undefined`. So a pane addressed at `runs`, `approvals`,
 * `browser`, or `terminal` names no entity by construction, and this reads that fact
 * off the address rather than dereferencing a member three arms do not have.
 */
function focusedRefOfKind(
  pane: ConsolePaneAddress | undefined,
  kind: ConsoleEntityRef["kind"],
): ConsoleEntityRef | undefined {
  if (pane === undefined || !("entity" in pane)) {
    return undefined;
  }
  const { entity } = pane;
  return entity !== undefined && entity.kind === kind ? entity : undefined;
}

/** The binding clause, or `undefined` when the wire supplied no axis at all. */
function composeBindingClause(
  body: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const axes = BINDING_CLAUSE_AXES.map((axis) => readWireString(body, axis)).filter(
    (value): value is string => value !== undefined,
  );
  return axes.length === 0 ? undefined : axes.join(BINDING_CLAUSE_SEPARATOR);
}

/** One wire-supplied string from an entity body, or `undefined`. */
function readWireString(
  body: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = body?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One wire-supplied finite number from an entity body, or `undefined`. */
function readWireNumber(
  body: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const value = body?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
