// Where a composed message goes: the session, or an agent's running turn.
//
// The address is a projection of what the daemon has said. Nothing here guesses, and
// nothing renders a value the wire has not supplied, so the resolver lives apart from
// the components: a derivation inside a render body is one nobody can drive from a test.
//
// THE WIRE-READ FIELDS ARE `undefined`-ABLE ON PURPOSE. Each view family registers its own
// projector for the `agent` and `run` partitions, and the registry that takes them is built
// above the composer seat, so the resolver can answer with an incomplete target. That is
// the honest answer; defaulting a missing field is how a console starts asserting facts
// nobody established.

import { readWireNumber, readWireString } from "@renderer/lib/wire-strings.js";
import type { ConsoleEntity } from "@renderer/store/session/entities/entities.js";
import type { ConsoleEntityRef } from "@renderer/lib/entity-kinds.js";
import type { ConsolePaneAddress } from "../../../console/seats/index.js";
import { resolveAddressedRun } from "@renderer/features/composer/addressed-run.js";

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
  /**
   * The bound driver's wire-verbatim registry name, `undefined` when the wire has not said.
   *
   * Provider commands are filtered to this driver: the capability reply names one report
   * per driver and the console holds one binding per agent, so a target that could not
   * name the driver would have to intersect every report.
   */
  readonly driverName: string | undefined;
  readonly targetRunId: string;
  /**
   * The optimistic-concurrency comparand (`RunStateChangeEvent.runVersion`).
   *
   * `run.intervene` requires it and fails closed, so `undefined` is a refusal to
   * dispatch and never a zero: sending `0` would be a stale-replay guard the caller
   * supplied rather than one the daemon verified.
   */
  readonly expectedRunVersion: number | undefined;
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
 * that agent has a run this store has seen whose state still admits a steer, so a send
 * never has no target and never guesses the target run. Everything else goes to the
 * session, which needs no guess to reach.
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
      driverName: readWireString(agent?.body?.["driverName"]),
      targetRunId: run.id,
      expectedRunVersion: readWireNumber(run.body?.["runVersion"]),
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
