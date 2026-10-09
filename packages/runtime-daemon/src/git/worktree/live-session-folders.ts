// The folder each live session works in, kept watched and, for a project's repository, fetched
// while the session is live. A session is synced when the log records a change to where it works
// or whether it is live: its folder's watch and fetch are held anew when the folder moved, and the
// stream subscribers follow it there; a session no longer live lets both go.

import type { Database, Statement } from "better-sqlite3";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

import type { ServiceLogWriter } from "../../daemon/service-log.js";
import { describeRejection } from "../../rejection.js";
import { canonicalFolderPath } from "../../workspace/folder/canonical-path.js";
import type { BackgroundFetch } from "./fetch.js";
import type { SessionWorkingFolder, WorkingFolderWatcher } from "./watch.js";

// The events after which a session may work somewhere else, or stop or start being live.
const SYNCING_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.activated",
  "session.archived",
  "session.reactivated",
  "session.closed",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
  "session.swept_to_repo_root",
]);

// The session's newest workspace that has a root, on a mount still attached.
const WORKING_FOLDER_SQL = `SELECT workspace.fs_root AS folder, workspace.repo_mount_id,
       mount.canonical_root, mount.origin
  FROM workspaces AS workspace
  JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
 WHERE workspace.session_id = @session_id
   AND workspace.state IN ('ready', 'stale')
   AND workspace.fs_root IS NOT NULL
   AND mount.state = 'attached'
 ORDER BY workspace.created_at DESC, workspace.id DESC
 LIMIT 1`;

const LIVE_SESSIONS_SQL = "SELECT id FROM sessions WHERE state = 'active' ORDER BY id ASC";

const SESSION_STATE_SQL = "SELECT state FROM sessions WHERE id = @session_id";

interface WorkingFolderRow {
  readonly folder: string;
  readonly repo_mount_id: string;
  readonly canonical_root: string;
  readonly origin: string;
}

/** A session's working folder, with the repository it belongs to. */
export interface LiveSessionFolder extends SessionWorkingFolder {
  /** The repository's own checkout, which a fetch runs in. */
  readonly repositoryRoot: string;
  /** Whether the folder is a project's, whose repository is fetched; a chat's is not. */
  readonly isProject: boolean;
}

interface HeldFolder {
  // The folder's canonical key, as two holds of one folder compare.
  readonly folder: string;
  readonly releaseWatch: () => void;
  readonly releaseFetch: () => void;
}

/** What the live folders read, hold and write. */
export interface LiveSessionFoldersDeps {
  /** The read-only connection the sessions and their workspaces are read on. */
  readonly reader: Database;
  readonly watcher: Pick<WorkingFolderWatcher, "hold" | "follow">;
  readonly fetch: Pick<BackgroundFetch, "keepFresh">;
  /** Follows every session's events; `onGap` names a session whose missed events went unread. */
  readonly followAll: (
    onCommitted: (event: EventEnvelope) => void,
    onGap: (sessionId: SessionId) => void,
  ) => () => void;
  readonly writeServiceLog: ServiceLogWriter;
}

/** Holds each live session's working folder watched and its project's repository fetched. */
export class LiveSessionFolders {
  readonly #deps: LiveSessionFoldersDeps;
  readonly #selectWorkingFolder: Statement<{ session_id: string }, WorkingFolderRow>;
  readonly #selectLiveSessions: Statement<[], { readonly id: string }>;
  readonly #selectSessionState: Statement<{ session_id: string }, { readonly state: string }>;
  readonly #heldBySession = new Map<SessionId, HeldFolder>();
  // Each session's syncs run one after another, so two never hold its folder at once.
  readonly #syncBySession = new Map<SessionId, Promise<void>>();
  #detachFromLog: (() => void) | undefined;
  #isStopped = false;

  constructor(deps: LiveSessionFoldersDeps) {
    this.#deps = deps;
    this.#selectWorkingFolder = deps.reader.prepare(WORKING_FOLDER_SQL);
    this.#selectLiveSessions = deps.reader.prepare(LIVE_SESSIONS_SQL);
    this.#selectSessionState = deps.reader.prepare(SESSION_STATE_SQL);
  }

  /** The folder `sessionId` works in now, or `null` when it has none on an attached mount. */
  async readWorkingFolder(sessionId: SessionId): Promise<LiveSessionFolder | null> {
    const row = this.#selectWorkingFolder.get({ session_id: sessionId });
    if (row === undefined) {
      return null;
    }
    return {
      folder: row.folder,
      repoMountId: row.repo_mount_id,
      repositoryRoot: row.canonical_root,
      isProject: row.origin === "attached",
    };
  }

  /** Follows the log, and holds the folder of every session live now. */
  start(): void {
    this.#detachFromLog = this.#deps.followAll(
      (event) => {
        if (SYNCING_EVENT_TYPES.has(event.type)) {
          this.#sync(event.sessionId);
        }
      },
      (sessionId) => {
        this.#sync(sessionId);
      },
    );
    for (const { id } of this.#selectLiveSessions.all()) {
      this.#sync(SessionIdSchema.parse(id));
    }
  }

  /** Stops following the log, waits for the syncs under way, then lets every hold go. */
  async stop(): Promise<void> {
    this.#isStopped = true;
    this.#detachFromLog?.();
    await Promise.all(this.#syncBySession.values());
    for (const held of this.#heldBySession.values()) {
      held.releaseWatch();
      held.releaseFetch();
    }
    this.#heldBySession.clear();
  }

  #sync(sessionId: SessionId): void {
    const previous = this.#syncBySession.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(() => this.#syncNow(sessionId))
      .catch((error: unknown) => {
        // No caller waits on a sync, so its failure goes to the service log; the next sync retries.
        this.#deps.writeServiceLog(
          `Holding the working folder of session ${sessionId} failed: ${describeRejection(error)}`,
        );
      })
      .finally(() => {
        if (this.#syncBySession.get(sessionId) === next) {
          this.#syncBySession.delete(sessionId);
        }
      });
    this.#syncBySession.set(sessionId, next);
  }

  async #syncNow(sessionId: SessionId): Promise<void> {
    if (this.#isStopped) {
      return;
    }
    const isLive = this.#selectSessionState.get({ session_id: sessionId })?.state === "active";
    const target = isLive ? await this.readWorkingFolder(sessionId) : null;
    const held = this.#heldBySession.get(sessionId);
    if (target === null) {
      this.#heldBySession.delete(sessionId);
    } else {
      const folder = await canonicalFolderPath(target.folder);
      if (held?.folder === folder) {
        return;
      }
      // The new folder is held before the old one goes, so a folder both name keeps its watch.
      const releaseWatch = await this.#deps.watcher.hold(target);
      const releaseFetch = target.isProject
        ? this.#deps.fetch.keepFresh({
            repoMountId: target.repoMountId,
            repositoryRoot: target.repositoryRoot,
          })
        : () => {};
      this.#heldBySession.set(sessionId, { folder, releaseWatch, releaseFetch });
    }
    held?.releaseWatch();
    held?.releaseFetch();
    if (target !== null) {
      await this.#deps.watcher.follow(sessionId);
    }
  }
}
