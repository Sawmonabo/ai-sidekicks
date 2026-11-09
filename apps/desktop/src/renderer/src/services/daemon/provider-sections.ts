// The service's provider list, read off `provider.list` and kept current by `provider.subscribe`,
// whose every message is one provider's whole section. The stream opens before the list is read,
// so no change falls between the two; a section the stream delivers before the list moves nothing,
// since the list sent after it holds it. Every delivery is checked with the contract's generated
// check. A refused or unreadable list, an unreadable section and a stream the daemon refuses are
// handed on as the list being lost, so no screen names a provider from a list that may be wrong.
// A stream that opens again reads the list again, since the gap may have hidden a change.

import { validateProviderSettingsResponse } from "@ai-sidekicks/contracts/provider/settings";

import { checkFaultPaths } from "#shared/daemon/fault-path.js";
import { PROVIDER_NOTICE_STREAM } from "#shared/daemon/streams.js";
import { recordRefusedMemberPaths } from "#renderer/lib/diagnostic-capture/refused-member-record.js";
import type {
  ProviderSectionsFeed,
  ProviderSectionsFrame,
} from "#renderer/store/providers/sections.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { openReopeningSubscription } from "../transport/reopening-subscription.js";
import { callDaemon } from "./reply.js";

/**
 * The app's provider feed over `bridge`, the same function for every caller with that bridge, so
 * every reader shares one stream.
 */
export function providerSectionsFeedFor(bridge: PlatformBridge): ProviderSectionsFeed {
  return providerSectionsFeeds.feedFor(bridge);
}

/** One feed per bridge, made on first ask. */
class ProviderSectionsFeeds {
  readonly #feedByBridge = new WeakMap<PlatformBridge, ProviderSectionsFeed>();

  public feedFor(bridge: PlatformBridge): ProviderSectionsFeed {
    const known = this.#feedByBridge.get(bridge);
    if (known !== undefined) {
      return known;
    }
    const feed: ProviderSectionsFeed = (onFrame) =>
      new ProviderSectionsFollower(bridge, onFrame).open();
    this.#feedByBridge.set(bridge, feed);
    return feed;
  }
}

/** The feeds this window's bridges have handed out. */
const providerSectionsFeeds = new ProviderSectionsFeeds();

/** One open of the feed: the stream, and the list read beside it. */
class ProviderSectionsFollower {
  readonly #bridge: PlatformBridge;
  readonly #onFrame: (frame: ProviderSectionsFrame) => void;
  // The list read in flight, aborted when a newer read replaces it or the feed is released.
  #listRead: AbortController | undefined;

  public constructor(bridge: PlatformBridge, onFrame: (frame: ProviderSectionsFrame) => void) {
    this.#bridge = bridge;
    this.#onFrame = onFrame;
  }

  /** Open the stream, then read the list; the handle closes both. */
  public open(): () => void {
    const bridge = this.#bridge;
    const releaseStream = openReopeningSubscription({
      signal: bridge.transportReconnect,
      subject: PROVIDER_NOTICE_STREAM,
      firstOpenFailure: "refuseAndRetry",
      open: (deliver, onEnded) =>
        bridge.daemon.subscribe(PROVIDER_NOTICE_STREAM, {}, deliver, onEnded),
      onFrame: (payload) => {
        this.#takeSection(payload);
      },
      onReopened: () => {
        this.#readList();
      },
      onReopenRefusal: (refusal) => {
        if (refusal !== undefined) {
          this.#onFrame({ kind: "lost" });
        }
      },
    });
    this.#readList();
    return () => {
      this.#listRead?.abort();
      this.#listRead = undefined;
      releaseStream();
    };
  }

  #readList(): void {
    this.#listRead?.abort();
    const listRead = new AbortController();
    this.#listRead = listRead;
    void callDaemon(this.#bridge, "provider.list", {}, { signal: listRead.signal }).then(
      (reply) => {
        if (listRead.signal.aborted) {
          return;
        }
        this.#onFrame(
          reply.status === "served"
            ? { kind: "list", sections: reply.value.providers }
            : { kind: "lost" },
        );
      },
    );
  }

  #takeSection(payload: unknown): void {
    if (validateProviderSettingsResponse(payload)) {
      this.#onFrame({ kind: "section", section: payload.settings });
      return;
    }
    recordRefusedMemberPaths({
      source: "services/daemon",
      kind: "notice-unreadable",
      subject: PROVIDER_NOTICE_STREAM,
      issues: checkFaultPaths(validateProviderSettingsResponse, payload),
    });
    this.#onFrame({ kind: "lost" });
  }
}
