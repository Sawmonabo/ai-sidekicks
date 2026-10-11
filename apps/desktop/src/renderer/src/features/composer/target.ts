// What the composer is addressed at: the lead's live run while it has one, else the session. The
// composer is always the lead's, wherever focus is: a child is steered only in its own view. The
// address picks the `/` list's provider commands and the run the context ring reads; a send goes
// onto the session's queue either way. It is a projection of what the daemon has said, kept out of
// components so it can be driven from a test.
// The lead and its driver are read off the session's standing events, which the store keeps
// whatever rows its window holds; where they do not say, the target says nothing rather than guess.

import {
  readAgentDriverNames,
  readLeadAgentId,
} from "#renderer/services/driver-capabilities/session-agents.js";
import {
  type StoredEntity,
  type ProjectedSessionEvent,
} from "#renderer/store/session/entities/vocabulary.js";
import { resolveAddressedRun } from "./addressed-run.js";

/** A composer addressed at the session, while the lead has no live run. */
export interface ComposerSessionTarget {
  readonly kind: "session";
  readonly sessionId: string;
}

/**
 * A composer addressed at the session's lead's live run, never a child's. It sends as any message
 * is sent, onto the session's queue; the address names the agent the command list reads and the
 * run the context ring reads.
 */
export interface ComposerRunTarget {
  readonly kind: "run";
  readonly sessionId: string;
  /** The session's lead. */
  readonly agentId: string;
  /**
   * The lead's current driver, wire-verbatim, `undefined` when the log has not said.
   * Provider commands are filtered to this driver.
   */
  readonly driverName: string | undefined;
  readonly targetRunId: string;
}

/** What the composer is addressed at: the session or the lead's live run. */
export type ComposerTarget = ComposerSessionTarget | ComposerRunTarget;

/** What `resolveComposerTarget` is given, all of it read off the session's store. */
export interface ComposerTargetInput {
  readonly sessionId: string;
  /** The session store's standing events, read through its selector. */
  readonly standingEvents: readonly ProjectedSessionEvent[];
  /** The session store's `run` partition, read through its selector. */
  readonly runs: Readonly<Record<string, StoredEntity>>;
}

/**
 * Resolve what the composer is addressed at: the lead's run whenever the lead has a live one
 * (`addressed-run.ts`); otherwise, and whenever the lead is unknown, the session.
 */
export function resolveComposerTarget(input: ComposerTargetInput): ComposerTarget {
  const leadAgentId = readLeadAgentId(input.standingEvents);
  const run = leadAgentId === undefined ? undefined : resolveAddressedRun(input.runs, leadAgentId);
  if (leadAgentId !== undefined && run !== undefined) {
    return {
      kind: "run",
      sessionId: input.sessionId,
      agentId: leadAgentId,
      driverName: readAgentDriverNames(input.standingEvents).get(leadAgentId),
      targetRunId: run.id,
    };
  }
  return { kind: "session", sessionId: input.sessionId };
}
