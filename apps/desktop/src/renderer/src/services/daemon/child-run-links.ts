// The session's agent tree read off `agent.childRunLink.list`: every child run and provider helper
// with its head, the badge's counts and the refused creates, and the push-driven read the Agents
// pane and the composer's badge both hold, refreshed by the kinds that move the links. The reply
// is checked with the method's generated check; a refusal is thrown, so the read that asked
// settles failed. The clock is the caller's, so the scenario clock drives every debounce.

import type {
  AgentChildRunLinkListRequest,
  AgentChildRunLinkListResponse,
} from "@ai-sidekicks/contracts/orchestration";

import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import { RUN_STATE_EVENT_TYPES } from "@ai-sidekicks/contracts/transcript/operations";

import type { Clock } from "#renderer/lib/clock.js";
import { PushDrivenRead } from "#renderer/store/reads/push-driven.js";
import { subscribeToSessionEventKinds } from "#renderer/store/session/events/signal.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { callDaemon, unwrapDaemonReply } from "./reply.js";
import { heldIdAsWireId } from "./wire/identifiers.js";

/**
 * Reads the session's child-run tree, its counts and its refused creates over `bridge`, stopping
 * when `signal` aborts; a refusal rejects.
 */
export type ReadChildRunLinks = (
  bridge: PlatformBridge,
  request: AgentChildRunLinkListRequest,
  signal: AbortSignal,
) => Promise<AgentChildRunLinkListResponse>;

/** The child-run links read. */
export type ChildRunLinksRead = PushDrivenRead<AgentChildRunLinkListResponse>;

/**
 * Read one session's child-run tree over `bridge`, stopping when `signal` aborts. Throws a
 * `RefusalError` carrying the daemon's refusal, or the app's own when the reply is unreadable.
 */
export async function readChildRunLinks(
  bridge: PlatformBridge,
  request: AgentChildRunLinkListRequest,
  signal: AbortSignal,
): Promise<AgentChildRunLinkListResponse> {
  return unwrapDaemonReply(
    await callDaemon(bridge, "agent.childRunLink.list", request, { signal }),
  );
}

/**
 * The session's child links and refusal fold, refreshed by the event kinds that move it.
 * A burst of queued children costs one read: the shared scheduler coalesces them.
 */
export function createChildRunLinks(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
  clock: Clock,
  readLinks: ReadChildRunLinks,
): ChildRunLinksRead {
  return new PushDrivenRead<AgentChildRunLinkListResponse>({
    clock,
    origin: CHILD_RUN_LINKS_ORIGIN,
    read: async (signal) =>
      await readLinks(bridge, { sessionId: heldIdAsWireId(sessionStore.sessionId) }, signal),
    subscribe: (onChangeSignal) =>
      subscribeToSessionEventKinds(sessionStore, CHILD_RUN_LINK_EVENT_KINDS, onChangeSignal),
  });
}

/**
 * The kinds that move the session's child links: every run state change (a child queued, started,
 * waiting, finished), a provider's helper starting or ending, and `agent.run.rejected`, the only
 * record of a refused create (no link row is left).
 */
const CHILD_RUN_LINK_EVENT_KINDS: readonly SessionEventType[] = [
  ...RUN_STATE_EVENT_TYPES,
  "agent.subagent.started",
  "agent.subagent.completed",
  "agent.subagent.stopped",
  "agent.run.rejected",
];

/** Names the child-run links read in a refusal. */
const CHILD_RUN_LINKS_ORIGIN = "child-run-links";
