// The service's projects, read off `project.subscribe`: the whole list when the stream opens and
// again on each change. A re-open the daemon refuses is handed on as the list being lost. A stream
// that ends is opened again and restates the list.

import type { ProjectList } from "@ai-sidekicks/contracts/project";

import { PROJECT_LIST_STREAM } from "#shared/daemon/streams.js";
import type { ProjectListFeed } from "#renderer/store/projects/list.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { openReopeningSubscription } from "../transport/reopening-subscription.js";

/**
 * The window's project feed over `bridge`, the same function for every caller with that bridge,
 * so every view reading the list shares one stream.
 */
export function projectListFeedFor(bridge: PlatformBridge): ProjectListFeed {
  return projectListFeeds.feedFor(bridge);
}

/** One feed per bridge, made on first ask. */
class ProjectListFeedsByBridge {
  readonly #feedByBridge = new WeakMap<PlatformBridge, ProjectListFeed>();

  public feedFor(bridge: PlatformBridge): ProjectListFeed {
    const known = this.#feedByBridge.get(bridge);
    if (known !== undefined) {
      return known;
    }
    const feed = projectListFeedOver(bridge);
    this.#feedByBridge.set(bridge, feed);
    return feed;
  }
}

/** The feeds this window's bridges have handed out. */
const projectListFeeds = new ProjectListFeedsByBridge();

function projectListFeedOver(bridge: PlatformBridge): ProjectListFeed {
  return (onFrame) =>
    openReopeningSubscription({
      signal: bridge.transportReconnect,
      subject: PROJECT_LIST_STREAM,
      firstOpenFailure: "refuseAndRetry",
      open: (deliver, onEnded) =>
        bridge.daemon.subscribe(PROJECT_LIST_STREAM, {}, deliver, onEnded),
      onFrame: (payload) => {
        onFrame({ kind: "list", projects: (payload as ProjectList).projects });
      },
      onReopenRefusal: (refusal) => {
        if (refusal !== undefined) {
          onFrame({ kind: "lost" });
        }
      },
    });
}
