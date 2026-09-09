// One participant's stored preference set: every read of it, and which reply may
// publish.
//
// FOUR THINGS ASK FOR THIS SET AND THEY OVERLAP. The section mounting, the window
// regaining focus, the transport coming back, and the re-read a served write performs
// are four independent reasons to ask the store what it holds — and every one of them
// used to call the port directly and publish whatever came back. Two consequences,
// both invisible while every reply was fast:
//
//   • AN OLDER SNAPSHOT ANSWERING LAST UNDID A NEWER ACCEPTED TOGGLE. A focus read
//     taken before a write and answered after its re-read replaced the set with the
//     value the daemon held BEFORE the write — so a switch the person watched settle
//     flipped back, and nothing on screen said why.
//   • THE FIRST COMPLETION CLEARED THE IN-FLIGHT FLAG WHILE ANOTHER READ WAS STILL
//     OUT. The rows went pressable against a value the console was in the middle of
//     replacing, which is exactly the composition hazard the lock exists to stop.
//
// SO EVERY READ GOES THROUGH `store/read/refresh-scheduler.ts` AND EVERY REPLY THROUGH
// `store/read/generation-latch.ts`. The scheduler is the console's one refresh chokepoint
// — trailing debounce with an absolute deadline, and serialized, so the three window
// triggers cost one call however they bunch. The latch is what the scheduler cannot
// give: a write's re-read does NOT go through the scheduler, because the writer needs
// the value in its own loop to compose a queued flip against, so it is a second read
// path by necessity — and one register with one key is what puts the two paths in a
// single order. Reads are taken monotonically, so the later-TAKEN read describes the
// later state and a reply from an earlier one is answering a question already asked
// again.
//
// `readSet` IS THE ONE CALL SITE, which is what makes that claim checkable rather
// than a convention. The scheduler's perform reaches it and the writer reaches it,
// and both get the same round, the same publication rule, and the same in-flight
// bookkeeping. A caller that wanted the value without the publication would be asking
// for a second reading of one set.
//
// AND IN-FLIGHT IS TRUE UNTIL THE ACCEPTED GENERATION SETTLES. It is a request that
// has not been performed yet OR a read that has not answered — never a flag one
// arbitrary completion clears — so an overlapped older reply leaves the rows locked
// while the newer read is still out, and a re-read asked for during one keeps them
// locked rather than releasing them for the gap between the two calls.

import type { ConsoleBridge } from "../../../bridge/index.js";
import { Emitter, type ConsoleClock, type Unsubscribe } from "../../../core/index.js";
import { consoleRefusalFrom } from "../../../seats/index.js";
import {
  GenerationLatch,
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../../../store/index.js";
import type {
  AttentionPreferenceReadOutcome,
  AttentionPreferenceReading,
} from "./attention-preference-model.js";

/** Names a read that produced no outcome at all, where the thrown value named none. */
export const ATTENTION_PREFERENCE_ORIGIN = "attention-preference";

/**
 * The one key every read of this set is taken under.
 *
 * One key and not one per caller: what supersedes a read here is another read of the
 * SAME set, whoever asked for it, and a key per path would be two registers that
 * cannot order each other — which is the whole defect this module closes.
 */
const SET_READ_KEY = "set-read";

/** What the stored-preference section renders from, in one value. */
export interface AttentionPreferenceReadSnapshot {
  /** What the last admitted read answered, or `undefined` before one has. */
  readonly reading: AttentionPreferenceReading | undefined;
  /**
   * True while a read is pending or outstanding. Held BESIDE the reading.
   *
   * Beside rather than in place of it, which is the whole of what it is for: the rows
   * a person is looking at stay where they are and go unpressable while the answer is
   * refreshed. A reading cleared first would return the section to its opening shape
   * on every window focus, which reads as the console forgetting.
   */
  readonly isReadInFlight: boolean;
  /** Bumped on every transition, so `useSyncExternalStore` sees a new identity. */
  readonly revision: number;
}

const NOTHING_READ: AttentionPreferenceReadSnapshot = {
  reading: undefined,
  isReadInFlight: false,
  revision: 0,
};

export interface AttentionPreferenceReadOptions {
  readonly bridge: ConsoleBridge;
  /**
   * Whose set this is, or `undefined` until the identity read has named somebody.
   *
   * An absence rather than a placeholder: the set is keyed by participant, so a read
   * taken under a guessed one would put another person's answers on this screen.
   */
  readonly participantId: string | undefined;
  /** The clock the scheduler arms on. The fixture's frozen one under a scenario. */
  readonly clock: ConsoleClock;
}

/**
 * One participant's stored attention preferences, kept current by the window triggers.
 *
 * A class with private fields rather than a pair of `useState` cells, per
 * `apps/desktop/AGENTS.md`: it owns a scheduler, a single-flight round, and the rule
 * that decides which reply installs. The React binding is
 * `stored-attention-preferences.ts`, which holds nothing of its own.
 */
export class AttentionPreferenceRead implements ReadTriggerTarget {
  /**
   * No timeline event refreshes this read, and the empty set states it.
   *
   * The stored set is global to a PARTICIPANT rather than owned by a session, so
   * nothing in any session's timeline says it moved — which is why it takes the
   * window's three triggers and neither of the session-scoped two.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #bridge: ConsoleBridge;
  readonly #participantId: string | undefined;
  readonly #changes = new Emitter<void>("attention preference read change");
  readonly #rounds = new GenerationLatch();
  readonly #scheduler: RefreshScheduler;
  #snapshot: AttentionPreferenceReadSnapshot = NOTHING_READ;
  /** What the last admitted reply said. Written only inside an admitted round. */
  #reading: AttentionPreferenceReading | undefined = undefined;
  /** A reason the scheduler holds and has not performed yet. */
  #hasPendingRequest = false;
  /** Reads dispatched and not yet answered, from either path. Never below zero. */
  #outstandingReadCount = 0;
  #isDisposed = false;

  public constructor(options: AttentionPreferenceReadOptions) {
    this.#bridge = options.bridge;
    this.#participantId = options.participantId;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        // Cleared HERE rather than at the settlement: the scheduler has coalesced
        // every reason raised so far into this one read, and a reason raised while it
        // is out sets the flag again — which is what keeps the rows locked across the
        // gap between a completed read and the next one it already owes.
        this.#hasPendingRequest = false;
        await this.readSet();
      },
      // `readSet` turns a rejection into the `unreadable` arm and then re-throws for
      // the writer's sake, so this arm is the scheduler's own path and must exist:
      // without it the scheduler re-throws inside a timer callback, where no surface
      // has a `catch` to render.
      onError: () => undefined,
    });
  }

  public snapshot(): AttentionPreferenceReadSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Whether this reading has been disposed. The re-mint its holder takes. */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /**
   * Ask for a read.
   *
   * Every window trigger arrives here and none of them calls the port: what a burst
   * of reasons costs is the scheduler's decision, and a section that asked directly
   * is the section that had two reads outstanding at once.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#isDisposed || this.#participantId === undefined) {
      return;
    }
    this.#hasPendingRequest = true;
    this.#scheduler.request(reason);
    this.#publish();
  }

  /**
   * Read the whole set now, publish it if this round is still the live one, and hand
   * the outcome back to whoever asked.
   *
   * THE ONE CALL SITE, reached by the scheduler and by the writer's post-write
   * re-read. The writer gets the outcome back because it composes a queued flip
   * against what the daemon actually stored; what it never gets is the decision about
   * whether that outcome reaches the screen, which is this round's alone.
   *
   * A REJECTION PUBLISHES TOO, under the same round, and then travels on. The set on
   * screen is no longer known to be what the store holds, and leaving the rows up
   * while only one switch carried a refusal would present a stale set as current —
   * the same disposition the section already takes for a refused opening read. The
   * re-throw is for the caller: the writer names its own half of a failed write in
   * its own vocabulary, which is not this read's to compose.
   */
  public async readSet(): Promise<AttentionPreferenceReadOutcome> {
    const participantId = this.#participantId;
    if (participantId === undefined) {
      throw new Error("the preference set cannot be read before a participant is resolved");
    }
    // Taken rather than joined: two reads of one set DO supersede each other, and the
    // serial written here is what makes an earlier reply install nothing.
    const round = this.#rounds.supersedeAndClaim(this, SET_READ_KEY);
    this.#outstandingReadCount += 1;
    try {
      const outcome = await this.#bridge.growth.attentionPreferenceRead({ participantId });
      round.settle(() => {
        this.#reading = { kind: "answered", outcome };
      });
      return outcome;
    } catch (rejection: unknown) {
      const refusal = consoleRefusalFrom(rejection, ATTENTION_PREFERENCE_ORIGIN);
      round.settle(() => {
        this.#reading = { kind: "unreadable", refusal };
      });
      throw rejection;
    } finally {
      round.release();
      this.#outstandingReadCount -= 1;
      // One publish per settlement, whether or not this round was the one admitted:
      // a superseded reply changes no reading and still changes what is in flight.
      this.#publish();
    }
  }

  /** Terminal. A reply landing after this publishes nothing. */
  public dispose(): void {
    this.#isDisposed = true;
    this.#scheduler.dispose();
    this.#rounds.supersedeAll();
  }

  /**
   * Compose one transition and hand out a new identity.
   *
   * The snapshot is HELD rather than composed per read, because `useSyncExternalStore`
   * compares identity: a getter returning a fresh object every call renders forever.
   * The in-flight member is DERIVED here rather than stored, so there is no second
   * answer to keep in step with the two counters that decide it.
   */
  #publish(): void {
    this.#snapshot = {
      reading: this.#reading,
      isReadInFlight: this.#hasPendingRequest || this.#outstandingReadCount > 0,
      revision: this.#snapshot.revision + 1,
    };
    this.#changes.emit();
  }
}
