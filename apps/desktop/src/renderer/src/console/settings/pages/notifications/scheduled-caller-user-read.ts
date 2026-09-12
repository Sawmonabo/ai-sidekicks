// Which user this window is, asked again whenever the window comes back.
//
// NAMED FOR THE POLICY IT OWNS AND NOT FOR THE WIRE IT CALLS. The proposals family
// holds a reader of the same growth operation under the opposite rule — asked lazily by
// the first act that needs it, absorbing every non-answer into an absence a request may
// omit — and both classes were called `CallerUserRead`, in two files of that
// name. A grep for the noun returned two different jobs, so each is named for its job:
// that one is the attribution reader, and this is the SCHEDULED read, published onto an
// arm a person looks at.
//
// IT WAS AN EFFECT THAT RAN ONCE, and that is the whole reason this module exists.
// The identity call was made from a `useEffect` keyed on the bridge and the retained
// session, so a transport outage — a call that answered `unavailable`, or a rejection
// that never reached the daemon at all — left the effect's dependencies exactly where
// they were and nothing ever asked again. The preference reader behind it takes the
// user as its subject, so with none it refuses every focus and every reconnect
// by design: the section stayed unusable for the life of the window, and the only way
// back was to leave the page and return to it.
//
// SO IT IS A SCHEDULED READ LIKE EVERY OTHER ONE. It declares
// `ReadTriggerTarget` and takes the window's three triggers through
// `store/read/read-triggers.ts` — mount, focus, reconnect — and neither of the
// session-scoped two: this asks who the CALLER is, and no event in a session's own
// timeline answers that. Every trigger reaches `store/read/refresh-scheduler.ts`, so the burst a
// returning window produces costs one call, and every reply is measured against
// `store/read/generation-latch.ts`, so two answers landing out of order install in the
// order they were TAKEN rather than the order they arrived.
//
// AND THE WINDOW'S TRIGGERS ARE THE SAME ONES THE SET BEHIND IT TAKES, which is what
// makes the retry reach all the way through: a focus asks who this is, the answer
// names a user, and the reading held for that user reads its own set on
// its own mount. One trigger, one chain, no second vocabulary for "try again".

import type { ConsoleBridge } from "../../../bridge/index.js";
import { Emitter, type ConsoleClock, type Unsubscribe } from "../../../core/index.js";
import { CALLER_USER_ORIGIN, consoleRefusalFrom } from "../../../seats/index.js";
import {
  GenerationLatch,
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../../../store/index.js";
import type { CallerUserReading } from "./attention-preference-model.js";

/**
 * The one key every read of this identity is taken under.
 *
 * One key and not one per trigger: what supersedes a read here is another read of the
 * SAME question, whoever asked for it. A key per path would be two registers that
 * cannot order each other, which is the defect this module's sibling closes for the
 * preference set and this one closes for the identity in front of it.
 */
const IDENTITY_READ_KEY = "caller-user-read";

export interface ScheduledCallerUserReadOptions {
  readonly bridge: ConsoleBridge;
  /**
   * The session the question is asked of, or `undefined` where no session is open.
   *
   * An absence rather than a placeholder, on the sibling reading's rule: the question
   * is asked OF a session, so one taken under a guessed id would name whoever that
   * other session's caller is. A reading addressed at none asks nothing and answers
   * nothing, and the page renders the no-session shape it already has.
   */
  readonly sessionId: string | undefined;
  /** The clock the scheduler arms on. The fixture's frozen one under a scenario. */
  readonly clock: ConsoleClock;
}

/**
 * Who this window is, kept current by the window's own triggers.
 *
 * A class with private fields rather than an effect and a `useState` cell, because it
 * owns a scheduler, a single-flight round, and the rule that decides which reply
 * installs. The React binding is
 * `stored-attention-preferences.ts`, which holds nothing of its own.
 */
export class ScheduledCallerUserRead implements ReadTriggerTarget {
  /**
   * No timeline event refreshes this read, and the empty set states it.
   *
   * The question is which user this CALLER is, which no event in any session's
   * timeline answers — so this takes the window's three triggers and neither of the
   * session-scoped two, exactly as the preference set behind it does.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #bridge: ConsoleBridge;
  readonly #sessionId: string | undefined;
  readonly #changes = new Emitter<void>("caller user read change");
  readonly #rounds = new GenerationLatch();
  readonly #scheduler: RefreshScheduler;
  /** What the last admitted reply said. Written only inside an admitted round. */
  #reading: CallerUserReading | undefined = undefined;
  #isDisposed = false;

  public constructor(options: ScheduledCallerUserReadOptions) {
    this.#bridge = options.bridge;
    this.#sessionId = options.sessionId;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#read();
      },
      // The read body turns a rejection into the `unreadable` arm itself and never
      // rejects, so this arm covers a defect in the publish rather than anything the
      // daemon did. It must exist: without it the scheduler re-throws inside a timer
      // callback, where no surface has a `catch` to render.
      onError: () => undefined,
    });
  }

  /**
   * What the page renders from. One held value, so its identity is stable.
   *
   * `undefined` until the first read settles, which is a third state rather than a
   * refusal: the question has been asked and has not been answered, and a page that
   * read it as either arm would say something about a call still in flight.
   */
  public snapshot(): CallerUserReading | undefined {
    return this.#reading;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** Whether this reading has been disposed. The re-mint its holder takes. */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /**
   * Ask who this is.
   *
   * Every window trigger arrives here and none of them calls the port: what a burst of
   * reasons costs is the scheduler's decision, and a page that asked directly is the
   * page that had two identity calls outstanding at once.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#isDisposed || this.#sessionId === undefined) {
      return;
    }
    this.#scheduler.request(reason);
  }

  /** Terminal. A reply landing after this publishes nothing. */
  public dispose(): void {
    this.#isDisposed = true;
    this.#scheduler.dispose();
    this.#rounds.supersedeAll();
  }

  /**
   * Ask the daemon, and publish only if this round is still the live one.
   *
   * BOTH ARMS PUBLISH, and the rejection arm is why the page does not sit on "Finding
   * out who you are" forever: the port's own vocabulary has no member for a call that
   * produced no outcome at all, so the console composes one in its own words. What
   * neither arm is allowed to do is install over a newer answer — the round decides
   * that, and it decides it the same way for the reply and for the refusal.
   */
  async #read(): Promise<void> {
    const sessionId = this.#sessionId;
    if (sessionId === undefined) {
      return;
    }
    const round = this.#rounds.currentClaim(this, IDENTITY_READ_KEY);
    try {
      const outcome = await this.#bridge.growth.callerUserRead({ sessionId });
      round.settle(() => {
        this.#publish({ kind: "answered", outcome });
      });
    } catch (rejection: unknown) {
      round.settle(() => {
        this.#publish({
          kind: "unreadable",
          refusal: consoleRefusalFrom(rejection, CALLER_USER_ORIGIN),
        });
      });
    }
  }

  #publish(reading: CallerUserReading): void {
    this.#reading = reading;
    this.#changes.emit();
  }
}
