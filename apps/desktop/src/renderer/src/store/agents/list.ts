// A session's agents as the background service lists them: one held list per session and feed,
// open while any view reads it and gone with its last reader, so it holds at most the agents of
// the sessions on screen. The list the stream opens with replaces what is held, and each agent it
// delivers after that replaces the one it names or joins the list. An agent that arrives before
// the list moves nothing, since the list restates it. A lost feed is the failed state, never an
// empty list, which would read as a session with no agents. Each session's list is a shared feed.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { AgentSubscribeEntry } from "@ai-sidekicks/contracts/agent/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { Unsubscribe } from "#shared/preload-api.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";

import { SharedFeed, type FeedFold } from "../shared-feed.js";

/**
 * What a view knows of one session's agents: `reading` until the list arrives, the agents in the
 * service's order once it has, or `failed` with why the list cannot be trusted.
 */
export type SessionAgentListState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly agents: readonly AgentSubscribeEntry[] }
  | { readonly status: "failed"; readonly refusal: Refusal };

/**
 * One delivery on a session's agent feed: the whole list, one agent as it now stands, or word that
 * the feed was lost and why.
 */
export type SessionAgentListFrame =
  | { readonly kind: "list"; readonly agents: readonly AgentSubscribeEntry[] }
  | { readonly kind: "agent"; readonly agent: AgentSubscribeEntry }
  | { readonly kind: "lost"; readonly refusal: Refusal };

/**
 * Open one session's agent feed, handing each frame on, until the handle releases it. The
 * composition supplies it, held stable per bridge, so `store/` stays below `services/`.
 */
export type SessionAgentListFeed = (
  sessionId: SessionId,
  onFrame: (frame: SessionAgentListFrame) => void,
) => Unsubscribe;

/** Every session's agent list being read, keyed by feed and then by session. */
export class SessionAgentLists {
  readonly #heldByFeed = new WeakMap<
    SessionAgentListFeed,
    Map<SessionId, SharedFeed<SessionAgentListFrame, SessionAgentListState>>
  >();

  /** Read `sessionId`'s agents off `feed` until the handle releases it, waking `onChange`. */
  public watch(
    feed: SessionAgentListFeed,
    sessionId: SessionId,
    onChange: () => void,
  ): Unsubscribe {
    let heldBySession = this.#heldByFeed.get(feed);
    if (heldBySession === undefined) {
      heldBySession = new Map();
      this.#heldByFeed.set(feed, heldBySession);
    }
    let held = heldBySession.get(sessionId);
    if (held === undefined) {
      held = new SharedFeed((onFrame) => feed(sessionId, onFrame), SESSION_AGENT_LIST_FOLD);
      heldBySession.set(sessionId, held);
    }
    const watched = held;
    const release = watched.watch(onChange);
    return () => {
      release();
      if (!watched.hasReaders && heldBySession.get(sessionId) === watched) {
        heldBySession.delete(sessionId);
      }
    };
  }

  /** What `sessionId`'s readers on `feed` see now: `reading` until its list arrives. */
  public stateOf(feed: SessionAgentListFeed, sessionId: SessionId): SessionAgentListState {
    return this.#heldByFeed.get(feed)?.get(sessionId)?.state ?? SESSION_AGENT_LIST_FOLD.initial;
  }

  /**
   * Open `sessionId`'s feed afresh, for a person asking again after a failure; the state on
   * screen stays until the fresh list replaces it.
   */
  public reopen(feed: SessionAgentListFeed, sessionId: SessionId): void {
    this.#heldByFeed.get(feed)?.get(sessionId)?.reread();
  }
}

/** The app's session agent lists. */
export const sessionAgentLists: SessionAgentLists = new SessionAgentLists();

/** The name the list gives `agentId`, or `undefined` until the list holds that agent. */
export function agentNameOf(
  state: SessionAgentListState,
  agentId: AgentId | undefined,
): string | undefined {
  if (state.status !== "served" || agentId === undefined) {
    return undefined;
  }
  return state.agents.find((agent) => agent.agentId === agentId)?.name;
}

/** Reading until the list arrives, then the list as each agent leaves it, or failed once lost. */
const SESSION_AGENT_LIST_FOLD: FeedFold<SessionAgentListFrame, SessionAgentListState> = {
  initial: { status: "reading" },
  open: () => stateAfter,
};

/** The state after one frame. */
function stateAfter(
  state: SessionAgentListState,
  frame: SessionAgentListFrame,
): SessionAgentListState {
  switch (frame.kind) {
    case "list":
      return { status: "served", agents: frame.agents };
    case "lost":
      return { status: "failed", refusal: frame.refusal };
    case "agent":
      return state.status === "served"
        ? { status: "served", agents: withAgent(state.agents, frame.agent) }
        : state;
  }
}

/** The agents with `agent` where it stood, or at the end for one that just joined. */
function withAgent(
  agents: readonly AgentSubscribeEntry[],
  agent: AgentSubscribeEntry,
): readonly AgentSubscribeEntry[] {
  const at = agents.findIndex((held) => held.agentId === agent.agentId);
  return at < 0 ? [...agents, agent] : agents.with(at, agent);
}
