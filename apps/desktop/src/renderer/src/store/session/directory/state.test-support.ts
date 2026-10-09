// One session as the service's session list sends it, for suites that hand a view the list.

import type { SessionListEntry } from "@ai-sidekicks/contracts/session/directory";
import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/** The project every built project entry names; no suite reads it. */
const PROJECT_ID = "019b7892-1a00-7c31-8110-cca0117a07ff" as ProjectId;

/** When every built entry was last active and last renewed its activity. */
const LAST_ACTIVE_AT = "2026-01-01T09:00:00.000Z";

/**
 * An active, idle session on the list: a project unless `shape` says chat, named only where
 * `name` is given.
 */
export function sessionListEntry(entry: {
  readonly sessionId: string;
  readonly name?: string;
  readonly firstMessagePreview?: string;
  readonly shape?: SessionListEntry["shape"];
}): SessionListEntry {
  const common = {
    sessionId: entry.sessionId as SessionId,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.firstMessagePreview === undefined
      ? {}
      : { firstMessagePreview: entry.firstMessagePreview }),
    state: "active",
    activity: "idle",
    activityRenewedAt: LAST_ACTIVE_AT,
    muted: false,
    lastActivityAt: LAST_ACTIVE_AT,
  } as const;
  return entry.shape === "chat"
    ? { ...common, shape: "chat" }
    : { ...common, shape: "project", projectId: PROJECT_ID };
}
