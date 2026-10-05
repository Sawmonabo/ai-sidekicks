// Where a composed message goes: the session, or an agent's running turn. The address is a
// projection of what the daemon has said, kept out of components so it can be driven from a test.
// The wire-read fields are `undefined`-able because each feature registers its own projector, so
// the resolver can answer with an incomplete target; defaulting a missing field would assert facts
// nobody established.

import { readWireNumber, readWireString } from "@renderer/lib/wire/strings.js";
import type { StoredEntity } from "@renderer/store/session/entities/entities.js";
import type { EntityRef } from "@renderer/lib/entity-kinds.js";
import type { PaneAddress } from "@renderer/routing/panes/pane-address.js";
import { resolveAddressedRun } from "./addressed-run.js";

/** The two paths a composed message can travel; the union is derived so a third is not missed. */
export const COMPOSER_SEND_PATHS = ["session-message", "provider-bound"] as const;

/** One send path. Derived from the enumeration, never restated. */
export type ComposerSendPath = (typeof COMPOSER_SEND_PATHS)[number];

/** A message addressed to the session: the new-turn path. */
export interface ComposerSessionTarget {
  readonly path: "session-message";
  readonly sessionId: string;
}

/** A message addressed to an agent's running turn: the steer path. */
export interface ComposerRunTarget {
  readonly path: "provider-bound";
  readonly sessionId: string;
  readonly agentId: string;
  /**
   * The bound driver's wire-verbatim registry name, `undefined` when the wire has not said.
   * Provider commands are filtered to this driver.
   */
  readonly driverName: string | undefined;
  readonly targetRunId: string;
  /**
   * The optimistic-concurrency comparand (`RunStateChangeEvent.runVersion`). `run.intervene`
   * fails closed without it, so `undefined` refuses dispatch and is never sent as `0`.
   */
  readonly expectedRunVersion: number | undefined;
  /**
   * The run terminal's `providerFailureDetail`, wire-verbatim. Carried, not interpreted here:
   * `draft-line/text-neutralization.ts` reads it.
   */
  readonly providerFailureDetail: string | undefined;
}

/** Where a composed message goes: the session or a bound agent's run. */
export type ComposerTarget = ComposerSessionTarget | ComposerRunTarget;

/** What `resolveComposerTarget` is given. All of it comes from the composer's props. */
export interface ComposerTargetInput {
  readonly sessionId: string;
  /** The pane a person is looking at, or `undefined` when focus is elsewhere. */
  readonly focusedPane: PaneAddress | undefined;
  /** The session store's `agent` partition, read through its selector. */
  readonly agents: Readonly<Record<string, StoredEntity>>;
  /** The session store's `run` partition, read through its selector. */
  readonly runs: Readonly<Record<string, StoredEntity>>;
}

/**
 * Resolve what this send is addressed to. The provider-bound path is taken only when the focused
 * pane names an agent that has a run whose state still admits a steer (`addressed-run.ts`);
 * everything else goes to the session.
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
  return { path: "session-message", sessionId: input.sessionId };
}

/**
 * The entity of one kind a focused pane names, or `undefined` when it names another. The `in`
 * check narrows: session-scoped pane arms carry no `entity` member at all.
 */
function focusedRefOfKind(
  pane: PaneAddress | undefined,
  kind: EntityRef["kind"],
): EntityRef | undefined {
  if (pane === undefined || !("entity" in pane)) {
    return undefined;
  }
  const { entity } = pane;
  return entity !== undefined && entity.kind === kind ? entity : undefined;
}
