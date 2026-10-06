// One session as the service's session list sends it, for suites that hand a view the list.

import type { SessionListEntry } from "@ai-sidekicks/contracts/session/directory";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/** A project's mount every built entry names; no suite reads it. */
const REPO_MOUNT_ID = "019b7892-1a00-7c31-8110-cca0117a07ff" as RepoMountId;

/** When every built entry was last active and last renewed its activity. */
const LAST_ACTIVE_AT = "2026-01-01T09:00:00.000Z";

/**
 * An active, idle session on the list: a project unless `shape` says chat, named only where
 * `name` is given.
 */
export function sessionListEntry(entry: {
  readonly sessionId: string;
  readonly name?: string;
  readonly shape?: SessionListEntry["shape"];
}): SessionListEntry {
  const common = {
    sessionId: entry.sessionId as SessionId,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    state: "active",
    activity: "idle",
    activityRenewedAt: LAST_ACTIVE_AT,
    muted: false,
    lastActivityAt: LAST_ACTIVE_AT,
  } as const;
  return entry.shape === "chat"
    ? { ...common, shape: "chat", documentCount: 0 }
    : { ...common, shape: "project", repoMountId: REPO_MOUNT_ID };
}
