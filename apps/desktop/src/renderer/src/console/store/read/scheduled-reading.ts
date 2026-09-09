// A SCHEDULED READING: the third composed read shape, owned once.
//
// The console owns `ReadTriggerTarget`, `RefreshScheduler`, `GenerationLatch` and
// `Emitter`, and it owns two COMPOSED read seats — `seats/read/growth-read.ts`
// (ask-once-per-subject) and `seats/read/push-driven-read.ts` (a read whose answer moves).
// It owned no seat for the shape most of the tree actually has: a scheduled read
// PUBLISHED TO SUBSCRIBERS. So sixteen classes across eight view families and the
// bridge each wrote the same skeleton — the emitter, the scheduler with its `onError`
// arm, the latch, `#hasStarted`, `#isDisposed`, `snapshot()`, `subscribe()`,
// `start()`, `requestRead()`, `dispose()` — and the revisioned publisher was
// character-for-character identical in three unrelated families. That is what
// `apps/desktop/AGENTS.md` §Shared code forbids, and it is invisible to both
// mechanical gates: knip sees reachable modules and dependency-cruiser sees legal
// edges, so neither can see one job implemented sixteen times.
//
// WHY `store/` AND NOT `seats/`. Every member this base needs — `RefreshScheduler`,
// `GenerationLatch`, `ReadTriggerTarget`, `Emitter` — is declared at or below this
// family, and nothing here names a bridge port: the read itself is the subclass's, so
// the base never learns what a reading asks or whom it asks. That keeps it reachable
// from `bridge/` too, which sits ABOVE `store/` on the console DAG and holds four of
// the sixteen copies.
//
// DERIVED FROM SIX OF THE SIXTEEN, read in full rather than sampled:
// `settings/pages/cost/cost-receipt-read.ts`, `agents/definitions/definition-registry-view.ts`
// and `browser/settings/browser-settings-source.ts` (the three whose publishers are
// character-identical), plus `repos/artifact-pane/artifact-read-schedule.ts` (already
// abstract, and the only one with a per-read `start()` that also drives an imperative
// trigger set), `settings/pages/notifications/scheduled-caller-participant-read.ts` and
// `settings/pages/appearance/store-state/store-state-read.ts` (the two that hold a
// bare reading rather than a revisioned snapshot, and the one that reads no bridge at
// all). WHERE EACH VARIATION LANDS:
//
//   • **The read itself** → {@link ScheduledReading.performRead}, abstract. It is the
//     only member that knows what is being asked, so it is the only one that can
//     compose the refusal its own reading vocabulary spells.
//   • **The snapshot fold** → the subclass, over {@link ScheduledReading.publish}. The
//     base holds the value and hands out a new identity; whether a transition is a
//     whole replacement (`CallerParticipantRead`, `StoreStateRead`) or a revisioned
//     partial (`CostReceiptRead`, `SidekickRegistryView`, `BrowserSettingsView`) is a
//     property of the SNAPSHOT TYPE, and a base that folded for both would have to
//     require a `revision` member of readings that have none.
//   • **The initial snapshot** → `initialSnapshot` on the options, constructor-supplied.
//     What a read starts as is a decision each reading has already made and written
//     down as its own `NOTHING_READ`.
//   • **Whether a read may run at all** → {@link ScheduledReading.isReadable},
//     overridable, `true` by default. Four of the six ask nothing when they hold no
//     session id, and the guard belongs beside the reason rather than at each trigger.
//   • **Which rounds a read supersedes** → the subclass picks
//     {@link ScheduledReading.currentReadRound} (mint-and-settle, so an out-of-band act
//     holding the key keeps it) or {@link ScheduledReading.supersedeAndClaimReadRound}
//     (newest read wins), which is the difference the six already disagree about.
//
// THE FAILURE ARM IS FIXED HERE AND HAS NO HOOK. The scheduler needs an `onError` or
// it re-throws, and a re-throw inside a timer callback reaches no `catch` a surface
// could render. But there is exactly one place a reading can PUT a failure — its own
// snapshot, through its own refusal vocabulary — and that place is inside
// `performRead`, which is where five of the six already compose it. So a reading with
// somewhere to put a defect catches there, and this arm exists only to keep a defect
// in the publish from escaping into a timer. Two publish paths for one refusal is the
// ambiguity this avoids, not a capability it drops.
//
// THE EMITTER CARRIES NO PAYLOAD, which is not a narrowing. Three copies typed theirs
// `Emitter<TSnapshot>` and emitted the snapshot; every subscriber in the tree is a
// `() => void` sink that then calls `snapshot()`, because that is what
// `useSyncExternalStore` does. A payload no subscriber can read is a member that only
// looks like one.

import { Emitter, type ConsoleClock, type Unsubscribe } from "../../core/index.js";
import {
  GenerationLatch,
  type CurrentGenerationClaim,
  type GenerationClaim,
} from "./generation-latch.js";
import type { ReadTriggerTarget } from "./read-triggers.js";
import { RefreshScheduler, type RefreshReason } from "./refresh-scheduler.js";

/**
 * The one key every scheduled read is taken under.
 *
 * ONE KEY AND NOT ONE PER SUBCLASS, because the latch is keyed by `(subject, key)` and
 * the subject is the reading itself: two readings can no more collide on this key than
 * they can share an identity. The six copies each named their own — `receipt-read`,
 * `registry-read`, `settings-read`, `scheduled-read` — and the name was never read by
 * anything but the latch it was handed to.
 */
const SCHEDULED_READ_KEY = "scheduled-read";

export interface ScheduledReadingOptions<TSnapshot> {
  /**
   * The clock the scheduler arms on — the window's one clock, never a second.
   *
   * REQUIRED, with no `RealClock` default. A default here is what let a call site skip
   * asking which clock the window runs on, and a reading that debounced against wall
   * time inside a fixture advancing on frozen time raced every other schedule in the
   * window.
   */
  readonly clock: ConsoleClock;
  /** What this reading publishes before its first read settles. */
  readonly initialSnapshot: TSnapshot;
  /**
   * What is being emitted, for `Emitter`'s aggregate failure message — "cost receipt
   * read change", "sidekick registry change". A message that names the stream is the
   * difference between a debuggable failure and a stack trace in a `Set` loop.
   */
  readonly describeChange: string;
}

/**
 * A read that is scheduled, single-flighted, and published to subscribers.
 *
 * A class with private fields rather than a pair of `useState` cells, per
 * `apps/desktop/AGENTS.md` §State and views. The React binding is the subclass's — a
 * `useSubjectScopedResource` mint plus `useSyncExternalStore` over
 * {@link subscribe} and {@link snapshot} — and holds nothing of its own.
 */
export abstract class ScheduledReading<TSnapshot> implements ReadTriggerTarget {
  /**
   * The session-event kinds whose arrival owes this reading a fresh read.
   *
   * ABSTRACT AND NOT DEFAULTED, because `store/read/read-triggers.ts` states that which
   * events change an answer is a property of the QUESTION and never of the surface
   * that mounts it. A base supplying `NO_TRIGGERING_EVENT_KINDS` would be answering it
   * for readings that have not been asked — and an empty set is a real answer that a
   * reading has to make rather than inherit.
   */
  public abstract readonly triggeringEventKinds: ReadonlySet<string>;

  readonly #changes: Emitter<void>;
  readonly #rounds = new GenerationLatch();
  readonly #scheduler: RefreshScheduler;
  #snapshot: TSnapshot;
  #hasStarted = false;
  #isDisposed = false;

  protected constructor(options: ScheduledReadingOptions<TSnapshot>) {
    this.#snapshot = options.initialSnapshot;
    this.#changes = new Emitter<void>(options.describeChange);
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.performRead();
      },
      // See the module header: `performRead` settles its own refusal, so anything
      // reaching here is a defect in the publish. Swallowed rather than re-thrown
      // because a re-throw inside a timer callback reaches no `catch` a surface has.
      onError: () => undefined,
    });
  }

  /**
   * What a surface renders from.
   *
   * The snapshot is HELD rather than composed per call, because `useSyncExternalStore`
   * compares identity: a getter returning a fresh object every call renders forever.
   */
  public snapshot(): TSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Whether this reading has been disposed. The re-mint reading its holder takes. */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /** How many reads have actually run — the coalescing assertion, not an inference. */
  public get performCount(): number {
    return this.#scheduler.performCount;
  }

  /**
   * Read once, on arrival. Idempotent: strict mode mounts an effect twice.
   *
   * For the readings whose own mount opens them. A reading wired by
   * `useWindowReadTriggers` or `useReadTriggers` never calls this — those hooks put
   * the `subscribe` reason in themselves — and the two paths are the same reason
   * reaching the same scheduler, which coalesces a pair into one read.
   */
  public start(): void {
    if (this.#hasStarted || this.#isDisposed) {
      return;
    }
    this.#hasStarted = true;
    this.requestRead("subscribe");
  }

  /**
   * Ask for a read.
   *
   * THE ONE WAY A REASON REACHES THIS READING — every trigger, every participant press
   * — so the disposal guard and the {@link isReadable} guard are each written once.
   * None of them calls the port: what a burst of reasons costs is the scheduler's
   * decision, and a surface that asked directly is the surface that had two reads
   * outstanding at once.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#isDisposed || !this.isReadable()) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /**
   * Terminal. A reply landing after this publishes nothing.
   *
   * A subclass with something of its own to end — an imperative trigger set, a
   * subscription — overrides this and calls `super.dispose()`; it does not get a hook,
   * because a hook would be a second place teardown order could be decided.
   */
  public dispose(): void {
    this.#isDisposed = true;
    this.#scheduler.dispose();
    this.#rounds.supersedeAll();
  }

  /**
   * Perform one read and publish what it answered.
   *
   * NEVER REJECTS, by contract: this is the only member holding the reading's own
   * refusal vocabulary, so a rejection is turned into that reading's refusal arm here
   * rather than escaping into the scheduler's timer. Take a round from
   * {@link currentReadRound} or {@link supersedeAndClaimReadRound} first and settle
   * through it, or the reply of a read whose subject has since moved installs anyway.
   */
  protected abstract performRead(): Promise<void>;

  /**
   * Whether there is anything to read at all. `true` unless a subclass says otherwise.
   *
   * The absence a settings address carries is the case this exists for: a page opened
   * with no session asks the daemon nothing rather than asking for somebody else's
   * receipt. Consulted at {@link requestRead}, so an unreadable reading never arms the
   * scheduler and its `performRead` is never entered.
   */
  protected isReadable(): boolean {
    return true;
  }

  /**
   * Install one snapshot and hand out a new identity.
   *
   * A WHOLE VALUE AND NOT A PARTIAL: the fold is the subclass's, because whether a
   * transition revises a revision counter is a property of the snapshot type. What is
   * shared is that the value is held and that every subscriber hears it — the two
   * halves that were written sixteen times.
   */
  protected publish(next: TSnapshot): void {
    this.#snapshot = next;
    this.#changes.emit();
  }

  /**
   * A handle on whichever round is running, minting one where none is.
   *
   * For the reading whose refresh must not revoke a key an out-of-band act is holding
   * — a write in flight, a delete this reading itself started. It supersedes nothing,
   * so the settlement it answers with goes stale exactly when that act's round does.
   */
  protected currentReadRound(): CurrentGenerationClaim {
    return this.#rounds.currentClaim(this, SCHEDULED_READ_KEY);
  }

  /**
   * Take the key, abandoning whatever held it.
   *
   * For the reading whose rule is that the newest read wins: the rows it is about to
   * re-read are the same rows, so the older answer has nothing left to say about them.
   * The claim can give the key back, which is what separates it from the handle above.
   */
  protected supersedeAndClaimReadRound(): GenerationClaim {
    return this.#rounds.supersedeAndClaim(this, SCHEDULED_READ_KEY);
  }
}
