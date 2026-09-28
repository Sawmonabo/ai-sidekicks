// Who is in the room before any run starts, as beats.
//
// SPLIT FROM `ledger-script.ts` BESIDE IT, which holds two other jobs: turning an
// ordered script into positioned, stamped beats, and carrying the run / assistant /
// tool payload shapes. This holds the third — the opening every ledger-shaped session
// plays before its first run — and it is the one of the three that answers to a
// different question. The script machinery changes when the ENGINE's contract moves;
// these shapes change when the SESSION-OPENING wire does.
//
// THE SPLIT IS ONE-DIRECTIONAL, which is what makes it a split rather than a cycle:
// this module reads the entry type from the script module and the script module reads
// nothing back. The lane binder there composes the four machine-activity builders and
// never an opening, because an opening is not a lane's.

import { type LedgerScriptEntry } from "./ledger-script.js";

/**
 * One agent as every ledger scenario carries it.
 *
 * A scenario states each agent once and the `agent.attached` payload is built from it.
 */
export interface LedgerCastMember {
  readonly agentId: string;
  readonly name: string;
  readonly driverName: string;
  readonly modelId: string;
}

/**
 * The one member the lookup below needs, and deliberately not the whole cast row.
 *
 * A scenario's own cast table carries more than these four — the tick it attached at,
 * for one — so the lookup is constrained by the id alone and hands back the caller's
 * OWN row type. Constraining it to `LedgerCastMember` would compile just as well and
 * would return the narrower shape, which is how a caller loses the member it looked
 * the row up for.
 */
export interface LedgerCastMemberLookup {
  readonly agentId: string;
}

/** Who is in the room before any run starts. */
export interface LedgerOpeningInput {
  readonly sessionId: string;
  /** The user who opened the session, and whose window this is. */
  readonly openedBy: string;
  /** The cast, each attached at the tick beside it. */
  readonly cast: readonly (LedgerCastMember & { readonly attachedAtMs: number })[];
}

/**
 * One member of a scenario's cast, by the agent id a beat already names.
 *
 * So a beat that has to state a lane's PROVIDER reads it off the cast rather than
 * restating it. The driver name is already one fact in one table, and a second copy
 * beside a beat would let a subagent be attributed to a provider its own agent does
 * not run on — which is half the key the console pairs a subagent's rows by.
 *
 * Throws rather than answering for nobody. A lookup that missed would otherwise hand
 * a beat an empty provider, and an empty provider is an identity the anchor index
 * silently declines to build — a fixture that renders as though nothing was scripted.
 */
export function ledgerCastMember<Member extends LedgerCastMemberLookup>(
  cast: readonly Member[],
  agentId: string,
): Member {
  const member = cast.find((castMember) => castMember.agentId === agentId);
  if (member === undefined) {
    throw new RangeError(`no cast member of this scenario is attached as agent ${agentId}`);
  }
  return member;
}

/**
 * The opening of a ledger session: the room, then the cast.
 *
 * Every ledger scenario opens the same way, and the payload shapes here are the ones
 * a mistake is quietest in — `session.created` carries no title, and `agent.attached`
 * carries `name` where a reader expects `displayName`. Written once, every scenario is
 * right or every scenario is wrong, and the wire-truth predicate says which.
 */
export function ledgerOpeningEntries(input: LedgerOpeningInput): readonly LedgerScriptEntry[] {
  return [
    {
      atMs: 0,
      kind: "session.created",
      actorId: input.openedBy,
      // The registered shape verbatim: the new session's id plus the resolved
      // config and metadata. Both are open records and both are empty, because
      // nothing in the corpus names a key inside either.
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
