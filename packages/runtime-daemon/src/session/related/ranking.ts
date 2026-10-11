// Each session's related list, its linked sessions scored ahead and stored under its id so a read
// is one indexed lookup. A link change re-scores, in the background after its write commits, the
// two sessions it joins and their neighbors: no other session's two-step walk crosses a changed
// share. Scoring yields to the event loop whenever it has held the thread for a slice, so a round
// never stalls the daemon's other work. A rename re-sends the lists that show the renamed session,
// since an entry reads its name from the session's row, and so does a gap in a session's events,
// which could have hidden a rename.

import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type { Statement } from "better-sqlite3";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  SessionRelatedListEntry,
  SessionRelatedListUpdate,
} from "@ai-sidekicks/contracts/session/links";

import type { DatabaseConnections } from "../../database/connection/lifecycle.js";
import type { WriteStatement } from "../../database/statement.js";
import type { DatabaseWriter } from "../../database/writer.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import type { EventLogService } from "../../events/log-service.js";
import { retryWaitMs } from "../../retry-waits.js";
import { SESSION_EXISTS_SQL } from "../directory/lookups.js";
import { sessionNotFound } from "../not-found.js";
import {
  SESSION_LINK_KIND_WEIGHT,
  scoreRelatedSessions,
  sessionLinkWeight,
  type SessionLinkEnd,
} from "./score.js";
import { describeRejection } from "../../rejection.js";

// The most sessions one stored write replaces, so a burst of link changes never makes one huge
// write; the rest wait for the next round.
const RESCORE_ROUND_LIMIT = 64;

// How long a round holds the main thread before it yields a turn of the event loop. One turn can
// run two slices, the one a write's reply resumes and the one its yield runs next, so each stays
// well inside the main thread's 5 ms.
const SCORING_SLICE_MS = 1;

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

// A session purged while its round was scored is gone from `sessions` by the time the round's
// write runs, so the write stores no list for it and no entry naming it, and the purge leaves no
// row behind.
const REPLACE_RELATED_SQL = `
  INSERT INTO session_related (session_id, related_session_id, score)
  SELECT @sessionId, scored.value ->> '$[0]', scored.value ->> '$[1]'
    FROM json_each(@scores) AS scored
    JOIN sessions AS related ON related.id = scored.value ->> '$[0]'
   WHERE EXISTS (SELECT 1 FROM sessions WHERE id = @sessionId)`;

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
export interface SessionRelatedRankingDeps {
  readonly reader: DatabaseConnections["reader"];
  readonly writer: Pick<DatabaseWriter, "write">;
  /**
   * The log whose committed renames, and the gaps that could hide one, re-send the lists showing
   * the session.
   */
  readonly events: Pick<EventLogService, "followAll">;
  /**
   * Where a re-score round that failed, and is retried after a wait, or a follower that threw, is
   * reported.
   */
  readonly writeServiceLog: ServiceLogWriter;
  readonly now?: () => Date;
}

/**
 * Scores, stores and serves each session's related list. Re-scoring runs one round at a time in
 * the background, so a link verb never waits on it, and a session asked for twice before its
 * round is scored once. Renames reach followers from `start` until its stop, which also ends the
 * re-scoring.
 */
export class SessionRelatedRanking {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #events: Pick<EventLogService, "followAll">;
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #now: () => Date;
  readonly #selectLinks: Statement<{ sessionId: string }, LinkEndRow>;
  readonly #selectStored: Statement<[string], StoredRelatedRow>;
  readonly #selectSessionExists: Statement<{ sessionId: string }, unknown>;
  readonly #followers = new Map<SessionId, Set<(update: SessionRelatedListUpdate) => void>>();
  // Sessions whose links changed since the last round; the next round queues them and their
  // neighbors in `#sessionsToScore`, each once however many changes named it.
  readonly #changedSessions = new Set<SessionId>();
  readonly #sessionsToScore = new Set<SessionId>();
  #isScoring = false;
  #isStopped = false;
  #idle: Promise<void> = Promise.resolve();
  // Failed rounds in a row, which pick the wait before the next retry.
  #failedRoundsInRow = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: SessionRelatedRankingDeps) {
    this.#writer = deps.writer;
    this.#events = deps.events;
    this.#writeServiceLog = deps.writeServiceLog;
    this.#now = deps.now ?? (() => new Date());
    this.#selectLinks = deps.reader.prepare(LINKS_OF_SESSION_SQL);
    this.#selectStored = deps.reader.prepare(STORED_RELATED_SQL);
    this.#selectSessionExists = deps.reader.prepare(SESSION_EXISTS_SQL);
  }

  /**
   * Follows every committed rename until the returned stop runs. The stop also ends re-scoring
   * after the round under way, drops a retry still waiting, and resolves once that round's write
   * and sends are done.
   */
  start(): () => Promise<void> {
    const unfollow = this.#events.followAll(
      (event) => {
        if (event.type === "session.renamed") {
          this.#sendListsShowing(event.sessionId);
        }
      },
      (sessionId) => {
        this.#sendListsShowing(sessionId);
      },
    );
    return () => {
      unfollow();
      this.#isStopped = true;
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
      return this.#idle;
    };
  }

  /**
   * Queues the sessions a committed link change joined for re-scoring, with their neighbors, and
   * returns at once.
   */
  rescoreAround(sessionIds: readonly SessionId[]): void {
    for (const sessionId of sessionIds) {
      this.#changedSessions.add(sessionId);
    }
    this.#startScoring();
  }

  /**
   * Resolves once the re-scoring under way has ended: every queued session stored and sent, or a
   * failed round reported and its retry set, or the stop reached.
   */
  whenIdle(): Promise<void> {
    return this.#idle;
  }

  /**
   * The session's related sessions, most relevant first, each with the strongest link the pair
   * shares. Throws `session.not_found` for a session the daemon has no record of.
   */
  read(sessionId: SessionId): SessionRelatedListUpdate {
    if (this.#selectSessionExists.get({ sessionId }) === undefined) {
      throw sessionNotFound(sessionId);
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
   * returns the detach. Throws `session.not_found` for an unknown session.
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

  // A change or a due retry starts the rounds now, unless they are under way or stopped.
  #startScoring(): void {
    if (this.#isScoring || this.#isStopped) {
      return;
    }
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#isScoring = true;
    this.#idle = this.#scoreRounds();
  }

  // No caller waits on a round, so a failed one goes to the service log and ends the rounds; its
  // sessions stay queued and are retried after a wait, or sooner with the next link change's.
  async #scoreRounds(): Promise<void> {
    try {
      while (
        !this.#isStopped &&
        (this.#changedSessions.size > 0 || this.#sessionsToScore.size > 0)
      ) {
        const slice = new ScoringSlice();
        const round = await this.#takeRound(slice);
        try {
          await this.#writer.write(await this.#replaceStatements(round, slice));
        } catch (error) {
          for (const sessionId of round) {
            this.#sessionsToScore.add(sessionId);
          }
          throw error;
        }
        this.#failedRoundsInRow = 0;
        this.#sendToFollowers(round);
      }
    } catch (error) {
      const waitMs = retryWaitMs(this.#failedRoundsInRow);
      this.#failedRoundsInRow += 1;
      this.#writeServiceLog(
        `related sessions: a re-score round failed, retrying in ${String(waitMs)} ms: ` +
          describeRejection(error),
      );
      this.#retryLater(waitMs);
    } finally {
      this.#isScoring = false;
    }
  }

  // Unref'd, so a retry still waiting never keeps the process alive.
  #retryLater(waitMs: number): void {
    if (this.#isStopped) {
      return;
    }
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#startScoring();
    }, waitMs);
    this.#retryTimer.unref();
  }

  // At most one round's worth of the queued sessions, after queuing the changed ones' neighbors;
  // the neighbors are read now, so a link removed since the change is no longer one. A changed
  // session leaves its set only once its neighbors are queued.
  async #takeRound(slice: ScoringSlice): Promise<SessionId[]> {
    for (const sessionId of this.#changedSessions) {
      await slice.yieldWhenSpent();
      this.#sessionsToScore.add(sessionId);
      for (const link of this.#selectLinks.all({ sessionId })) {
        this.#sessionsToScore.add(link.otherSessionId);
      }
      this.#changedSessions.delete(sessionId);
    }
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

  async #replaceStatements(
    sessionIds: readonly SessionId[],
    slice: ScoringSlice,
  ): Promise<WriteStatement[]> {
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
    const statements: WriteStatement[] = [];
    for (const sessionId of sessionIds) {
      await slice.yieldWhenSpent();
      // The walk reads each neighbor's links too, one read between yields, so one session's walk
      // never holds the thread past a slice; scoring then reads only what these reads kept.
      for (const link of linksOf(sessionId)) {
        await slice.yieldWhenSpent();
        linksOf(link.otherSessionId);
      }
      statements.push(
        { sql: "DELETE FROM session_related WHERE session_id = ?", bindings: [sessionId] },
        {
          sql: REPLACE_RELATED_SQL,
          bindings: {
            sessionId,
            scores: JSON.stringify([...scoreRelatedSessions(sessionId, linksOf, nowMs)]),
          },
        },
      );
    }
    return statements;
  }

  // Each followed list that shows a session is the list of a session linked to it.
  #sendListsShowing(sessionId: SessionId): void {
    if (this.#followers.size === 0) {
      return;
    }
    const linkedSessionIds = new Set(
      this.#selectLinks.all({ sessionId }).map((link) => link.otherSessionId),
    );
    this.#sendToFollowers([...linkedSessionIds]);
  }

  // Each list is read and sent on its own, so one that fails, or a follower that throws, costs no
  // other list or follower its update.
  #sendToFollowers(sessionIds: readonly SessionId[]): void {
    for (const sessionId of sessionIds) {
      const followers = this.#followers.get(sessionId);
      if (followers === undefined) {
        continue;
      }
      let update: SessionRelatedListUpdate;
      try {
        update = this.#readStored(sessionId);
      } catch (error) {
        this.#reportSendFailure(`reading session ${sessionId}'s list`, error);
        continue;
      }
      for (const onUpdate of [...followers]) {
        try {
          onUpdate(update);
        } catch (error) {
          this.#reportSendFailure(`sending session ${sessionId}'s list to a follower`, error);
        }
      }
    }
  }

  #reportSendFailure(what: string, error: unknown): void {
    this.#writeServiceLog(`related sessions: ${what} failed: ${describeRejection(error)}`);
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

// The main thread time a round has held since it last yielded.
class ScoringSlice {
  #startedAt = performance.now();

  /** Yields a turn of the event loop once the round has held the thread for a whole slice. */
  async yieldWhenSpent(): Promise<void> {
    if (performance.now() - this.#startedAt >= SCORING_SLICE_MS) {
      await yieldToEventLoop();
      this.#startedAt = performance.now();
    }
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
