// Git's progress as the clone card shows it: what git writes to stderr read line by line, and the
// gate that lets at most four of the card's updates through a second, the latest winning.

import {
  REPO_CLONE_LINE_MAX_LEN,
  type RepoCloneProgress,
} from "@ai-sidekicks/contracts/repo/clone";

/** The least time between two updates the card receives: four a second. */
export const CLONE_UPDATE_INTERVAL_MS = 250;

// `Receiving objects:  42% (420/1000)`, `remote: Counting objects: 100% (8/8), done.` and Git LFS's
// `Downloading LFS objects:  50% (1/2), 4 KB | 0 B/s`.
const PROGRESS_LINE = /^(?:remote: )?([^:]+):\s+(\d{1,3})%/;

// Git's own failure lines.
const ERROR_LINE = /^(?:fatal|error): /;

// The longest unfinished line kept while git has not ended it; past this it is cut, so a stream
// with no line break never grows the daemon's memory.
const PENDING_TEXT_MAX_LEN = 4 * REPO_CLONE_LINE_MAX_LEN;

/**
 * Reads git's stderr for the clone card: the latest progress, and the line a failure is told with.
 * Git redraws a progress line with a carriage return, so a line ends at either break. Only the
 * newest lines are held.
 */
export class GitProgressReader {
  readonly #onProgress: (progress: RepoCloneProgress) => void;
  #pendingText = "";
  #lastErrorLine: string | null = null;
  #lastLine: string | null = null;

  constructor(onProgress: (progress: RepoCloneProgress) => void) {
    this.#onProgress = onProgress;
  }

  /** Reads one chunk of git's stderr. */
  read(chunk: string): void {
    const lines = (this.#pendingText + chunk).split(/\r|\n/);
    this.#pendingText = (lines.pop() ?? "").slice(-PENDING_TEXT_MAX_LEN);
    for (const line of lines) {
      this.#readLine(line);
    }
  }

  /**
   * The line a failure is told with once git has exited: git's last `fatal:` or `error:` line,
   * else its last line, else `null` when git wrote nothing.
   */
  failureLine(): string | null {
    this.#readLine(this.#pendingText);
    this.#pendingText = "";
    return this.#lastErrorLine ?? this.#lastLine;
  }

  #readLine(rawLine: string): void {
    const line = rawLine.trim().slice(0, REPO_CLONE_LINE_MAX_LEN);
    if (line === "") return;
    this.#lastLine = line;
    if (ERROR_LINE.test(line)) {
      this.#lastErrorLine = line;
      return;
    }
    const match = PROGRESS_LINE.exec(line);
    if (match === null) return;
    const [, phase = "", percent = "0"] = match;
    this.#onProgress({ phase: phase.trim(), percent: Math.min(100, Number(percent)) });
  }
}

/**
 * Lets an update through at most once per {@link CLONE_UPDATE_INTERVAL_MS}: an update arriving
 * sooner waits for the interval to close, and a newer one replaces it while it waits, so nothing
 * is queued and the last update always arrives.
 */
export class LatestUpdateGate<Update> {
  readonly #send: (update: Update) => void;
  readonly #now: () => number;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  #waiting: { readonly update: Update } | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(send: (update: Update) => void, now: () => number = () => performance.now()) {
    this.#send = send;
    this.#now = now;
  }

  /** Sends `update` now if the interval allows, else holds it as the one update waiting. */
  offer(update: Update): void {
    this.#waiting = { update };
    if (this.#timer !== undefined) return;
    const wait = this.#lastSentAt + CLONE_UPDATE_INTERVAL_MS - this.#now();
    if (wait <= 0) {
      this.#sendWaiting();
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#sendWaiting();
    }, wait);
  }

  /** Drops the update waiting, if any, and its timer; nothing more is sent until the next offer. */
  close(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#waiting = undefined;
  }

  #sendWaiting(): void {
    const waiting = this.#waiting;
    if (waiting === undefined) return;
    this.#waiting = undefined;
    this.#lastSentAt = this.#now();
    this.#send(waiting.update);
  }
}
