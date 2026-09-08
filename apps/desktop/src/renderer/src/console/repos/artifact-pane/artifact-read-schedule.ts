// WHEN the artifact pane reads again, and which round a completion belongs to.
//
// Split from `artifact-reader.ts`, which was doing two jobs: deciding when to read is
// this module's, and holding what a surface renders and what it can act on is the
// reader's. Nothing here knows what a reading MEANS — the two members below that touch
// one are abstract, and the subclass answers them.
//
// A BASE CLASS AND NOT A COMPOSED COLLABORATOR, on `store/act-controller-base.ts`'s
// precedent and for a reason that is mechanical rather than stylistic.
// `test/console/architecture/read-triggers.test.ts` defines a READING as one class that
// publishes what a surface reads off it AND holds the daemon connection, and it requires
// that same class to carry the scheduler and the two members a trigger set wires — the
// defect it exists to catch is a reading nobody can ask again. Composed, this schedule
// would have taken the bridge, the scheduler and the trigger contract out of the class a
// surface actually holds, and the artifact pane would have left that gate's subject set
// while behaving identically. Inheritance is what the gate follows, so the split costs
// the pane none of its refreshability and the subclass still owns every question about
// what a reading means.
//
// AND THE TWO ABSTRACT MEMBERS ARE METHODS RATHER THAN CLOSURES IN THE OPTIONS, on that
// same base's reason: a subclass cannot write `publish: (reading) => this.#publish(reading)`
// inside its own `super()` call, because `this` is unreachable until `super()` returns.
// Both are dispatched no earlier than the first scheduled read, which is long after
// every subclass field has been initialised.
//
// NO TIMER AND NO POLL, AND ALSO NO RACE. The reads run once when the pane mounts and
// again when the participant asks, and BOTH go through the console's one
// `RefreshScheduler` (`store/scheduling.ts`, the `repos/mounts/repo-mounts-reader.ts`
// precedent) rather than straight at the port. A reader that called the port on every
// press started a second list/allow-list pair beside the first: two presses cost two
// read pairs, an older answer could land after a newer one and overwrite it, and the
// two legs published independently, so a snapshot could hold a list from one press
// beside an allow-list from another. The scheduler coalesces a burst of presses into
// one read and serializes reads so two never overlap; the GENERATION stamp below is
// what makes the discard explicit — every completion carries the stamp it was issued
// under, a completion whose stamp is no longer current is dropped, and the two legs of
// one generation publish as ONE snapshot rather than two.
//
// AND ALL FOUR OF THE REFRESH RULE'S REASONS ARE WIRED, not one. `Spec-023 §Rules
// every console surface obeys` allows subscribe, window focus, reconnect, and the
// terminal events the owning spec names — and this reader used to have the first and
// a participant's press and nothing else. A pane left open through a daemon reconnect,
// or through an `artifact.published` / `artifact.superseded` /
// `artifact.visibility_updated` frame, held a manifest list and an effective
// allow-list that were stale indefinitely and looked exactly like fresh ones. The
// other three reasons now reach the same scheduler through
// `store/refresh-triggers.ts`, which is the mechanism the repos section's two readers
// already use; the KINDS are this pane's own, because those three frames are what
// `Spec-006 §Artifact and Diff Publication (artifact_publication)` names as terminal
// for an artifact. A `workspace.stale` frame is deliberately not among them: it says a
// path went stale, which is a fact about a workspace and no evidence at all about this
// session's artifacts.
//
// Still no interval, and still no timer of this schedule's own: a pane that armed one
// would be spending the budget on a wire that refuses.
//
// AND THE TWO LEGS OF ONE READ FAIL SEPARATELY, WHICH IS NOT THE SAME AS PUBLISHING
// SEPARATELY. They are joined so a snapshot never holds a list from one refresh beside
// an allow-list from another — but the join used to be over two calls that could
// REJECT, so a bridge that dropped only the bounds read took the whole refresh down:
// the scheduler's error handler marked `artifacts` refused, and a session's manifests
// and the allow-list's own fallback were both discarded because an unrelated read had
// no answer. Both legs live in `artifact-pane-reads.ts` — what a served answer MEANS is
// a question about the wire and not about scheduling — and each goes through
// `readGrowthAnswer` (`growth-call.ts`), so a rejection becomes THAT leg's refusal
// before the join sees it, neither leg can reject, and a bounds outage costs exactly
// the bounds.

import type { ConsoleBridge } from "../../bridge/index.js";
import type { ConsoleClock } from "../../core/index.js";
import {
  GenerationLatch,
  RefreshScheduler,
  SessionRefreshTriggers,
  type CurrentGenerationClaim,
  type ReadTriggerTarget,
  type RefreshReason,
  type SessionStore,
} from "../../store/index.js";
import { ARTIFACT_TERMINAL_EVENT_KINDS } from "../repo-lifecycle-events.js";
import { readFailureRefusal } from "./artifact-pane-refusals.js";
import { settledReadReading, type ArtifactPaneReading } from "./artifact-pane-reading.js";
import { readArtifactAllowlist, readArtifactList } from "./artifact-pane-reads.js";

/**
 * The one key this pane's scheduled read is claimed under.
 *
 * ONE KEY AND NOT ONE PER ARTIFACT, because a scheduled read re-reads the whole list:
 * there is a single round in flight at a time and every act comparing against it is
 * asking the same question. The acts' own single flight is keyed by artifact id, in
 * `artifact-actions.ts`, and the header there says why the two registers are separate.
 */
const SCHEDULED_READ_KEY = "scheduled-read";

export interface ArtifactReadScheduleOptions {
  readonly bridge: ConsoleBridge;
  /**
   * The session to read, and three of the four reasons to read again.
   *
   * The STORE rather than a bare session id, on `repos/mounts/repo-mounts-reader.ts`'s
   * reason: the artifact frames and the repair edge that stands for reconnect are
   * both transitions of this object, and a reader handed only an id could observe
   * neither. The id is read off it, so the pane and the store can never name two
   * sessions.
   *
   * ABSENT on a bare route, where the deck has a pane and no session behind it — and
   * a reader that read anyway would have to invent a session id, so it reads nothing,
   * listens for nothing, and the pane renders the absence that says nobody asked.
   */
  readonly sessionStore: SessionStore | undefined;
  /**
   * The clock this schedule and every stamp the reader publishes run on.
   *
   * REQUIRED, AND THE BINDING READS IT OFF THE BRIDGE. It used to default to a fresh
   * `RealClock`, so a pane composed under the fixture coalesced its reads against wall
   * time while the scenario advanced on frozen time — the two clocks racing inside one
   * window, with whichever ran first deciding what a screenshot caught.
   * `consoleClockFor` is the one answer to which clock a window runs on, and a default
   * here is what let a call site skip asking it.
   */
  readonly clock: ConsoleClock;
}

export abstract class ArtifactReadSchedule implements ReadTriggerTarget {
  /**
   * The frames whose arrival owes this pane a fresh read.
   *
   * The artifact half of the family's census in `repo-lifecycle-events.ts`, declared
   * here so the trigger wiring reads it off the schedule rather than being handed it:
   * which frames change an artifact list is a property of the question, and a pane on
   * a bare route asks the same question with no session to ask it under.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = new Set<string>(
    ARTIFACT_TERMINAL_EVENT_KINDS,
  );
  readonly #bridge: ConsoleBridge;
  readonly #sessionStore: SessionStore | undefined;
  readonly #sessionId: string | undefined;
  readonly #scheduler: RefreshScheduler;
  /** Absent on a bare route: with no session there is nothing to observe. */
  readonly #triggers: SessionRefreshTriggers | undefined;
  /**
   * Which refresh a completion belongs to.
   *
   * The console's one generation register rather than a counter of this file's own:
   * a read takes the key, so a completion asks whether its own round is still the one
   * the key is on. Superseded when a read starts AND when the schedule is disposed, so
   * one question answers both "this answer was superseded" and "this answer outlived
   * its pane". A second boolean beside it would be two mechanisms for one question.
   */
  readonly #reads = new GenerationLatch();

  #started = false;
  #disposed = false;
  #hasEnteredLoading = false;

  protected constructor(options: ArtifactReadScheduleOptions) {
    this.#bridge = options.bridge;
    this.#sessionStore = options.sessionStore;
    this.#sessionId = options.sessionStore?.sessionId;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#performRead();
      },
      // Swallowing is not an option, and re-throwing into a timer callback reaches
      // nobody, so a read that threw past its own refusal handling lands in the
      // reading as a refusal — the pane renders it instead of holding stale rows
      // behind a list that never answered.
      onError: (error: unknown) => {
        this.publishReading({
          ...this.currentReading(),
          artifacts: { kind: "refused", refusal: readFailureRefusal(error) },
        });
      },
    });
    // The other three reasons to read again. They reach this schedule only through the
    // scheduler, so a burst of frames still costs one read pair.
    this.#triggers =
      options.sessionStore === undefined
        ? undefined
        : new SessionRefreshTriggers({ target: this, sessionStore: options.sessionStore });
  }

  /** How many reads have actually run — the coalescing assertion, not an inference. */
  public get performCount(): number {
    return this.#scheduler.performCount;
  }

  /**
   * Whether this reader's disposal has already ended it.
   *
   * ASKED RATHER THAN REMEMBERED, on `AttachmentCarrier.isDisposed`'s reason: a flag
   * kept beside the reader would be a copy of what the schedule already knows.
   *
   * SPLIT FROM THE STORE AXIS BELOW, which for a while it was not: the two were one
   * `isCurrentFor` conjunction, and both answers did mean the same act — mint a fresh
   * reader — but they do not have the same OWNER. A disposed reader is terminal and
   * `useSubjectScopedResource` takes that fact as `isClosed`, minting the replacement
   * itself and leaving the corpse uncommitted; fused into one question the binding had
   * to re-derive it, publish the replacement itself, and the corpse was committed and
   * then disposed a second time.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Whether these reads are taken against `sessionStore`.
   *
   * `RepoMountsReader.isReadingFor`'s name and its reason, one directory over. The
   * subject-scoped seam keys on the artifact, which names its session and so cannot
   * separate two readings of one session; a store rebuilt across a reconnect is
   * exactly that, and this is the axis the key cannot carry.
   */
  public isReadingFor(sessionStore: SessionStore | undefined): boolean {
    return this.#sessionStore === sessionStore;
  }

  /**
   * Read once, and keep listening for the reasons to read again.
   *
   * Idempotent for React's development double-mount, which would otherwise double every
   * read in exactly the environment where the budget is being watched.
   */
  public start(): void {
    if (this.#started || this.#disposed || this.#sessionId === undefined) {
      return;
    }
    this.#started = true;
    this.requestRead("subscribe");
    this.#triggers?.start();
  }

  /**
   * Ask for a read. Coalescing, debouncing, and the call itself stay the scheduler's.
   *
   * The ONE way a reason reaches this schedule — the trigger wiring's three, the
   * subscription's one, and the participant press all arrive here — so the bare-route
   * guard and the disposal guard are each written once. A pane with no session has
   * nothing to read artifacts under and no frames to be told about, which is why the
   * same condition withholds the trigger wiring in the constructor.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#disposed || this.#sessionId === undefined) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /**
   * A handle on whichever scheduled round is running, for an act that has to measure
   * a settlement it did not itself start.
   *
   * The schedule is the latch's subject, so an act's handle and the read's own claim
   * are two views of one round rather than two registers that have to agree.
   */
  public currentReadClaim(): CurrentGenerationClaim {
    return this.#reads.currentClaim(this, SCHEDULED_READ_KEY);
  }

  /** Terminal. No later completion, frame, or focus can reach a pane that unmounted. */
  public dispose(): void {
    this.#disposed = true;
    this.#reads.supersedeAll();
    this.#scheduler.dispose();
    this.#triggers?.dispose();
  }

  /** What this schedule is publishing against — the reading it is about to replace. */
  protected abstract currentReading(): ArtifactPaneReading;

  /** Where a settled round, and a read that threw past its own refusal, are put. */
  protected abstract publishReading(reading: Omit<ArtifactPaneReading, "readAtMilliseconds">): void;

  async #performRead(): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === undefined) {
      return;
    }
    // A scheduled read always runs and always supersedes the one before it: the
    // rows it is about to re-read are the same rows, so the older answer has nothing
    // left to say about them.
    const readRound = this.#reads.supersedeAndClaim(this, SCHEDULED_READ_KEY);

    // ENTERED ONCE, NEVER RE-ENTERED. Rule 8 separates "a read is in flight" from
    // "nobody asked", and a refresh that dropped the rows back to the in-flight
    // absence would blank a surface that has an answer on it while it re-reads.
    if (!this.#hasEnteredLoading) {
      this.#hasEnteredLoading = true;
      this.publishReading({ ...this.currentReading(), artifacts: { kind: "loading" } });
    }

    // NEITHER LEG CAN REJECT, so the join is a join and not a fuse: each read below
    // ends on its own refused reading, and one that did not answer says so beside a
    // sibling that did.
    const [artifacts, allowlist] = await Promise.all([
      readArtifactList(this.#bridge, sessionId),
      readArtifactAllowlist(this.#bridge, sessionId),
    ]);
    if (!readRound.isCurrent) {
      return;
    }
    this.publishReading(settledReadReading(this.currentReading(), artifacts, allowlist));
  }
}
