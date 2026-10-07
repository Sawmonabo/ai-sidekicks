// The live sessions list: every session's entry held in memory while a `session.list`
// subscription is open, read once from the `sessions` rows and then kept current one session at a
// time, never by a rescan.
//
// - Events reach the feed through the log's all-sessions follow, attached for the feed's whole
//   life so no append in flight at the first open is missed. A service that changes a list fact
//   without an event calls `refresh` after its write commits. Either way only the named sessions'
//   rows are read again, once per turn of the event loop however many events named them.
// - A session with no row has no entry: only `session.created` writes one, so a session the person
//   runs in their own terminal never has one, and a purge, which deletes the row, removes the
//   entry. A project session whose project is not known yet (its workspace is not bound) shows
//   no entry until it is.
// - While a session's activity is `running` or `waiting` its entry is published again every
//   renewal interval, by one timer for the whole list that runs only while such a session and a
//   subscriber exist, so a reader can tell a live reading from one a stopped daemon left behind.

import { isDeepStrictEqual } from "node:util";

import type { Database, Statement } from "better-sqlite3";

import type {
  EventCompactedEvent,
  EventCompactedPayload,
} from "@ai-sidekicks/contracts/event/declared-variants";
import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  type EventEnvelope,
} from "@ai-sidekicks/contracts/event/envelope";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import {
  SESSION_ACTIVITY_RENEW_INTERVAL_MS,
  type SessionListChange,
  type SessionListEntry,
} from "@ai-sidekicks/contracts/session/directory";
import type { SessionGroupId } from "@ai-sidekicks/contracts/session/groups";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionShape, SessionState } from "@ai-sidekicks/contracts/session/methods";

import type { EventLogService } from "../../events/log-service.js";
import type { LiveRunActivity, SessionRunOutcome } from "../records.js";
import { sessionProjectSql } from "./lookups.js";
import { sessionActivityOf } from "./run-activity.js";

/** What the feed reads and follows. */
export interface SessionListFeedDeps {
  /** The read-only connection the `sessions` rows are read on. */
  readonly reader: Database;
  /** The log whose committed events tell the feed which sessions changed. */
  readonly eventLog: Pick<EventLogService, "followAll">;
}

/** A change to one entry of the list: what the feed publishes once a listener has the list. */
export type SessionListEntryChange = Exclude<SessionListChange, { kind: "page" }>;

/**
 * One open subscription's side of the feed. Neither callback may throw: they run on the feed's
 * own turns, where no caller would receive the failure.
 */
export interface SessionListListener {
  /** One change to the list, in the order the feed made them. */
  onChange(change: SessionListEntryChange): void;
  /** The feed could not read a change; the listener is detached and hears nothing more. */
  onFailure(error: unknown): void;
}

/** The list as it stands when a listener opens it, and the detach that closes it. */
export interface SessionListOpening {
  readonly sessions: SessionListEntry[];
  readonly chatCount: number;
  readonly detach: () => void;
}

// The purge's receipt, which names every session whose rows it deleted.
const PURGE_RECEIPT_TYPE = "event.compacted" satisfies EventCompactedEvent["type"];

// States that put a chat outside the live list, so the Chats header does not count it.
const UNCOUNTED_CHAT_STATES: ReadonlySet<SessionState> = new Set([
  "archived",
  "closed",
  "purge_requested",
]);

// One session's list facts as one query returns them, its group's name among them.
const SESSION_LIST_ROW_SQL = `SELECT s.id, s.shape, s.state, s.name, s.first_message_preview,
       s.branch, s.pinned_at, s.muted_at, s.last_run_outcome, s.last_activity_at,
       s.document_count, g.id AS group_id, g.name AS group_name,
       ${sessionProjectSql("s.id")} AS repo_mount_id,
       (SELECT json_group_object(r.run_id, r.activity)
          FROM session_run_activity r
         WHERE r.session_id = s.id) AS live_runs
  FROM sessions s LEFT JOIN session_groups g ON g.id = s.group_id`;

// A session's group comes from the join, so its id and name are present or absent together.
type SessionListRow = {
  readonly id: string;
  readonly shape: SessionShape;
  readonly state: SessionState;
  readonly name: string | null;
  readonly first_message_preview: string | null;
  readonly branch: string | null;
  readonly pinned_at: string | null;
  readonly muted_at: string | null;
  readonly last_run_outcome: SessionRunOutcome;
  readonly last_activity_at: string;
  readonly document_count: number;
  readonly repo_mount_id: string | null;
  /** A JSON object of the session's live runs, run id to activity. */
  readonly live_runs: string;
} & (
  | { readonly group_id: null; readonly group_name: null }
  | { readonly group_id: string; readonly group_name: string }
);

/**
 * The daemon's one live sessions list. Built from the `sessions` rows when the first listener
 * opens it and dropped when the last one detaches; {@link SessionListFeed.close} detaches it
 * from the log.
 */
export class SessionListFeed {
  readonly #readAll: Statement<[], SessionListRow>;
  readonly #readSome: Statement<[string], SessionListRow>;
  readonly #listeners = new Set<SessionListListener>();
  readonly #detachFromLog: () => void;
  // Present exactly while a listener is open.
  #entries: Map<string, SessionListEntry> | undefined;
  #chatCount = 0;
  // Sessions whose activity is renewed: those `running` or `waiting`.
  readonly #renewedSessionIds = new Set<string>();
  readonly #changedSessionIds = new Set<string>();
  #pendingRead: ReturnType<typeof setImmediate> | undefined;
  #renewTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: SessionListFeedDeps) {
    this.#readAll = deps.reader.prepare(SESSION_LIST_ROW_SQL);
    this.#readSome = deps.reader.prepare(
      `${SESSION_LIST_ROW_SQL} WHERE s.id IN (SELECT value FROM json_each(?))`,
    );
    this.#detachFromLog = deps.eventLog.followAll((event) => {
      this.#noteCommitted(event);
    });
  }

  /**
   * Opens the list for `listener`: every entry as it stands, the chats count, and the detach.
   * Every change the feed publishes from then on reaches the listener, so one still being read
   * when the snapshot was taken arrives after it as an upsert. Throws what the first read threw,
   * with nothing opened.
   */
  open(listener: SessionListListener): SessionListOpening {
    const entries = this.#entries ?? this.#build();
    this.#listeners.add(listener);
    this.#syncRenewTimer();
    const renewedAt = new Date().toISOString();
    return {
      sessions: [...entries.values()].map((entry) =>
        this.#renewedSessionIds.has(entry.sessionId)
          ? { ...entry, activityRenewedAt: renewedAt }
          : entry,
      ),
      chatCount: this.#chatCount,
      detach: () => {
        this.#detach(listener);
      },
    };
  }

  /**
   * Reads those sessions' rows again and publishes an upsert for each that changed, or a removal
   * for one whose row is gone. For a list fact a service writes without an event, called after
   * the write commits; nothing is read while no listener is open.
   */
  refresh(sessionIds: readonly SessionId[]): void {
    for (const sessionId of sessionIds) {
      this.#noteChanged(sessionId);
    }
  }

  /**
   * Stops following the log and ends the renewals, for the daemon's shutdown: open listeners hear
   * nothing more, and the feed takes no listener after this.
   */
  close(): void {
    this.#detachFromLog();
    for (const listener of [...this.#listeners]) {
      this.#detach(listener);
    }
  }

  #build(): Map<string, SessionListEntry> {
    const entries = new Map<string, SessionListEntry>();
    const renewedAt = new Date().toISOString();
    let chatCount = 0;
    for (const row of this.#readAll.all()) {
      const entry = entryOf(row, renewedAt);
      if (entry === undefined) continue;
      entries.set(entry.sessionId, entry);
      chatCount += countsAsChat(entry);
      if (isRenewed(entry)) this.#renewedSessionIds.add(entry.sessionId);
    }
    this.#entries = entries;
    this.#chatCount = chatCount;
    return entries;
  }

  #detach(listener: SessionListListener): void {
    if (!this.#listeners.delete(listener) || this.#listeners.size > 0) {
      this.#syncRenewTimer();
      return;
    }
    // Nobody reads the list now; the next open reads it again from the rows.
    this.#entries = undefined;
    this.#chatCount = 0;
    this.#renewedSessionIds.clear();
    this.#changedSessionIds.clear();
    if (this.#pendingRead !== undefined) {
      clearImmediate(this.#pendingRead);
      this.#pendingRead = undefined;
    }
    this.#syncRenewTimer();
  }

  #noteCommitted(event: EventEnvelope): void {
    if (event.type === PURGE_RECEIPT_TYPE) {
      // The receipt's payload passed its variant's parse on the way in.
      const receipt = event.payload as unknown as EventCompactedPayload;
      for (const removed of receipt.removedSessions) {
        this.#noteChanged(removed.sessionId);
      }
      return;
    }
    // The machine's own scope has no row.
    if (event.sessionId !== DAEMON_SCOPE_SENTINEL_SESSION_ID) {
      this.#noteChanged(event.sessionId);
    }
  }

  // Changes named in one turn are read together on the next, so a burst of events reads each
  // session's row once.
  #noteChanged(sessionId: string): void {
    if (this.#entries === undefined) return;
    this.#changedSessionIds.add(sessionId);
    this.#pendingRead ??= setImmediate(() => {
      this.#pendingRead = undefined;
      this.#readChanged();
    });
  }

  #readChanged(): void {
    const entries = this.#entries;
    if (entries === undefined) return;
    const sessionIds = [...this.#changedSessionIds];
    this.#changedSessionIds.clear();
    let rows: SessionListRow[];
    try {
      rows = this.#readSome.all(JSON.stringify(sessionIds));
    } catch (error) {
      this.#fail(error);
      return;
    }
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const renewedAt = new Date().toISOString();
    for (const sessionId of sessionIds) {
      // A listener that ended on a change can take the list down with it.
      if (this.#entries !== entries) return;
      const row = rowById.get(sessionId);
      const held = entries.get(sessionId);
      if (row === undefined) {
        if (held !== undefined) this.#remove(entries, held);
        continue;
      }
      const entry = entryOf(row, renewedAt);
      // A project whose workspace is not bound yet keeps what it showed: only a purge removes.
      if (entry !== undefined && !isSameEntry(held, entry)) this.#upsert(entries, held, entry);
    }
    this.#syncRenewTimer();
  }

  #upsert(
    entries: Map<string, SessionListEntry>,
    held: SessionListEntry | undefined,
    entry: SessionListEntry,
  ): void {
    entries.set(entry.sessionId, entry);
    this.#chatCount += countsAsChat(entry) - (held === undefined ? 0 : countsAsChat(held));
    if (isRenewed(entry)) {
      this.#renewedSessionIds.add(entry.sessionId);
    } else {
      this.#renewedSessionIds.delete(entry.sessionId);
    }
    this.#publish({ kind: "upsert", entry, chatCount: this.#chatCount });
  }

  #remove(entries: Map<string, SessionListEntry>, held: SessionListEntry): void {
    entries.delete(held.sessionId);
    this.#renewedSessionIds.delete(held.sessionId);
    this.#chatCount -= countsAsChat(held);
    this.#publish({ kind: "remove", sessionId: held.sessionId, chatCount: this.#chatCount });
  }

  #publish(change: SessionListEntryChange): void {
    for (const listener of this.#listeners) {
      listener.onChange(change);
    }
  }

  // No held list is current any more: every listener is detached and told, and the next open
  // reads the rows again.
  #fail(error: unknown): void {
    console.error("[session.list] reading a changed session's row failed", error);
    const listeners = [...this.#listeners];
    for (const listener of listeners) {
      this.#detach(listener);
    }
    for (const listener of listeners) {
      listener.onFailure(error);
    }
  }

  #syncRenewTimer(): void {
    const isNeeded = this.#listeners.size > 0 && this.#renewedSessionIds.size > 0;
    if (isNeeded && this.#renewTimer === undefined) {
      this.#renewTimer = setInterval(() => {
        this.#renew();
      }, SESSION_ACTIVITY_RENEW_INTERVAL_MS);
    } else if (!isNeeded && this.#renewTimer !== undefined) {
      clearInterval(this.#renewTimer);
      this.#renewTimer = undefined;
    }
  }

  #renew(): void {
    const entries = this.#entries;
    if (entries === undefined) return;
    const renewedAt = new Date().toISOString();
    for (const sessionId of this.#renewedSessionIds) {
      const held = entries.get(sessionId);
      if (held === undefined) continue;
      const entry = { ...held, activityRenewedAt: renewedAt };
      entries.set(sessionId, entry);
      this.#publish({ kind: "upsert", entry, chatCount: this.#chatCount });
    }
  }
}

// The row as an entry, or `undefined` for a project session whose project is not known yet.
function entryOf(row: SessionListRow, renewedAt: string): SessionListEntry | undefined {
  const liveRuns = new Map(
    Object.entries(JSON.parse(row.live_runs) as Record<string, LiveRunActivity>),
  );
  const common = {
    sessionId: row.id as SessionId,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.first_message_preview === null
      ? {}
      : { firstMessagePreview: row.first_message_preview }),
    state: row.state,
    activity: sessionActivityOf({ liveRuns, lastRunOutcome: row.last_run_outcome }),
    activityRenewedAt: renewedAt,
    ...(row.pinned_at === null ? {} : { pinnedAt: row.pinned_at }),
    muted: row.muted_at !== null,
    lastActivityAt: row.last_activity_at,
  };
  if (row.shape === "chat") {
    return { ...common, shape: "chat", documentCount: row.document_count };
  }
  if (row.repo_mount_id === null) return undefined;
  return {
    ...common,
    shape: "project",
    repoMountId: row.repo_mount_id as RepoMountId,
    ...(row.branch === null ? {} : { branch: row.branch }),
    ...(row.group_id === null
      ? {}
      : { group: { groupId: row.group_id as SessionGroupId, name: row.group_name } }),
  };
}

// Whether two entries say the same thing; a new renewal stamp alone is no change.
function isSameEntry(held: SessionListEntry | undefined, entry: SessionListEntry): boolean {
  return (
    held !== undefined &&
    isDeepStrictEqual({ ...held, activityRenewedAt: "" }, { ...entry, activityRenewedAt: "" })
  );
}

function isRenewed(entry: SessionListEntry): boolean {
  return entry.activity === "running" || entry.activity === "waiting";
}

// 1 for a chat the Chats header counts, else 0.
function countsAsChat(entry: SessionListEntry): number {
  return entry.shape === "chat" && !UNCOUNTED_CHAT_STATES.has(entry.state) ? 1 : 0;
}
