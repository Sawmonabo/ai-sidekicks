// When the artifact pane reads again, and which round a completion belongs to.
//
// Split from `artifact-reader.ts`: deciding when to read is this module's, and holding
// what a surface renders and what it can act on is the reader's. Nothing here knows what
// a reading means; the two abstract members below touch one and the subclass answers them.
//
// A base class rather than a composed object, because the reading a surface holds has to
// be the class that carries the scheduler and the trigger contract. The two abstract
// members are methods rather than closures in the options, because a subclass cannot
// write `publish: (reading) => this.#publish(reading)` inside its own `super()` call.
//
// No timer and no poll. The read runs once when the pane mounts and again when the user
// asks, and both go through the console's one `RefreshScheduler`: a burst of presses
// coalesces into one read, reads never overlap, and every completion carries a generation
// stamp, so a completion that is no longer current is dropped instead of overwriting a
// newer answer. Window focus, reconnect and the terminal events of the session's artifacts
// reach the same scheduler through `SessionRefreshTriggers`. The kinds are the artifact
// frames in `ARTIFACT_TERMINAL_EVENT_KINDS`; a `workspace.stale` frame is a fact about a
// workspace and no evidence about this session's artifacts.
//
// A rejected list call is not caught here: with no `onError`, the scheduler re-throws it.

import type { ConsoleClock } from "@renderer/lib/clock.js";
import {
  GenerationLatch,
  type CurrentGenerationClaim,
} from "@renderer/lib/reads/generation-latch.js";
import { RefreshScheduler, type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import { SessionRefreshTriggers } from "@renderer/store/reads/session-refresh-triggers.js";
import { type ReadTriggerTarget } from "@renderer/store/reads/read-triggers.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { ARTIFACT_TERMINAL_EVENT_KINDS } from "@renderer/console/repos/repo-lifecycle-events.js";
import { settledReadReading, type ArtifactPaneReading } from "./artifact-list-reading.js";
import { readArtifactList, type ListArtifacts } from "./services/artifact-reads.js";

/**
 * The one key this pane's scheduled read is claimed under.
 *
 * One key and not one per artifact, because a scheduled read re-reads the whole list:
 * there is a single round in flight at a time, and every act comparing against it asks the
 * same question.
 */
const SCHEDULED_READ_KEY = "scheduled-read";

/** What the artifact read schedule is given to list a session's manifests. */
export interface ArtifactReadScheduleOptions {
  /** The call that lists the session's artifact manifests. */
  readonly listArtifacts: ListArtifacts;
  /**
   * The session to read, and three of the four reasons to read again.
   *
   * The store rather than a bare session id, because the artifact frames and the repair
   * edge that stands for reconnect are both transitions of this object. The id is read
   * off it, so the pane and the store can never name two sessions.
   */
  readonly sessionStore: SessionStore;
  /**
   * The clock this schedule and every stamp the reader publishes run on.
   *
   * Required, and the binding reads it off the bridge with `consoleClockFor`, the one
   * answer to which clock a window runs on.
   */
  readonly clock: ConsoleClock;
}

export abstract class ArtifactReadSchedule implements ReadTriggerTarget {
  /** The frames whose arrival owes this pane a fresh read. */
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set<string>(
    ARTIFACT_TERMINAL_EVENT_KINDS,
  );
  readonly #listArtifacts: ListArtifacts;
  readonly #sessionStore: SessionStore;
  readonly #scheduler: RefreshScheduler;
  readonly #triggers: SessionRefreshTriggers;
  /**
   * Which refresh a completion belongs to.
   *
   * A read takes the key, so a completion asks whether its own round is still the one the
   * key is on. The key is superseded when a read starts and when the schedule is disposed,
   * so one question answers both "this answer was superseded" and "this answer outlived
   * its pane".
   */
  readonly #reads = new GenerationLatch();

  #started = false;
  #disposed = false;

  protected constructor(options: ArtifactReadScheduleOptions) {
    this.#listArtifacts = options.listArtifacts;
    this.#sessionStore = options.sessionStore;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#performRead();
      },
    });
    // The other three reasons to read again reach this schedule only through the
    // scheduler, so a burst of frames still costs one read.
    this.#triggers = new SessionRefreshTriggers({
      target: this,
      sessionStore: options.sessionStore,
    });
  }

  /** How many reads have actually run — the coalescing assertion, not an inference. */
  public get performCount(): number {
    return this.#scheduler.performCount;
  }

  /**
   * Whether this reader's disposal has already ended it.
   *
   * Separate from the store axis below because the two have different owners: a disposed
   * reader is terminal, and `useSubjectScopedResource` takes that fact as `isClosed` and
   * mints the replacement itself.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Whether these reads are taken against `sessionStore`.
   *
   * The subject-scoped seam keys on the artifact, which names its session and so cannot
   * tell apart two readings of one session. A store rebuilt across a reconnect is exactly
   * that, and this is the axis the key cannot carry.
   */
  public isReadingFor(sessionStore: SessionStore): boolean {
    return this.#sessionStore === sessionStore;
  }

  /**
   * Read once, and keep listening for the reasons to read again.
   *
   * Idempotent for React's development double-mount, which would otherwise double every
   * read in exactly the environment where the budget is being watched.
   */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.requestRead("subscribe");
    this.#triggers.start();
  }

  /**
   * Ask for a read. Coalescing, debouncing and the call itself stay the scheduler's.
   *
   * Every reason reaches this schedule here, so the disposal guard is written once.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#disposed) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /**
   * A handle on whichever scheduled round is running, for an act that has to measure a
   * settlement it did not itself start.
   */
  public currentReadClaim(): CurrentGenerationClaim {
    return this.#reads.currentClaim(this, SCHEDULED_READ_KEY);
  }

  /** Terminal. No later completion, frame, or focus can reach a pane that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    this.#reads.supersedeAll();
    this.#scheduler.dispose();
    this.#triggers.dispose();
  }

  /** What this schedule is publishing against — the reading it is about to replace. */
  protected abstract currentReading(): ArtifactPaneReading;

  /** Where a settled round is put. */
  protected abstract publishReading(reading: Omit<ArtifactPaneReading, "readAtMilliseconds">): void;

  async #performRead(): Promise<void> {
    // A scheduled read always runs and supersedes the one before it, because the rows it
    // re-reads are the same rows.
    const readRound = this.#reads.supersedeAndClaim(this, SCHEDULED_READ_KEY);

    const artifacts = await readArtifactList(this.#listArtifacts, this.#sessionStore.sessionId);
    if (!readRound.isCurrent) {
      return;
    }
    this.publishReading(settledReadReading(this.currentReading(), artifacts));
  }
}
