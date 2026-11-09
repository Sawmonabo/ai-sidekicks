// A session's agents, read off `agent.subscribe`: its acknowledgment carries the whole list, and
// each later message is one agent as it now stands. Every delivery is checked with the contract's
// generated check. An unreadable delivery, or a re-open the daemon refuses, is handed on as the
// list being lost, so no screen names an agent from a list that may be wrong. A stream that ends
// is opened again, and its acknowledgment restates the list.

import {
  validateAgentSubscribeEntry,
  validateAgentSubscribeResponse,
} from "@ai-sidekicks/contracts/agent/methods";

import { AGENT_LIST_STREAM } from "#shared/daemon/streams.js";
import { checkFaultPaths } from "#shared/daemon/fault-path.js";
import { recordRefusedMemberPaths } from "#renderer/lib/diagnostic-capture/refused-member-record.js";
import { refuse } from "#renderer/lib/refusal/contract.js";
import type { SessionAgentListFeed, SessionAgentListFrame } from "#renderer/store/agents/list.js";
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

/** What a delivery the contract's checks refuse is handed on as. */
const UNREADABLE_AGENT_LIST: SessionAgentListFrame = {
  kind: "lost",
  refusal: refuse(
    "agent-list",
    "agent-list-unreadable",
    "This session's sidekicks could not be read.",
  ),
};

function agentListFeedOver(bridge: PlatformBridge): SessionAgentListFeed {
  return (sessionId, onFrame) =>
    openReopeningSubscription({
      signal: bridge.transportReconnect,
      subject: AGENT_LIST_STREAM,
      firstOpenFailure: "refuseAndRetry",
      open: (deliver, onEnded) =>
        bridge.daemon.subscribe(AGENT_LIST_STREAM, { sessionId }, deliver, onEnded),
      onFrame: (payload: unknown) => {
        if (validateAgentSubscribeResponse(payload)) {
          onFrame({ kind: "list", agents: payload.agents });
          return;
        }
        if (validateAgentSubscribeEntry(payload)) {
          onFrame({ kind: "agent", agent: payload });
          return;
        }
        recordRefusedMemberPaths({
          source: "services/daemon",
          kind: "notice-unreadable",
          subject: AGENT_LIST_STREAM,
          issues: checkFaultPaths(validateAgentSubscribeEntry, payload),
        });
        onFrame(UNREADABLE_AGENT_LIST);
      },
      onReopenRefusal: (refusal) => {
        if (refusal !== undefined) {
          onFrame({ kind: "lost", refusal });
        }
      },
    });
}
