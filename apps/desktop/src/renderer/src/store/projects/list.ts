// The projects on the service, as a view can know them: read off one feed per window that every
// view reading the list shares, open while any of them reads it.

import type { ProjectListEntry } from "@ai-sidekicks/contracts/project";

import type { Unsubscribe } from "#shared/preload-api.js";

/**
 * What a view knows about the service's projects at one moment. `failed` carries no cause: the
 * cause goes to diagnostic capture, and the screen says only that the list could not be read.
 */
export type ProjectListState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly projects: readonly ProjectListEntry[] }
  | { readonly status: "failed" };

/** One delivery on the project feed: the whole list as it now stands, or word it was lost. */
export type ProjectListFrame =
  | { readonly kind: "list"; readonly projects: readonly ProjectListEntry[] }
  | { readonly kind: "lost" };

/**
 * Open the service's project feed, handing each frame on, until the handle releases it. The
 * composition supplies it, held stable per window, so `store/` stays below `services/`.
 */
export type ProjectListFeed = (onFrame: (frame: ProjectListFrame) => void) => Unsubscribe;

/**
 * Every project feed being read, each folded into one state its readers share. Keyed by the feed,
 * so a superseded feed takes its state with it.
 */
export class ProjectListFeeds {
  readonly #heldByFeed = new WeakMap<ProjectListFeed, HeldProjectList>();

  /** Read `feed` until the handle releases it, waking `onChange` each time its state moves. */
  public watch(feed: ProjectListFeed, onChange: () => void): Unsubscribe {
    let held = this.#heldByFeed.get(feed);
    if (held === undefined) {
      held = new HeldProjectList(feed);
      this.#heldByFeed.set(feed, held);
    }
    return held.watch(onChange);
  }

  /** What `feed`'s readers see now: `reading` until it delivers its list. */
  public stateOf(feed: ProjectListFeed): ProjectListState {
    return this.#heldByFeed.get(feed)?.state ?? READING;
  }
}

/** The app's project lists, one per window's feed. */
export const projectListFeeds: ProjectListFeeds = new ProjectListFeeds();

/** What is held before the feed delivers its list. */
const READING: ProjectListState = { status: "reading" };

/** One feed's state and its readers, with the feed open while any reader is. */
class HeldProjectList {
  readonly #feed: ProjectListFeed;
  readonly #readers = new Set<() => void>();
  #state: ProjectListState = READING;
  #release: Unsubscribe | undefined;

  public constructor(feed: ProjectListFeed) {
    this.#feed = feed;
  }

  public get state(): ProjectListState {
    return this.#state;
  }

  public watch(onChange: () => void): Unsubscribe {
    this.#readers.add(onChange);
    if (this.#readers.size === 1) {
      this.#release = this.#feed((frame) => {
        this.#state =
          frame.kind === "list"
            ? { status: "served", projects: frame.projects }
            : { status: "failed" };
        for (const reader of [...this.#readers]) {
          reader();
        }
      });
    }
    return () => {
      this.#readers.delete(onChange);
      if (this.#readers.size === 0) {
        const release = this.#release;
        this.#release = undefined;
        this.#state = READING;
        release?.();
      }
    };
  }
}
