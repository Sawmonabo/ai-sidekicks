// The frames the repos mounts re-read on, derived from the contract's registry by namespace
// prefix and never hand-listed. `workspace.*` frames change the mount list (the section learns
// its mounts from its workspaces; a mount sends no frame of its own, and a detach arrives as
// `workspace.archived`), and `worktree.*` frames change the execution roots. Watching more kinds
// costs nothing: one transition is one request, which the scheduler coalesces.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type SessionEventType } from "@ai-sidekicks/contracts";

/** The namespaces of the two entities a session's stream announces: workspace and worktree. */
const REPO_EVENT_NAMESPACE_PREFIXES = ["workspace.", "worktree."] as const;

/**
 * Every registered lifecycle frame that names a workspace or an execution root. Derived from the
 * registry so a newly registered kind is watched automatically; it selects by namespace and
 * infers no category from a prefix. The explicit annotation is required by `isolatedDeclarations`.
 */
export const REPO_LIFECYCLE_EVENT_KINDS: readonly SessionEventType[] = [
  ...SESSION_EVENT_CATEGORY_BY_TYPE.keys(),
].filter((eventType) =>
  REPO_EVENT_NAMESPACE_PREFIXES.some((prefix) => eventType.startsWith(prefix)),
);
