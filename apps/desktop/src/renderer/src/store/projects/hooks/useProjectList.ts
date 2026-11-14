// The service's projects for as long as the caller is mounted, read from the window's one feed,
// which every view reading the list shares.

import { useSharedFeedsState } from "../../hooks/useSharedFeedsState.js";
import { projectLists, type ProjectListFeed, type ProjectListState } from "../list.js";

/**
 * Read the service's projects from `feed` for as long as the caller is mounted: `reading` until
 * the list arrives, then the list as each delivery restates it. A replaced feed reads afresh.
 */
export function useProjectList(feed: ProjectListFeed): ProjectListState {
  return useSharedFeedsState(projectLists, feed);
}
