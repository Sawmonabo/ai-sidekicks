// A session's agents as the background service lists them: one held list per session and feed,
// open while any view reads it and gone with its last reader, so it holds at most the agents of
// the sessions on screen. The list the stream opens with replaces what is held, and each agent it
// delivers after that replaces the one it names or joins the list. An agent that arrives before
// the list moves nothing, since the list restates it. A lost feed is the failed state, never an
// empty list, which would read as a session with no agents.

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { AgentSubscribeEntry } from "@ai-sidekicks/contracts/agent/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { Unsubscribe } from "#shared/preload-api.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";

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
  readonly #heldByFeed = new WeakMap<SessionAgentListFeed, Map<SessionId, HeldAgentList>>();

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
      held = new HeldAgentList(feed, sessionId);
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
    return this.#heldByFeed.get(feed)?.get(sessionId)?.state ?? READING;
  }

  /** Close `sessionId`'s feed and open it afresh, for a person asking again after a failure. */
  public reopen(feed: SessionAgentListFeed, sessionId: SessionId): void {
    this.#heldByFeed.get(feed)?.get(sessionId)?.reopen();
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

/** What is held before the feed delivers its list. */
const READING: SessionAgentListState = { status: "reading" };

/** One session's list and its readers, with its feed open while any reader is. */
class HeldAgentList {
  readonly #feed: SessionAgentListFeed;
  readonly #sessionId: SessionId;
  readonly #readers = new Set<() => void>();
  #state: SessionAgentListState = READING;
  #release: Unsubscribe | undefined;

  public constructor(feed: SessionAgentListFeed, sessionId: SessionId) {
    this.#feed = feed;
    this.#sessionId = sessionId;
  }

  public get state(): SessionAgentListState {
    return this.#state;
  }

  public get hasReaders(): boolean {
    return this.#readers.size > 0;
  }

  public watch(onChange: () => void): Unsubscribe {
    this.#readers.add(onChange);
    if (this.#readers.size === 1) {
      this.#open();
    }
    return () => {
      this.#readers.delete(onChange);
      if (this.#readers.size === 0) {
        this.#close();
      }
    };
  }

  public reopen(): void {
    if (this.#readers.size === 0) {
      return;
    }
    this.#close();
    this.#notify();
    this.#open();
  }

  #apply(frame: SessionAgentListFrame): void {
    const next = stateAfter(this.#state, frame);
    if (next !== this.#state) {
      this.#state = next;
      this.#notify();
    }
  }

  #open(): void {
    this.#release = this.#feed(this.#sessionId, (frame) => {
      this.#apply(frame);
    });
  }

  // A later open reads afresh, so no list from before it is shown.
  #close(): void {
    const release = this.#release;
    this.#release = undefined;
    this.#state = READING;
    release?.();
  }

  #notify(): void {
    for (const onChange of [...this.#readers]) {
      onChange();
    }
  }
}

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
