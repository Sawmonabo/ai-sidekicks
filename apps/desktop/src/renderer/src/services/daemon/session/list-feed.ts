// The service's session list, read off `session.list`: the list as it stands when the stream
// opens, then each change to it. Every delivery is parsed here against the contract. One that does
// not match, or a re-open the daemon refuses, is handed on as the list being lost, so its reader
// says the list could not be read rather than show a list that may be wrong; the cause goes to the
// window's diagnostic capture. A stream that ends is opened again and restates the list.

import {
  SessionListAckSchema,
  SessionListChangeSchema,
} from "@ai-sidekicks/contracts/session/directory";

import { SESSION_LIST_STREAM } from "#shared/daemon/streams.js";
import { recordRefusedMemberPaths } from "#renderer/lib/diagnostic-capture/refused-member-record.js";
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
        const listed = SessionListAckSchema.safeParse(payload);
        if (listed.success) {
          onFrame({ kind: "list", sessions: listed.data.sessions });
          return;
        }
        const changed = SessionListChangeSchema.safeParse(payload);
        if (changed.success) {
          onFrame({ kind: "change", change: changed.data });
          return;
        }
        recordRefusedMemberPaths({
          source: "services/daemon",
          kind: "notice-unreadable",
          subject: SESSION_LIST_STREAM,
          issues: changed.error.issues,
        });
        onFrame({ kind: "lost" });
      },
      onReopenRefusal: (refusal) => {
        if (refusal !== undefined) {
          onFrame({ kind: "lost" });
        }
      },
    });
}
