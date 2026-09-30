// When the artifact list reads again, and which round a completion belongs to.
//
// No timer and no poll: the read runs on mount, on user request, and on focus, reconnect and
// artifact frames, all through the one `RefreshScheduler`. Bursts coalesce, reads never
// overlap, and a superseded completion is dropped. A rejected list call is not caught here:
// with no `onError`, the scheduler re-throws it.

import { SESSION_EVENT_CATEGORY_BY_TYPE, type SessionEventType } from "@ai-sidekicks/contracts";

import type { Clock } from "@renderer/lib/clock.js";
import {
  GenerationLatch,
  type CurrentGenerationClaim,
} from "@renderer/lib/reads/generation-latch.js";
import { RefreshScheduler, type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";
import { SessionRefreshTriggers } from "@renderer/store/reads/session-refresh-triggers.js";
import { type ReadTriggerTarget } from "@renderer/store/reads/read-triggers.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { settledReadReading, type ArtifactListReading } from "./artifact-list-reading.js";
import { readArtifactList, type ListArtifacts } from "./services/artifact-reads.js";

/** The namespace every frame about an artifact is registered under. */
const ARTIFACT_EVENT_NAMESPACE_PREFIX = "artifact.";

/**
 * Every registered frame in the `artifact.` namespace.
 *
 * Derived from `SESSION_EVENT_CATEGORY_BY_TYPE`, so a newly registered artifact kind is
 * watched without an edit here. Selected by namespace, not category: `artifact_publication`
 * also holds `diff.created` and `git.settled`, which change neither read.
 */
export const ARTIFACT_TERMINAL_EVENT_KINDS: readonly SessionEventType[] = [
  ...SESSION_EVENT_CATEGORY_BY_TYPE.keys(),
].filter((eventType) => eventType.startsWith(ARTIFACT_EVENT_NAMESPACE_PREFIX));

/**
 * The one key the section's scheduled read is claimed under.
 *
 * One key, not one per artifact: a scheduled read re-reads the whole list, so one round is in
 * flight at a time.
 */
const SCHEDULED_READ_KEY = "scheduled-read";

/** What the artifact read schedule is given to list a session's manifests. */
export interface ArtifactReadScheduleOptions {
  /** The call that lists the session's artifact manifests. */
  readonly listArtifacts: ListArtifacts;
  /**
   * The session to read, and three of the four reasons to read again.
   *
   * The store rather than a session id: artifact frames and the reconnect repair edge are
   * transitions of this object, and the id is read off it.
   */
  readonly sessionStore: SessionStore;
  /** The clock the schedule and every published stamp run on; the binding supplies it. */
  readonly clock: Clock;
}
/**
 * When the artifact list reads. A base class rather than a composed object, so the reader
 * carries the trigger contract itself; the abstract members are methods because a subclass
 * cannot close over `this` inside its own `super()` call.
 */
export abstract class ArtifactReadSchedule implements ReadTriggerTarget {
  /** The frames whose arrival owes this section a fresh read. */
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
   * Superseded when a read starts and on disposal, so one check answers both "superseded"
   * and "outlived its section".
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

  /** How many reads have run; lets a test assert coalescing. */
  public get performCount(): number {
    return this.#scheduler.performCount;
  }

  /**
   * Whether disposal has ended this reader.
   *
   * Separate from the store axis: `useSubjectScopedResource` takes this as `isClosed`.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Whether these reads are taken against `sessionStore`.
   *
   * The subject-scoped key names the artifact, so it cannot tell apart two readings of one
   * session; a store rebuilt across a reconnect is that case.
   */
  public isReadingFor(sessionStore: SessionStore): boolean {
    return this.#sessionStore === sessionStore;
  }

  /** Read once and keep listening. Idempotent, so React's development double-mount is one read. */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    this.requestRead("subscribe");
    this.#triggers.start();
  }

  /**
   * Ask for a read; coalescing, debouncing and the call stay the scheduler's.
   *
   * Every reason comes through here, so the disposal guard is written once.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#disposed) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /** A handle on the running scheduled round, for an act measuring a settlement it did not run. */
  public currentReadClaim(): CurrentGenerationClaim {
    return this.#reads.currentClaim(this, SCHEDULED_READ_KEY);
  }

  /** Terminal: nothing that completes after this reaches a section that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    this.#reads.supersedeAll();
    this.#scheduler.dispose();
    this.#triggers.dispose();
  }

  /** The reading this schedule is about to replace. */
  protected abstract currentReading(): ArtifactListReading;

  protected abstract publishReading(reading: Omit<ArtifactListReading, "readAtMilliseconds">): void;

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
