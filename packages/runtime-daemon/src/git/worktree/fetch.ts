// The background fetch that keeps each branch's ahead and behind figures true while a session on
// the project is live. It fetches every remote of the repository, one at a time, since an older
// git passes `--no-write-fetch-head` to none of the fetches `--all` starts, and nothing more: it
// never pulls, never prunes a remote-tracking branch or tag, and leaves `FETCH_HEAD` alone, so the
// person's own next `git pull` or `git merge FETCH_HEAD` reads what they fetched themselves. It
// runs as the person, with their git config and credentials, and with no terminal, credential
// window or askpass program to prompt through, so a fetch that would need a password fails and the
// figures keep the instant they were last true. That instant is kept on the mount's row, so it
// outlives a restart, and the service's stop ends a fetch under way rather than waiting for it.
//
// The scheduler only says when a repository is due; the fetches run in a lane of their own, one at
// a time, so a remote that does not answer delays no cleanup or re-probe in the scheduler's slot.
// The lane holds each held repository at most once, and each fetch ends at git's time bound.

import type { Statement } from "better-sqlite3";

import { describeRejection } from "../../rejection.js";
import type { ScheduledJob, ScheduledJobHandle } from "../../daemon/scheduler.js";
import type { ServiceLogWriter } from "../../daemon/service-log.js";
import type { DatabaseConnections } from "../../database/connection/lifecycle.js";
import { GitProgressReader } from "../../workspace/clone/progress.js";
import {
  SHUTDOWN_STOP_GRACE_MS,
  type StreamedGitRunner,
} from "../../workspace/clone/streamed-git.js";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS, type GitCommand } from "../process.js";

// How long after one fetch of a repository ends the next begins: 180 seconds, often enough that
// the figures a person reads are minutes old at most, and rare enough that a remote is asked a
// few times an hour.
const BACKGROUND_FETCH_INTERVAL_MS = 180_000;

// No credential helper window and no askpass program on a timer; git's own environment already
// turns off its terminal prompt.
const NO_PROMPT_ENVIRONMENT: Readonly<Record<string, string>> = {
  GCM_INTERACTIVE: "never",
  SSH_ASKPASS_REQUIRE: "never",
};

// The figures' instant while the latest fetch failed: the last success, else the attach.
const COUNTS_AS_OF_SQL = `SELECT CASE WHEN fetch_failed_at IS NULL THEN NULL
                                ELSE COALESCE(fetched_at, attached_at) END AS counts_as_of
  FROM repo_mounts WHERE id = ?`;

const RECORD_FETCHED_SQL = `UPDATE repo_mounts SET fetched_at = @now, fetch_failed_at = NULL
  WHERE id = @repo_mount_id`;

const RECORD_FETCH_FAILED_SQL = `UPDATE repo_mounts SET fetch_failed_at = @now
  WHERE id = @repo_mount_id`;

/** The repository a held fetch keeps fresh. */
export interface FetchedRepository {
  readonly repoMountId: string;
  /** The repository's own checkout, where the fetch runs. */
  readonly repositoryRoot: string;
}

/** What the background fetch runs with. */
export interface BackgroundFetchDeps {
  /** Says when each repository is next due; the fetch itself runs outside its slot. */
  readonly scheduler: { schedule(job: ScheduledJob): ScheduledJobHandle };
  /** The daemon database, whose mount rows keep when each fetch last succeeded and failed. */
  readonly database: DatabaseConnections;
  /** Where a failed fetch is written. */
  readonly writeServiceLog: ServiceLogWriter;
  /** The daemon's git entry point, for the remotes listing. */
  readonly git: GitCommand;
  /** The `git` the daemon found, run streamed for each fetch. */
  readonly streamedGit: StreamedGitRunner;
  /** Wall clock for the instant a fetch ended; injectable for tests. */
  readonly now?: () => Date;
}

interface RepositoryFetchState {
  readonly repository: FetchedRepository;
  holdCount: number;
  // The instant of its next fetch, while it waits for one.
  nextFetch: ScheduledJobHandle | null;
}

/**
 * Fetches each held repository at once and then on a steady interval, one fetch at a time in its
 * own lane, and answers when each one's figures were last true.
 */
export class BackgroundFetch {
  readonly #deps: BackgroundFetchDeps;
  readonly #now: () => Date;
  readonly #selectCountsAsOf: Statement<[string], { readonly counts_as_of: string | null }>;
  readonly #stateByMount = new Map<string, RepositoryFetchState>();
  // The repositories due a fetch, in order, each at most once.
  #due: RepositoryFetchState[] = [];
  // The lane working through `#due`, while it runs.
  #lane: Promise<void> | null = null;
  // Aborted at the stop, which ends every fetch under way.
  readonly #stop = new AbortController();

  constructor(deps: BackgroundFetchDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#selectCountsAsOf = deps.database.reader.prepare(COUNTS_AS_OF_SQL);
  }

  /**
   * Keeps `repository` fetched while the returned release has not run; holds on one repository
   * share its fetches, which stop with the last release. A release run twice does nothing.
   */
  keepFresh(repository: FetchedRepository): () => void {
    let state = this.#stateByMount.get(repository.repoMountId);
    if (state === undefined) {
      state = { repository, holdCount: 0, nextFetch: null };
      this.#stateByMount.set(repository.repoMountId, state);
      this.#enqueue(state);
    }
    const held = state;
    held.holdCount += 1;
    let isReleased = false;
    return () => {
      if (isReleased) {
        return;
      }
      isReleased = true;
      held.holdCount -= 1;
      if (held.holdCount === 0) {
        held.nextFetch?.cancel();
        this.#due = this.#due.filter((due) => due !== held);
        if (this.#stateByMount.get(repository.repoMountId) === held) {
          this.#stateByMount.delete(repository.repoMountId);
        }
      }
    };
  }

  /**
   * When the mount's ahead and behind figures were last true, given only while its latest fetch
   * failed: its last successful fetch, or its attach when none has succeeded. `null` while they are
   * current.
   */
  countsAsOf(repoMountId: string): string | null {
    return this.#selectCountsAsOf.get(repoMountId)?.counts_as_of ?? null;
  }

  /** The repository's remotes, by name, as `git remote` lists them. */
  async #listRemotes(repositoryRoot: string): Promise<string[]> {
    const { stdout } = await this.#deps.git(["-C", repositoryRoot, "remote"]);
    return stdout
      .toString("utf8")
      .split("\n")
      .filter((remote) => remote.length > 0);
  }

  /** Cancels each held repository's next fetch and ends the one under way, settling once it has. */
  async stop(): Promise<void> {
    for (const state of this.#stateByMount.values()) {
      state.nextFetch?.cancel();
    }
    this.#stateByMount.clear();
    this.#due = [];
    this.#stop.abort();
    await this.#lane;
  }

  #enqueue(state: RepositoryFetchState): void {
    if (this.#stop.signal.aborted || this.#due.includes(state)) {
      return;
    }
    this.#due.push(state);
    this.#lane ??= this.#runLane();
  }

  // Fetches each due repository in turn, and schedules a still-held one's next fetch an interval
  // after this one ended. The lane is let go in the same turn it finds nothing due, so a repository
  // enqueued after that starts a new one.
  async #runLane(): Promise<void> {
    try {
      for (let state = this.#due.shift(); state !== undefined; state = this.#due.shift()) {
        const fetched = state;
        try {
          await this.#fetch(fetched.repository);
        } catch (error) {
          // No caller waits on a background fetch; the next one, an interval on, tries again.
          this.#deps.writeServiceLog(
            `The background fetch of a project's repository could not be recorded: ` +
              describeRejection(error),
          );
        }
        try {
          if (
            !this.#stop.signal.aborted &&
            this.#stateByMount.get(fetched.repository.repoMountId) === fetched
          ) {
            fetched.nextFetch = this.#deps.scheduler.schedule({
              name: "background fetch",
              delayMs: BACKGROUND_FETCH_INTERVAL_MS,
              run: async () => {
                fetched.nextFetch = null;
                this.#enqueue(fetched);
              },
            });
          }
        } catch (error) {
          // No caller waits on the lane, and the other due repositories still fetch.
          this.#deps.writeServiceLog(
            `The next background fetch of a project's repository could not be scheduled: ` +
              describeRejection(error),
          );
        }
      }
    } finally {
      this.#lane = null;
    }
  }

  async #fetch(repository: FetchedRepository): Promise<void> {
    if (this.#stop.signal.aborted) {
      return;
    }
    // The first remote's failure, which the others' fetches still run past.
    let failure: string | null = null;
    // Set when git could not be started or stopped, which a stop does not explain.
    let rejection: unknown = null;
    try {
      // One time bound for the whole fetch, however many remotes it asks.
      const signal = AbortSignal.any([
        this.#stop.signal,
        AbortSignal.timeout(DEFAULT_GIT_COMMAND_TIMEOUT_MS),
      ]);
      for (const remote of await this.#listRemotes(repository.repositoryRoot)) {
        if (signal.aborted) {
          break;
        }
        const reader = new GitProgressReader(() => undefined);
        const exit = await this.#deps.streamedGit(
          [
            "-C",
            repository.repositoryRoot,
            "fetch",
            "--no-prune",
            "--no-prune-tags",
            "--no-write-fetch-head",
            "--quiet",
            "--",
            remote,
          ],
          {
            environmentOverrides: NO_PROMPT_ENVIRONMENT,
            onStderr: (chunk) => {
              reader.read(chunk);
            },
            signal,
            // Only the stop or the time bound ends a fetch, and neither waits on it.
            stopGraceMs: () => SHUTDOWN_STOP_GRACE_MS,
          },
        );
        if (exit.exitCode !== 0) {
          failure ??=
            reader.failureLine() ?? `git ended with ${String(exit.exitCode ?? exit.signal)}`;
        }
      }
    } catch (error) {
      rejection = error;
      failure = describeRejection(error);
    }
    // A fetch the stop ended neither succeeded nor failed, unless git could not be stopped.
    if (this.#stop.signal.aborted) {
      if (rejection !== null) {
        this.#deps.writeServiceLog(
          `The background fetch of a project's repository failed as the service stopped: ` +
            describeRejection(rejection),
        );
      }
      return;
    }
    const bindings = { repo_mount_id: repository.repoMountId, now: this.#now().toISOString() };
    if (failure === null) {
      await this.#deps.database.writer.write([{ sql: RECORD_FETCHED_SQL, bindings }]);
      return;
    }
    await this.#deps.database.writer.write([{ sql: RECORD_FETCH_FAILED_SQL, bindings }]);
    this.#deps.writeServiceLog(
      `The background fetch of a project's repository failed, so its ahead and behind ` +
        `figures stay as last read: ${failure}`,
    );
  }
}
