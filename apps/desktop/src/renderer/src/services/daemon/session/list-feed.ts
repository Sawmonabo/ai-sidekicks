// The service's session list, read off `session.list`: the list as it stands when the stream
// opens, the acknowledgment that alone carries the subscription's id, in pages when it outgrows
// one message, then each change to it. A re-open the daemon refuses is handed on as the list being
// lost, so its reader says the list could not be read rather than show a list that may be wrong.
// A stream that ends is opened again and restates the list.

import type {
  SessionListChange,
  SessionSubscribeResponse,
} from "@ai-sidekicks/contracts/session/directory";

import { SESSION_LIST_STREAM } from "#shared/daemon/streams.js";
import type { SessionDirectoryFeed } from "#renderer/store/session/directory/state.js";
import type { PlatformBridge } from "../../platform/bridge.js";
import { openReopeningSubscription } from "../../transport/reopening-subscription.js";

/**
 * The window's session list feed over `bridge`, the same function for every caller with that
 * bridge, so every view reading the list shares one stream.
 */
export function sessionDirectoryFeedFor(bridge: PlatformBridge): SessionDirectoryFeed {
  return sessionListFeeds.feedFor(bridge);
}

/** One feed per bridge, made on first ask. */
class SessionListFeeds {
  readonly #feedByBridge = new WeakMap<PlatformBridge, SessionDirectoryFeed>();

  public feedFor(bridge: PlatformBridge): SessionDirectoryFeed {
    const known = this.#feedByBridge.get(bridge);
    if (known !== undefined) {
      return known;
    }
    const feed = sessionListFeedOver(bridge);
    this.#feedByBridge.set(bridge, feed);
    return feed;
  }
}

/** The feeds this window's bridges have handed out. */
const sessionListFeeds = new SessionListFeeds();

function sessionListFeedOver(bridge: PlatformBridge): SessionDirectoryFeed {
  return (onFrame) =>
    openReopeningSubscription({
      signal: bridge.transportReconnect,
      subject: SESSION_LIST_STREAM,
      firstOpenFailure: "refuseAndRetry",
      open: (deliver, onEnded) =>
        bridge.daemon.subscribe(SESSION_LIST_STREAM, {}, deliver, onEnded),
      onFrame: (payload) => {
        const delivery = payload as SessionSubscribeResponse | SessionListChange;
        onFrame(
          "subscriptionId" in delivery
            ? {
                kind: "list",
                sessions: delivery.sessions,
                chatCount: delivery.chatCount,
                isComplete: delivery.isComplete,
              }
            : { kind: "change", change: delivery },
        );
      },
      onReopenRefusal: (refusal) => {
        if (refusal !== undefined) {
          onFrame({ kind: "lost" });
        }
      },
    });
}
