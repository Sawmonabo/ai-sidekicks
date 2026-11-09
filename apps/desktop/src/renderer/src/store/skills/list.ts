// Every skill the background service lists, across its four origins. The feed opens with the
// first reader and closes with the last; each list it delivers replaces what is held. A lost feed
// is the store's failed state, never an empty list, which would read as no skills.

import type { SkillListEntry } from "@ai-sidekicks/contracts/skill";

import type { Unsubscribe } from "#shared/preload-api.js";

/**
 * What the app knows of the skills at one moment: `reading` until the list arrives, the list once
 * it has, or `failed` when it could not be read.
 */
export type SkillListState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly skills: readonly SkillListEntry[] }
  | { readonly status: "failed" };

/** One delivery on the skill feed: the whole list, or word that it could not be read. */
export type SkillListFrame =
  | { readonly kind: "list"; readonly skills: readonly SkillListEntry[] }
  | { readonly kind: "lost" };

/**
 * Open the service's skill feed, handing each frame on, until the handle releases it. The
 * composition supplies it, so `store/` stays below `services/`.
 */
export type SkillListFeed = (onFrame: (frame: SkillListFrame) => void) => Unsubscribe;

/** The skills read from one feed, shared by every reader while any reads. */
export class SkillListStore {
  readonly #feed: SkillListFeed;
  readonly #readers = new Set<() => void>();
  #state: SkillListState = READING;
  #release: Unsubscribe | undefined;

  public constructor(feed: SkillListFeed) {
    this.#feed = feed;
  }

  /** What readers see now: `reading` until the feed delivers its list. */
  public get state(): SkillListState {
    return this.#state;
  }

  /** Read the feed until the handle releases it, waking `onChange` each time the state moves. */
  public watch(onChange: () => void): Unsubscribe {
    this.#readers.add(onChange);
    if (this.#readers.size === 1) {
      this.#release = this.#feed((frame) => {
        this.#apply(frame);
      });
    }
    return () => {
      this.#readers.delete(onChange);
      if (this.#readers.size === 0) {
        const release = this.#release;
        this.#release = undefined;
        // A later reader opens the feed afresh, so it reads no list from before.
        this.#state = READING;
        release?.();
      }
    };
  }

  #apply(frame: SkillListFrame): void {
    this.#state = frame.kind === "list" ? { status: "served", skills: frame.skills } : FAILED;
    for (const onChange of [...this.#readers]) {
      onChange();
    }
  }
}

/** What is held before the feed delivers its list. */
const READING: SkillListState = { status: "reading" };

/** What is held once the feed is lost. */
const FAILED: SkillListState = { status: "failed" };
