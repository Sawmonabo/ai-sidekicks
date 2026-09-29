// Who is in the room before any run starts, as beats.
//
// `script-entries.ts` beside it turns an ordered script into positioned, stamped beats
// and carries the run, assistant and tool payload shapes. This holds the opening every
// scripted session plays before its first run, which answers to a different question:
// the script machinery changes when the engine's contract moves, these shapes change
// when the session-opening wire does.
//
// The dependency runs one way: this module reads the entry type from the script module
// and the script module reads nothing back. The run entry builders there never compose
// an opening, because an opening is not a run's.

import { type ScriptEntry } from "./script-entries.js";

/**
 * One agent of a scenario's cast.
 *
 * A scenario states each agent once, and both the `agent.attached` payload and the
 * `agent.list` row are built from it: two views of one record, which two hand-written
 * copies would let drift in the direction nothing catches.
 */
export interface ScenarioAgent {
  readonly agentId: string;
  readonly name: string;
  readonly driverName: string;
  readonly modelId: string;
  /** Milliseconds after the scenario's own start instant. */
  readonly attachedAtMs: number;
}

/** Who is in the room before any run starts. */
interface OpeningEntriesInput {
  readonly sessionId: string;
  /** The user who opened the session, and whose window this is. */
  readonly openedBy: string;
  readonly cast: readonly ScenarioAgent[];
}

/**
 * One agent of a scenario's cast, by the agent id a beat already names.
 *
 * So a beat that has to state a run's provider reads it off the cast rather than
 * restating it. The driver name is already one fact in one table, and a second copy
 * beside a beat would let a subagent be attributed to a provider its own agent does
 * not run on, which is half the key the transcript pairs a subagent's rows by.
 *
 * Throws rather than answering for nobody. A lookup that missed would otherwise hand
 * a beat an empty provider, and an empty provider is an identity the anchor index
 * silently declines to build: a fixture that renders as though nothing was scripted.
 */
export function findScenarioMember(cast: readonly ScenarioAgent[], agentId: string): ScenarioAgent {
  const member = cast.find((castMember) => castMember.agentId === agentId);
  if (member === undefined) {
    throw new RangeError(`no cast member of this scenario is attached as agent ${agentId}`);
  }
  return member;
}

/**
 * The instant a tick after the scenario's start stands for, as the ISO string a beat or
 * reply carries: an agent's attach, or any other stamp a scenario states by its tick.
 */
export function composeAttachedInstant(startedAtMs: number, attachedAtMs: number): string {
  return new Date(startedAtMs + attachedAtMs).toISOString();
}

/**
 * The opening of a scripted session: the room, then the cast.
 *
 * Every scripted session opens the same way, and the payload shapes here are the ones
 * a mistake is quietest in: `session.created` carries no title, and `agent.attached`
 * carries `name` where a reader expects `displayName`. Written once, every scenario is
 * right or every scenario is wrong, and the contract check says which.
 */
export function composeOpeningEntries(input: OpeningEntriesInput): readonly ScriptEntry[] {
  return [
    {
      atMs: 0,
      kind: "session.created",
      actorId: input.openedBy,
      // The registered shape verbatim: the new session's id plus the resolved
      // config and metadata. Both are open records and both are empty, because
      // no scenario names a key inside either.
      payload: { sessionId: input.sessionId, config: {}, metadata: {} },
    },
    ...input.cast.map((agent) => ({
      atMs: agent.attachedAtMs,
      kind: "agent.attached",
      // The person who attached the agent, not the agent: an agent does not attach
      // itself, and the envelope actor is who acted.
      actorId: input.openedBy,
      payload: {
        sessionId: input.sessionId,
        agentId: agent.agentId,
        name: agent.name,
        driverName: agent.driverName,
        modelId: agent.modelId,
        actor: input.openedBy,
      },
    })),
  ];
}
