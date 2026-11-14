// Every skill the background service lists, across its four origins. Each list the feed delivers
// replaces what is held. A lost feed is the store's failed state, never an empty list, which would
// read as no skills.

import type { SkillListEntry } from "@ai-sidekicks/contracts/skill";

import { SharedFeed, type Feed, type FeedFold } from "../shared-feed.js";

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

/** Open the service's skill feed, handing each frame on, until the handle releases it. */
export type SkillListFeed = Feed<SkillListFrame>;

/** The skills read from one feed, shared by every reader while any reads. */
export class SkillListStore extends SharedFeed<SkillListFrame, SkillListState> {
  public constructor(feed: SkillListFeed) {
    super(feed, SKILL_LIST_FOLD);
  }
}

/** Reading until the list arrives, then each list, or failed once the feed is lost. */
const SKILL_LIST_FOLD: FeedFold<SkillListFrame, SkillListState> = {
  initial: { status: "reading" },
  open: () => (_state, frame) =>
    frame.kind === "list" ? { status: "served", skills: frame.skills } : { status: "failed" },
};
