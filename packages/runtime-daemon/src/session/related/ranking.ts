// Each session's related list, its linked sessions scored ahead and stored under its id so a read
// is one indexed lookup. A link change re-scores, in the background after its write commits, the
// two sessions it joins and their neighbors: no other session's two-step walk crosses a changed
// share. A rename re-sends the lists that show the renamed session, since an entry reads its name
// from the session's row.

import type { Statement } from "better-sqlite3";

import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  SessionRelatedListEntry,
  SessionRelatedListUpdate,
} from "@ai-sidekicks/contracts/session/links";

import type { DatabaseConnections } from "../../database/connections.js";
import type { WriteStatement } from "../../database/statement.js";
import type { DatabaseWriter } from "../../database/writer.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import type { EventLogService } from "../../events/log-service.js";
import { SessionNotFoundError } from "../../ipc/session-errors.js";
import {
  SESSION_LINK_KIND_WEIGHT,
  scoreRelatedSessions,
  sessionLinkWeight,
  type SessionLinkEnd,
} from "./score.js";

// The most sessions one stored write replaces, so a burst of link changes never makes one huge
// write; the rest wait for the next round.
const RESCORE_ROUND_LIMIT = 64;

const LINKS_OF_SESSION_SQL = `
  SELECT target_session_id AS otherSessionId, kind, 1 AS isSource,
         use_count AS useCount, last_at AS lastAt
    FROM session_links WHERE source_session_id = @sessionId
  UNION ALL
  SELECT source_session_id AS otherSessionId, kind, 0 AS isSource,
         use_count AS useCount, last_at AS lastAt
    FROM session_links WHERE target_session_id = @sessionId`;

const STORED_RELATED_SQL = `
  SELECT related.related_session_id AS sessionId, session.name AS name
    FROM session_related AS related
    JOIN sessions AS session ON session.id = related.related_session_id
   WHERE related.session_id = ?
   ORDER BY related.score DESC, related.related_session_id`;

const REPLACE_RELATED_SQL = `
  INSERT INTO session_related (session_id, related_session_id, score)
  SELECT @sessionId, value ->> '$[0]', value ->> '$[1]' FROM json_each(@scores)`;

interface LinkEndRow {
  readonly otherSessionId: SessionId;
  readonly kind: SessionLinkEnd["kind"];
  readonly isSource: 0 | 1;
  readonly useCount: number;
  readonly lastAt: string;
}

interface StoredRelatedRow {
  readonly sessionId: SessionId;
  readonly name: string | null;
}

/** What the related ranking needs from the daemon. */
export interface SessionRelatedRankingOptions {
  readonly reader: DatabaseConnections["reader"];
  readonly writer: Pick<DatabaseWriter, "write">;
  /** The log whose committed renames re-send the lists showing the renamed session. */
  readonly events: Pick<EventLogService, "followAll">;
  /** Where a re-score that failed is reported; the next link change re-scores again. */
  readonly writeServiceLog: ServiceLogWriter;
  readonly now?: () => Date;
}

/**
 * Scores, stores and serves each session's related list. Re-scoring runs one round at a time in
 * the background, so a link verb never waits on it, and a session asked for twice before its
 * round is scored once. Renames reach followers from `start` until stopped.
 */
export class SessionRelatedRanking {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #events: Pick<EventLogService, "followAll">;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #now: () => Date;
  readonly #selectLinks: Statement<{ sessionId: string }, LinkEndRow>;
  readonly #selectStored: Statement<[string], StoredRelatedRow>;
  readonly #selectSessionExists: Statement<[string], { readonly found: 1 }>;
  readonly #followers = new Map<SessionId, Set<(update: SessionRelatedListUpdate) => void>>();
  // Sessions whose links changed since the last round; the next round queues them and their
  // neighbors in `#sessionsToScore`, each once however many changes named it.
  readonly #changedSessions = new Set<SessionId>();
  readonly #sessionsToScore = new Set<SessionId>();
  #isScoring = false;
  #idle: Promise<void> = Promise.resolve();

  constructor(options: SessionRelatedRankingOptions) {
    this.#writer = options.writer;
    this.#events = options.events;
    this.#writeServiceLog = options.writeServiceLog;
    this.#now = options.now ?? (() => new Date());
    this.#selectLinks = options.reader.prepare(LINKS_OF_SESSION_SQL);
    this.#selectStored = options.reader.prepare(STORED_RELATED_SQL);
    this.#selectSessionExists = options.reader.prepare(
      "SELECT 1 AS found FROM sessions WHERE id = ?",
    );
  }

  /** Follows every committed rename; the returned function stops it. */
  start(): () => void {
    return this.#events.followAll((event) => {
      this.#sendAfterRename(event);
    });
  }

  /**
   * Queues the sessions a committed link change joined for re-scoring, with their neighbors, and
   * returns at once.
   */
  rescoreAround(sessionIds: readonly SessionId[]): void {
    for (const sessionId of sessionIds) {
      this.#changedSessions.add(sessionId);
    }
    if (!this.#isScoring) {
      this.#isScoring = true;
      this.#idle = this.#scoreRounds();
    }
  }

  /** Resolves once every queued re-score has been stored and sent to its followers. */
  whenIdle(): Promise<void> {
    return this.#idle;
  }

  /**
   * The session's related sessions, most relevant first, each with the strongest link the pair
   * shares. Throws {@link SessionNotFoundError} for a session the daemon has no record of.
   */
  read(sessionId: SessionId): SessionRelatedListUpdate {
    if (this.#selectSessionExists.get(sessionId) === undefined) {
      throw new SessionNotFoundError(`No session ${sessionId}.`, { sessionId });
    }
    return this.#readStored(sessionId);
  }

  // A session purged since it was followed reads as an empty list.
  #readStored(sessionId: SessionId): SessionRelatedListUpdate {
    const strongestLinks = this.#strongestLinksOf(sessionId);
    const related: SessionRelatedListEntry[] = [];
    // A link removed since the last re-score keeps its stored row until the next one, and the list
    // names linked sessions only.
    for (const row of this.#selectStored.all(sessionId)) {
      const link = strongestLinks.get(row.sessionId);
      if (link === undefined) {
        continue;
      }
      related.push({
        sessionId: row.sessionId,
        ...(row.name === null ? {} : { name: row.name }),
        kind: link.strongest.kind,
        sessionIsSource: link.strongest.isSource,
        ...(link.strongest.kind === "messaged" ? { messageCount: link.strongest.useCount } : {}),
        removable: link.isRemovable,
      });
    }
    return { sessionId, related };
  }

  /**
   * Sends the session's related list to `onUpdate` now and again after each re-score of it;
   * returns the detach. Throws {@link SessionNotFoundError} for an unknown session.
   */
  follow(sessionId: SessionId, onUpdate: (update: SessionRelatedListUpdate) => void): () => void {
    const first = this.read(sessionId);
    let followers = this.#followers.get(sessionId);
    if (followers === undefined) {
      followers = new Set();
      this.#followers.set(sessionId, followers);
    }
    followers.add(onUpdate);
    onUpdate(first);
    return () => {
      const current = this.#followers.get(sessionId);
      current?.delete(onUpdate);
      if (current?.size === 0) {
        this.#followers.delete(sessionId);
      }
    };
  }

  // No caller waits on a round, so a failed one goes to the service log and the next round runs;
  // its sessions are scored again at their next link change.
  async #scoreRounds(): Promise<void> {
    while (this.#changedSessions.size > 0 || this.#sessionsToScore.size > 0) {
      try {
        const round = this.#takeRound();
        await this.#writer.write(this.#replaceStatements(round));
        this.#sendToFollowers(round);
      } catch (error) {
        this.#writeServiceLog(
          "related sessions: a re-score round failed: " +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    this.#isScoring = false;
  }

  // At most one round's worth of the queued sessions, after queuing the changed ones' neighbors;
  // the neighbors are read now, so a link removed since the change is no longer one.
  #takeRound(): SessionId[] {
    for (const sessionId of this.#changedSessions) {
      this.#sessionsToScore.add(sessionId);
      for (const link of this.#selectLinks.all({ sessionId })) {
        this.#sessionsToScore.add(link.otherSessionId);
      }
    }
    this.#changedSessions.clear();
    const round: SessionId[] = [];
    for (const sessionId of this.#sessionsToScore) {
      if (round.length === RESCORE_ROUND_LIMIT) {
        break;
      }
      this.#sessionsToScore.delete(sessionId);
      round.push(sessionId);
    }
    return round;
  }

  #replaceStatements(sessionIds: readonly SessionId[]): WriteStatement[] {
    const nowMs = this.#now().getTime();
    const linksBySession = new Map<SessionId, readonly SessionLinkEnd[]>();
    const linksOf = (sessionId: SessionId): readonly SessionLinkEnd[] => {
      let links = linksBySession.get(sessionId);
      if (links === undefined) {
        links = this.#linkEndsOf(sessionId);
        linksBySession.set(sessionId, links);
      }
      return links;
    };
    return sessionIds.flatMap((sessionId) => [
      { sql: "DELETE FROM session_related WHERE session_id = ?", bindings: [sessionId] },
      {
        sql: REPLACE_RELATED_SQL,
        bindings: {
          sessionId,
          scores: JSON.stringify([...scoreRelatedSessions(sessionId, linksOf, nowMs)]),
        },
      },
    ]);
  }

  // Each followed list that shows the renamed session is the list of a session linked to it.
  #sendAfterRename(event: EventEnvelope): void {
    if (event.type !== "session.renamed" || this.#followers.size === 0) {
      return;
    }
    const linkedSessionIds = new Set(
      this.#selectLinks.all({ sessionId: event.sessionId }).map((link) => link.otherSessionId),
    );
    this.#sendToFollowers([...linkedSessionIds]);
  }

  #sendToFollowers(sessionIds: readonly SessionId[]): void {
    for (const sessionId of sessionIds) {
      const followers = this.#followers.get(sessionId);
      if (followers === undefined) {
        continue;
      }
      const update = this.#readStored(sessionId);
      for (const onUpdate of [...followers]) {
        onUpdate(update);
      }
    }
  }

  #linkEndsOf(sessionId: SessionId): SessionLinkEnd[] {
    return this.#selectLinks
      .all({ sessionId })
      .map((row) => ({ ...row, isSource: row.isSource === 1 }));
  }

  // For each linked session, the pair's strongest link now and whether it carries a `related` one.
  #strongestLinksOf(
    sessionId: SessionId,
  ): Map<SessionId, { strongest: SessionLinkEnd; isRemovable: boolean }> {
    const nowMs = this.#now().getTime();
    const byPair = new Map<
      SessionId,
      { strongest: SessionLinkEnd; weight: number; isRemovable: boolean }
    >();
    for (const link of this.#linkEndsOf(sessionId)) {
      const weight = sessionLinkWeight(link, nowMs);
      const held = byPair.get(link.otherSessionId);
      const isRemovable = link.kind === "related" || held?.isRemovable === true;
      if (held === undefined || isStronger(link, weight, held.strongest, held.weight)) {
        byPair.set(link.otherSessionId, { strongest: link, weight, isRemovable });
      } else {
        byPair.set(link.otherSessionId, { ...held, isRemovable });
      }
    }
    return byPair;
  }
}

// The heavier link wins; at equal weight the kind with the higher base weight does.
function isStronger(
  link: SessionLinkEnd,
  weight: number,
  held: SessionLinkEnd,
  heldWeight: number,
): boolean {
  if (weight !== heldWeight) {
    return weight > heldWeight;
  }
  return SESSION_LINK_KIND_WEIGHT[link.kind] > SESSION_LINK_KIND_WEIGHT[held.kind];
}
