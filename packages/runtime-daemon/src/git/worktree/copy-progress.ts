// The copies across volumes under way, one entry from a copy's start to its end, whether it
// succeeded or failed, and the streams that follow them. Each change goes whole to every stream
// that follows the copy's project. A copy is sent when it starts, on a tick four times a second
// while it runs, and once more when it ends. Each tick counts the files the copy has finished and
// what has reached the destination of the one it is copying, so one large file moves the figure
// too. The tick is one timer of that copy's, set again only once its read is done, so two reads
// never overlap and nothing runs once the copy ends.

import type { ProjectId } from "@ai-sidekicks/contracts/project";
import type {
  WorktreeCopy,
  WorktreeCopyProgress,
  WorktreeCopySubject,
} from "@ai-sidekicks/contracts/worktree/copy-progress";

import type { ServiceLogWriter } from "../../daemon/service-log.js";
import { describeRejection } from "../../rejection.js";

// Four updates a second reads as steady progress on the row, and costs the stream next to nothing.
const COPY_PROGRESS_TICK_MS = 250;

/** What a copy across volumes reports while it runs. */
export interface WorktreeCopyReport {
  /** Adds the bytes of a file the copy has finished. */
  addCopied(bytes: number): void;
  /** Ends the copy, whether it succeeded or failed: its entry goes and the list is sent at once. */
  end(): void;
}

interface CopyEntry {
  readonly subject: WorktreeCopySubject;
  readonly totalBytes: number;
  // The bytes of the files the copy has finished.
  finishedBytes: number;
  // What the last tick read of the file the copy is on.
  bytesInFlight: number;
  tickTimer: ReturnType<typeof setTimeout> | undefined;
  hasLoggedReadFailure: boolean;
}

interface CopyFollower {
  // `undefined` follows every project's copies.
  readonly projectId: ProjectId | undefined;
  readonly listener: (progress: WorktreeCopyProgress) => void;
}

/** The copies across volumes a removal or a put-back makes, while they run, and their streams. */
export class WorktreeCopiesUnderWay {
  readonly #writeServiceLog: ServiceLogWriter;
  readonly #entries = new Set<CopyEntry>();
  readonly #followers = new Set<CopyFollower>();

  constructor(deps: { readonly writeServiceLog: ServiceLogWriter }) {
    this.#writeServiceLog = deps.writeServiceLog;
  }

  /**
   * Lists a copy of `totalBytes` under way and sends the list, then on each tick adds what
   * `readBytesInFlight` answers for the file the copy is on. The copy reports its finished files
   * and its end through what this answers.
   */
  begin(
    subject: WorktreeCopySubject,
    totalBytes: number,
    readBytesInFlight: () => Promise<number>,
  ): WorktreeCopyReport {
    const entry: CopyEntry = {
      subject,
      totalBytes,
      finishedBytes: 0,
      bytesInFlight: 0,
      tickTimer: undefined,
      hasLoggedReadFailure: false,
    };
    const scheduleTick = (): void => {
      entry.tickTimer = setTimeout(() => {
        void tick();
      }, COPY_PROGRESS_TICK_MS);
      // The copy itself keeps the daemon busy; a progress update never holds it open.
      entry.tickTimer.unref();
    };
    const tick = async (): Promise<void> => {
      const finishedBefore = entry.finishedBytes;
      let bytesInFlight = 0;
      try {
        bytesInFlight = await readBytesInFlight();
      } catch (error) {
        // The figure only lags until that file is finished, so the copy goes on.
        if (!entry.hasLoggedReadFailure) {
          entry.hasLoggedReadFailure = true;
          this.#writeServiceLog(
            `A copy's progress could not read how much of a file is copied, so the figure counts ` +
              `only finished files while the read fails: ${describeRejection(error)}`,
          );
        }
      }
      if (!this.#entries.has(entry)) {
        return;
      }
      // A file finished during the read may be the one read, now counted whole.
      entry.bytesInFlight = entry.finishedBytes === finishedBefore ? bytesInFlight : 0;
      this.#publish(subject.projectId);
      scheduleTick();
    };
    this.#entries.add(entry);
    this.#publish(subject.projectId);
    scheduleTick();
    return {
      addCopied: (bytes) => {
        entry.finishedBytes += bytes;
        entry.bytesInFlight = 0;
      },
      end: () => {
        clearTimeout(entry.tickTimer);
        this.#entries.delete(entry);
        this.#publish(subject.projectId);
      },
    };
  }

  /**
   * Writes to the service log that the copy for `subject` runs without progress, as its files
   * could not be measured for a total; the copy itself goes on.
   */
  logUnmeasuredCopy(subject: WorktreeCopySubject, failure: unknown): void {
    this.#writeServiceLog(
      `The copy of ${subject.name} runs without progress, as its files could not be measured: ` +
        describeRejection(failure),
    );
  }

  /**
   * Calls `listener` with the copies under way in `projectId`, or in every project when it is
   * `undefined`, now and on every change, until the returned detach runs.
   */
  follow(
    projectId: ProjectId | undefined,
    listener: (progress: WorktreeCopyProgress) => void,
  ): () => void {
    const follower: CopyFollower = { projectId, listener };
    this.#followers.add(follower);
    listener(this.#progressIn(projectId));
    return () => {
      this.#followers.delete(follower);
    };
  }

  #publish(projectId: ProjectId): void {
    for (const follower of this.#followers) {
      if (follower.projectId === undefined || follower.projectId === projectId) {
        follower.listener(this.#progressIn(follower.projectId));
      }
    }
  }

  #progressIn(projectId: ProjectId | undefined): WorktreeCopyProgress {
    const copies: WorktreeCopy[] = [];
    for (const entry of this.#entries) {
      if (projectId === undefined || entry.subject.projectId === projectId) {
        copies.push({
          ...entry.subject,
          copiedBytes: entry.finishedBytes + entry.bytesInFlight,
          totalBytes: entry.totalBytes,
        });
      }
    }
    return { copies };
  }
}
