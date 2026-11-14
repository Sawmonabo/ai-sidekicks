// The service's skill list, read off `skill.list` and kept current by `skill.subscribe`, whose
// every message is the whole list again. The stream opens before the list is read, so no change
// falls between the two. A refused read and a stream the daemon refuses are handed on as the list
// being lost, so no surface offers a skill from a list that may be wrong. A stream that opens again
// reads the list again, since the gap may have hidden a change.

import type { SkillListResponse } from "@ai-sidekicks/contracts/skill";

import { SKILL_LIST_STREAM } from "#shared/daemon/streams.js";
import type { SkillListFeed, SkillListFrame } from "#renderer/store/skills/list.js";
import type { PlatformBridge } from "../platform/bridge.js";
import { openReopeningSubscription } from "../transport/reopening-subscription.js";
import { callDaemon } from "./reply.js";

/**
 * The app's skill feed over `bridge`, the same function for every caller with that bridge, so a
 * store keyed on the feed is not rebuilt each render.
 */
export function skillListFeedFor(bridge: PlatformBridge): SkillListFeed {
  return skillListFeeds.feedFor(bridge);
}

/** One feed per bridge, made on first ask. */
class SkillListFeeds {
  readonly #feedByBridge = new WeakMap<PlatformBridge, SkillListFeed>();

  public feedFor(bridge: PlatformBridge): SkillListFeed {
    const known = this.#feedByBridge.get(bridge);
    if (known !== undefined) {
      return known;
    }
    const feed: SkillListFeed = (onFrame) => new SkillListFollower(bridge, onFrame).open();
    this.#feedByBridge.set(bridge, feed);
    return feed;
  }
}

/** The feeds this window's bridges have handed out. */
const skillListFeeds = new SkillListFeeds();

/** One open of the feed: the stream, and the list read beside it. */
class SkillListFollower {
  readonly #bridge: PlatformBridge;
  readonly #onFrame: (frame: SkillListFrame) => void;
  // The list read in flight, aborted when a newer read replaces it or the feed is released.
  #listRead: AbortController | undefined;

  public constructor(bridge: PlatformBridge, onFrame: (frame: SkillListFrame) => void) {
    this.#bridge = bridge;
    this.#onFrame = onFrame;
  }

  /** Open the stream, then read the list; the handle closes both. */
  public open(): () => void {
    const bridge = this.#bridge;
    const releaseStream = openReopeningSubscription({
      signal: bridge.transportReconnect,
      subject: SKILL_LIST_STREAM,
      firstOpenFailure: "refuseAndRetry",
      open: (deliver, onEnded) => bridge.daemon.subscribe(SKILL_LIST_STREAM, {}, deliver, onEnded),
      onFrame: (payload) => {
        this.#takeList(payload);
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
    void callDaemon(this.#bridge, "skill.list", {}, { signal: listRead.signal }).then((reply) => {
      if (listRead.signal.aborted) {
        return;
      }
      this.#onFrame(
        reply.status === "served" ? { kind: "list", skills: reply.value.skills } : { kind: "lost" },
      );
    });
  }

  #takeList(payload: unknown): void {
    // A list the stream delivers is at least as new as one a read still in flight would answer.
    this.#listRead?.abort();
    this.#listRead = undefined;
    this.#onFrame({ kind: "list", skills: (payload as SkillListResponse).skills });
  }
}
