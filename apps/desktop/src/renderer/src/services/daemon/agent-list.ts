// A session's agents, read off `agent.subscribe`: its acknowledgment carries the whole list, and
// each later message is one agent as it now stands; only the acknowledgment carries the
// subscription's id. A re-open the daemon refuses is handed on as the list being lost, so no
// screen names an agent from a list that may be wrong. A stream that ends is opened again, and its
// acknowledgment restates the list.

import type {
  AgentSubscribeEntry,
  AgentSubscribeResponse,
} from "@ai-sidekicks/contracts/agent/methods";

import { AGENT_LIST_STREAM } from "#shared/daemon/streams.js";
import type { SessionAgentListFeed } from "#renderer/store/agents/list.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { openReopeningSubscription } from "../transport/reopening-subscription.js";

/**
 * The agent feed over `bridge`, the same function for every caller with that bridge, so every
 * view of one session shares one stream.
 */
export function agentListFeedFor(bridge: PlatformBridge): SessionAgentListFeed {
  return agentListFeeds.feedFor(bridge);
}

/** One feed per bridge, made on first ask. */
class AgentListFeeds {
  readonly #feedByBridge = new WeakMap<PlatformBridge, SessionAgentListFeed>();

  public feedFor(bridge: PlatformBridge): SessionAgentListFeed {
    const known = this.#feedByBridge.get(bridge);
    if (known !== undefined) {
      return known;
    }
    const feed = agentListFeedOver(bridge);
    this.#feedByBridge.set(bridge, feed);
    return feed;
  }
}

/** The feeds this window's bridges have handed out. */
const agentListFeeds = new AgentListFeeds();

function agentListFeedOver(bridge: PlatformBridge): SessionAgentListFeed {
  return (sessionId, onFrame) =>
    openReopeningSubscription({
      signal: bridge.transportReconnect,
      subject: AGENT_LIST_STREAM,
      firstOpenFailure: "refuseAndRetry",
      open: (deliver, onEnded) =>
        bridge.daemon.subscribe(AGENT_LIST_STREAM, { sessionId }, deliver, onEnded),
      onFrame: (payload: unknown) => {
        const delivery = payload as AgentSubscribeResponse | AgentSubscribeEntry;
        onFrame(
          "subscriptionId" in delivery
            ? { kind: "list", agents: delivery.agents }
            : { kind: "agent", agent: delivery },
        );
      },
      onReopenRefusal: (refusal) => {
        if (refusal !== undefined) {
          onFrame({ kind: "lost", refusal });
        }
      },
    });
}
