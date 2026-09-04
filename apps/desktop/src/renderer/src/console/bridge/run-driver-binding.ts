// Which driver each run in one session is bound to, derived from the log.
//
// `driver.listCapabilities` answers with one report PER DRIVER and is addressed at
// the NODE, so it names no run: on a machine where both Claude and Codex are
// installed, a readout carrying two reports could name a binding for no run at all,
// and every run lost its capability-gated Steer and Rewind controls even where its
// own driver had declared them. What the reply cannot say, the session's own
// projection can — through the agent, which is where the wire puts the binding.
//
// THE JOIN, AND WHY IT IS TWO SOURCES AND NOT ONE. `Spec-006 §Channel and Agent
// Lifecycle` registers `agent.attached` with the full persona — `{sessionId, agentId,
// name, driverName, modelId, ...}` — and that payload is the only client-readable
// shape that names an agent's driver. `run.queued` names the agent a run was created
// for, and the run partition is where that lands: the run-lifecycle projector carries
// `agentId` onto the run's body, and the base snapshot merges its own run rows
// through the same partition. So the run side is read from the partition, which is
// the console's one answer to which runs exist, and the agent side from the timeline,
// which is the only place the driver name appears at all.
//
// NEITHER HALF IS GUESSED. A run whose body names no agent, an agent no attach beat
// named, and an attach beat naming another session all contribute NOTHING rather than
// a default — the map's absence is `boundDriverNameForRun`'s "the console cannot say",
// which takes a gated control off screen rather than offering one the daemon would
// refuse or hiding one it would have honoured.
//
// READ THROUGH A SCHEMA rather than off the record by hand, for the reason the goal
// fold gives for its own origin keys: the payload is `unknown` at this boundary, and
// a hand-shaped read would take a number, an empty string, or a missing member as a
// binding.

import { useMemo } from "react";
import { z } from "zod";
import type { SessionEventType } from "@ai-sidekicks/contracts";

import {
  useSessionPartition,
  useSessionStore,
  type ConsoleEntity,
  type ConsoleSessionEvent,
  type SessionStore,
  type SessionStoreState,
} from "../store/index.js";

/**
 * The one event kind that names an agent's driver.
 *
 * Typed against the shipped taxonomy rather than written as a bare string, so a
 * misspelling fails to compile instead of quietly matching an event no daemon emits
 * — the run-lifecycle projector's own rule for the same hazard.
 */
const AGENT_ATTACHED_EVENT_KIND: Extract<SessionEventType, "agent.attached"> = "agent.attached";

/** The three members of the attach payload this join reads, and nothing else. */
const agentAttachPayloadSchema = z.object({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  driverName: z.string().min(1),
});

/** The one member of a run's body this join reads. */
const runAgentBindingSchema = z.object({ agentId: z.string().min(1) });

/** The session timeline, selected once so every reader of it shares one function. */
export function selectSessionTimeline(state: SessionStoreState): readonly ConsoleSessionEvent[] {
  return state.timeline;
}

/**
 * Join the session's runs to their agents' declared drivers.
 *
 * Pure and total: a run this cannot resolve is simply absent from the answer, which
 * is the same fact as a read that has not landed and is rendered the same way.
 */
export function foldRunDriverBindings(
  runs: Readonly<Record<string, ConsoleEntity>>,
  timeline: readonly ConsoleSessionEvent[],
): ReadonlyMap<string, string> {
  const driverNameByAgentId = new Map<string, string>();
  for (const entry of timeline) {
    if (entry.kind !== AGENT_ATTACHED_EVENT_KIND) {
      continue;
    }
    const parsed = agentAttachPayloadSchema.safeParse(entry.payload);
    // Held to the envelope's own session, for the reason the run fold is: a payload
    // naming another session is a claim about another store, and reading it here
    // would bind this session's run to a driver named somewhere else. The LAST
    // attach beat for an agent wins, so an agent re-attached on a different driver
    // is read as its current binding rather than its first.
    if (!parsed.success || parsed.data.sessionId !== entry.sessionId) {
      continue;
    }
    driverNameByAgentId.set(parsed.data.agentId, parsed.data.driverName);
  }

  const driverNameByRunId = new Map<string, string>();
  for (const run of Object.values(runs)) {
    const binding = runAgentBindingSchema.safeParse(run.body);
    if (!binding.success) {
      continue;
    }
    const driverName = driverNameByAgentId.get(binding.data.agentId);
    if (driverName === undefined) {
      continue;
    }
    driverNameByRunId.set(run.id, driverName);
  }
  return driverNameByRunId;
}

/**
 * One session's run-to-driver bindings, as its store currently has them.
 *
 * Folded once per change of either reading rather than at each render: the join
 * walks the timeline, and a render body that rebuilt it would do that on every
 * keystroke in the composer below the pane that reads it.
 */
export function useRunDriverBindings(sessionStore: SessionStore): ReadonlyMap<string, string> {
  const runs = useSessionPartition(sessionStore, "run");
  const timeline = useSessionStore(sessionStore, selectSessionTimeline);
  return useMemo(() => foldRunDriverBindings(runs, timeline), [runs, timeline]);
}
