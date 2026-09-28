// Where a composed message goes: the session, or an agent's running turn.
//
// The address is a projection of what the daemon has said. Nothing here guesses, and
// nothing renders a value the wire has not supplied, so the resolver lives apart from
// the components: a derivation inside a render body is one nobody can drive from a test.
//
// EVERY FIELD IS `undefined`-ABLE ON PURPOSE. The console has no projector for the
// `agent` or `run` partitions today — each view family registers its own, and the
// registry that takes them is constructed above the composer seat — so the resolver
// routinely answers with an incomplete target. That is the honest answer; defaulting a
// missing field is how a console starts asserting facts nobody established.

import { readWireNumber, readWireString } from "../../../console/core/index.js";
import type { ConsoleEntity, ConsoleEntityRef } from "../../../console/store/index.js";
import type { ConsolePaneAddress } from "../../../console/seats/index.js";
import { resolveAddressedRun } from "./addressed-run.js";

/**
 * The two paths a composed message can travel: the session, or a bound provider.
 *
 * Closed, declared once, union derived — the whole of the `/` rule branches on this
 * discriminant, so a third path added to a hand-written union while this tuple
 * stayed at two would be a path the escape rules never heard of.
 */
export const COMPOSER_SEND_PATHS = ["channel-message", "provider-bound"] as const;

/** One send path. Derived from the enumeration, never restated. */
export type ComposerSendPath = (typeof COMPOSER_SEND_PATHS)[number];

/** A message addressed to the session: the new-turn path. */
export interface ComposerChannelTarget {
  readonly path: "channel-message";
  readonly sessionId: string;
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
  /**
   * Wire-verbatim run state, rendered as received.
   *
   * AND IT REACHES HERE THROUGH THE SESSION STORE RATHER THAN THROUGH THE LIVE
   * SUBSCRIPTION THE DESIGN NAMES. The path label the composer shows under its line
   * — a new turn, or a steer — is resolved from the run entity this store projected
   * off the event log, which is honest and testable but is a fold rather than the
   * `run.subscribeState` reading the design says the state is delivered by. The two
   * agree today because the fold is built from the same events the subscription
   * carries; they would part the moment a state change reaches a client without an
   * event this store admits. The subscription is not wired in the renderer yet, so
   * nothing here reads it, and this member stays the projection — named rather than
   * silently substituted, and re-homed onto that reading by the task that lands the
   * run-state subscription.
   */
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

/** What `resolveComposerTarget` is given. All of it comes from the composer seat. */
export interface ComposerTargetInput {
  readonly sessionId: string;
  /** The deck pane a person is looking at, or `undefined` when focus is elsewhere. */
  readonly focusedPane: ConsolePaneAddress | undefined;
  /** The session store's `agent` partition, read through its selector. */
  readonly agents: Readonly<Record<string, ConsoleEntity>>;
  /** The session store's `run` partition, read through its selector. */
  readonly runs: Readonly<Record<string, ConsoleEntity>>;
}

/**
 * Resolve what this send is addressed to.
 *
 * The provider-bound path is taken ONLY when the focused pane names an agent AND
 * that agent has a run this store has seen whose state still admits a steer — the
 * two conditions the design states as "never sends a message with no target; never
 * guesses the target run". Everything else goes to the session, which needs no guess
 * to reach.
 *
 * `addressed-run.ts` owns the second condition and says why an agent whose only
 * runs have settled addresses the session rather than a run nothing can be sent to.
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
      agentName: readWireString(agent?.body?.["name"]),
      driverName: readWireString(agent?.body?.["driverName"]),
      targetRunId: run.id,
      expectedRunVersion: readWireNumber(run.body?.["runVersion"]),
      runState: run.state,
      providerFailureDetail: readWireString(run.body?.["providerFailureDetail"]),
    };
  }
  return { path: "channel-message", sessionId: input.sessionId };
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
