// The projects on the service, as a view can know them: read off one feed per window that every
// view reading the list shares, open while any of them reads it.

import type { ProjectListEntry } from "@ai-sidekicks/contracts/project";

import { SharedFeeds, type Feed, type FeedFold } from "../shared-feed.js";

/**
 * What a view knows about the service's projects at one moment. `failed` carries no cause: the
 * cause goes to diagnostic capture, and the screen says only that the list could not be read.
 */
export type ProjectListState =
  | { readonly status: "reading" }
  | {
      readonly status: "served";
      readonly projects: readonly ProjectListEntry[];
      /** Projects the newest list held that could not be read, so it shows without them. */
      readonly droppedCount: number;
    }
  | { readonly status: "failed" };

/**
 * One delivery on the project feed: the whole list as it now stands, less the projects it held
 * that could not be read, or word it was lost.
 */
export type ProjectListFrame =
  | {
      readonly kind: "list";
      readonly projects: readonly ProjectListEntry[];
      readonly droppedCount: number;
    }
  | { readonly kind: "lost" };

/**
 * Open the service's project feed, handing each frame on, until the handle releases it. The
 * composition holds it stable per window.
 */
export type ProjectListFeed = Feed<ProjectListFrame>;

/** Reading until the list arrives, then each list, or failed once the feed is lost. */
const PROJECT_LIST_FOLD: FeedFold<ProjectListFrame, ProjectListState> = {
  initial: { status: "reading" },
  open: () => (_state, frame) =>
    frame.kind === "list"
      ? { status: "served", projects: frame.projects, droppedCount: frame.droppedCount }
      : { status: "failed" },
};

/** The app's project lists, one per window's feed, each shared by the views reading it. */
export const projectLists: SharedFeeds<ProjectListFrame, ProjectListState> = new SharedFeeds(
  PROJECT_LIST_FOLD,
);
