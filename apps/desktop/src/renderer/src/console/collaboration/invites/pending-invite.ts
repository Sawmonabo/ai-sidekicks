// The renderer's half of the deep-link invite lifecycle, behind one adapter.
//
// WHY AN ADAPTER AND NOT FIVE CALLS FROM A COMPONENT. `Plan-023 §Invariants` I-023-5
// keeps the raw invite token in the main process and I-023-10 makes what the renderer
// holds instead an opaque, single-use, TTL-bounded REFERENCE. The five operations that
// implement that — two feeds and three acts — are one state machine and not five
// reads: an act is dispatched on a reference, its answer arrives on a different feed
// than the one the invitation came in on, and which reference is on screen decides
// which frame of that second feed is about it. Split across a component's effects
// that is a machine nobody can drive without mounting one, so it is a class, and the
// component reads a snapshot.
//
// THE MAIN-SIDE HALF IS `T-023r-5-5` — the `sidekicks://invite/<token>` protocol
// handler, the bridge-event dispatcher, and the reference lifecycle whose references
// these are. This module is the consumer of that, built against the fixture through
// the growth port's `pending-invite-namespace` row; the shipped acceptance component
// is not mounted here, because its prop is the raw token this invariant confines and
// its own header records that the reshape retires that prop.
//
// NOTHING HERE ACCEPTS ANYTHING BY ITSELF. `confirm` runs when a person presses the
// one control that confirms, and never on open, on arrival, or on a retry the console
// decided to attempt: an invitation is single-use, so an act nobody asked for spends
// something that cannot be got back.
//
// THE PENDING FEED CARRIES THREE STATES AND THIS READS ALL THREE. `Plan-023 §Phase 2
// — IPC Bridge Registry And Per-Surface Handlers` task T-023r-2-5 keys the pending
// side on `status`: a preview that succeeded and can be confirmed, one the control
// plane refused, and one that could not be put at all. The last two mint no
// reference, so the acts that spend one are unreachable on them by construction, and
// the only act either admits is the retry — which takes the `unavailable` arm's own
// attempt handle and never a reference. WHICH ARRIVALS ARE HELD is `pending-invite-arrivals.ts`, split out on
// the same line the feeds are.
//
// A RETRY IS OFFERED FROM ONE STATE AND NOT FROM AN OUTCOME. An acceptance that
// needs authentication is IN PROGRESS — main is driving the ceremony and the
// reference survives it — and one that failed authentication is TERMINAL, its
// reference released with the failure. Neither can be re-driven from here: a second
// act on either would send a reference main has either lent out or let go, and to an
// operation that does not take one. What a person can try again is a preview that
// never reached the control plane, and that arm carries the handle to try it with.
//
// A REFERENCE IS SPENT WHERE THE ACT IS DISPATCHED, not where its answer lands. A
// second press while the first attempt is unsettled is refused by the latch below
// rather than sent — the mutation coordinator's rule next door, applied to a resource
// whose double use the wire itself forbids.
//
// THE OPEN IS THE READ, and it goes behind the scheduler every reading in this console
// goes behind. What this holds is a pair of live feeds, so it learns nothing from a
// clock and everything from whether those feeds are up — which is why the read it
// performs is "open whichever one is not" and why the trigger that matters is a
// repaired connection rather than an elapsed interval.

import { Emitter, type ConsoleRefusal, type Unsubscribe } from "../../core/index.js";
import {
  consoleClockFor,
  type ConsoleBridge,
  type GrowthInviteOutcome,
  type GrowthOutcome,
  type GrowthPendingInvite,
  type GrowthPendingInviteState,
} from "../../bridge/index.js";
import { consoleRefusalFrom } from "../../seats/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../../store/index.js";
import { PendingInviteArrivals } from "./pending-invite-arrivals.js";
import { PENDING_INVITE_ORIGIN, PendingInviteFeeds } from "./pending-invite-feeds.js";
import {
  EMPTY_PENDING_INVITE_SNAPSHOT,
  isInviteReferenceHeld,
  type PendingInviteAct,
  type PendingInviteSnapshot,
} from "./pending-invite-reading.js";

// The reading travels with the machine that publishes it: every surface holding this
// adapter renders that shape, and a consumer that had to name two modules to do it
// would be reading one value through two doors.
export type { PendingInviteSnapshot } from "./pending-invite-reading.js";

/**
 * The invitations waiting on this window, and the acts a person can perform on them.
 *
 * A class with private fields: it owns an openable feed pair, a bounded arrival
 * queue, a latch and a scheduler — and therefore a teardown — and a suite drives every
 * arm of it without rendering anything.
 */
export class PendingInviteAdapter implements ReadTriggerTarget {
  /**
   * Nothing in this window's timeline says an invitation arrived.
   *
   * The empty set is a claim rather than an omission, and here it is a strong one: a
   * deep-link invitation is about a session this window is NOT in, so no event of any
   * kind on any session it can see could name one. The feeds are the only authority,
   * and what this reading goes stale on is a connection, never a kind.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #changes = new Emitter<void>("pending-invite change");
  readonly #arrivals = new PendingInviteArrivals();
  readonly #outcomeByReference = new Map<string, GrowthInviteOutcome>();
  readonly #bridge: ConsoleBridge;
  readonly #feeds: PendingInviteFeeds;
  readonly #refresh: RefreshScheduler;
  #actInFlight: PendingInviteAct | undefined;
  #actRefusal: ConsoleRefusal | undefined;
  #snapshot: PendingInviteSnapshot = EMPTY_PENDING_INVITE_SNAPSHOT;
  #isDisposed = false;

  public constructor(bridge: ConsoleBridge) {
    this.#bridge = bridge;
    this.#feeds = new PendingInviteFeeds(bridge, {
      onArrival: (arrival) => {
        this.#admit(arrival);
      },
      onOutcome: (outcome) => {
        this.#applyOutcome(outcome);
      },
      onRefusalChanged: () => {
        this.#publish();
      },
    });
    this.#refresh = new RefreshScheduler({
      // The fixture's frozen clock wherever a scenario is playing and the real one
      // otherwise, resolved once — the fixture bridge makes the frozen clock the only
      // clock the renderer reads in fixture mode.
      clock: consoleClockFor(bridge),
      perform: async () => {
        await this.#feeds.open();
      },
      // A feed that could not be opened is already this reading's own `feedRefusal`,
      // so re-throwing would surface the same fact again as an unhandled rejection.
      onError: () => undefined,
    });
  }

  /**
   * Ask this reading to make sure its channel is up.
   *
   * THE OPEN IS THIS READING'S `subscribe` READ, and it is taken directly rather than
   * behind the scheduler for the reason `bridge/queue/queue-reading.ts` states: the
   * fixture's clock is frozen and only a scenario beat moves it, so a first open
   * inside a debounce window would never happen at all in fixture mode. It is
   * idempotent, so a second surface arriving opens nothing. Every other reason — a
   * regained focus, a repaired connection — is a REPAIR rather than a first arrival,
   * and goes behind the scheduler so a burst of them costs one attempt.
   */
  public requestRead(reason: RefreshReason): void {
    if (this.#isDisposed) {
      return;
    }
    if (reason === "subscribe") {
      void this.#feeds.open();
      return;
    }
    this.#refresh.request(reason);
  }

  /** Whether this adapter has been released. Read by the resource seam that owns it. */
  public get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /** Close both feeds and forget everything. Terminal. */
  public dispose(): void {
    this.#isDisposed = true;
    this.#refresh.dispose();
    this.#feeds.close();
    this.#arrivals.clear();
    this.#outcomeByReference.clear();
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /** The current reading. Identity-stable between changes, for `useSyncExternalStore`. */
  public snapshot(): PendingInviteSnapshot {
    return this.#snapshot;
  }

  /**
   * Confirm the invitation on screen. The one act that accepts.
   *
   * Nothing is applied here on the way out: the answer arrives on the outcome feed,
   * because acceptance runs in main and can take an authentication detour that no
   * reply to this call could express.
   */
  public confirm(): void {
    const head = this.#readyHead();
    if (head === undefined) {
      return;
    }
    const { reference } = head;
    this.#dispatch("confirm", reference, async () =>
      this.#bridge.growth.inviteConfirmPending({ reference }),
    );
  }

  /**
   * Put the deep link whose preview could not be put to the control plane again.
   *
   * ON THE ATTEMPT HANDLE AND NEVER ON A REFERENCE, and only from the one arm that
   * carries one. A retry re-drives a PREVIEW, which is what has not happened yet on
   * this arm; the two authentication outcomes look retryable and are not, because one
   * is a ceremony main is still driving and the other has already released the
   * reference it was driving it for. Two protocol URLs can be outstanding at once, so
   * the handle is what says which link this means.
   *
   * NOT THE OUTCOME ARM OF THE SAME NAME. An acceptance that could not be put reaches
   * a prompt this window already HOLDS, and the act that puts it again is the
   * confirmation put again on that reference — the same reason this one takes a
   * handle: what could not be put is what the recovery repeats.
   */
  public retry(): void {
    const head = this.#arrivals.head;
    if (head?.status !== "unavailable") {
      return;
    }
    const { attempt } = head;
    this.#dispatch("retry", attempt, async () =>
      this.#bridge.growth.inviteRetryPending({ attempt }),
    );
  }

  /**
   * Put this invitation away.
   *
   * LOCAL AND SILENT. `Spec-002 §Required Behavior` mints no decline verb and
   * `InviteState` has no declined member to move to, so nobody is told: what this
   * does is release the reference main is holding, which is a different act from
   * refusing an invitation and is the only one the wire has. It is therefore also the
   * close path after an ANSWER main kept the reference for, and the head is released
   * on this call's own settlement, so a refused dismissal moves nothing at all.
   */
  public dismiss(): void {
    const head = this.#readyHead();
    if (head === undefined) {
      return;
    }
    const { reference } = head;
    this.#dispatch("dismiss", reference, async () =>
      this.#bridge.growth.inviteDismissPending({ reference }),
    );
  }

  /**
   * Acknowledge a settled prompt and move to whatever is behind it.
   *
   * Local, and it sends nothing: a spent reference has nothing left to release and a
   * preview that produced none never had anything. What it releases is the SCREEN —
   * which is why it is a press and not a timer, since a result that cleared itself
   * would be a result somebody did not read.
   *
   * A REFERENCE MAIN STILL HOLDS IS NOT ACKNOWLEDGEABLE, on the lifecycle's own
   * predicate: an acceptance waiting on authentication and one the wire itself marked
   * retryable are both handles a local release would strand until their TTL, ready to
   * surface the same invitation on the next replay. {@link dismiss} is the way out.
   */
  public acknowledge(): void {
    const head = this.#arrivals.head;
    if (head === undefined) {
      return;
    }
    if (
      head.status === "ready" &&
      isInviteReferenceHeld(this.#outcomeByReference.get(head.reference))
    ) {
      return;
    }
    this.#releaseHead();
  }

  /** The head, where it is the one arm carrying a reference to act on. */
  #readyHead(): GrowthPendingInvite | undefined {
    const head = this.#arrivals.head;
    return head?.status === "ready" ? head : undefined;
  }

  /**
   * The handle the head is addressed by, whichever arm it is.
   *
   * What an act's answer is checked against, so an answer that arrives after the head
   * moved is discarded rather than installed against whatever took its place.
   */
  #headSubject(): string | undefined {
    const head = this.#arrivals.head;
    switch (head?.status) {
      case "ready":
        return head.reference;
      case "unavailable":
        return head.attempt;
      default:
        return undefined;
    }
  }

  /** Perform one act on the head, under the one-at-a-time latch. */
  #dispatch(
    act: PendingInviteAct,
    subject: string,
    perform: () => Promise<GrowthOutcome<undefined>>,
  ): void {
    if (this.#actInFlight !== undefined) {
      return;
    }
    this.#actInFlight = act;
    this.#actRefusal = undefined;
    this.#publish();
    void perform().then(
      (outcome) => {
        this.#settleAct(act, subject, outcome.status === "served" ? undefined : outcome);
      },
      (rejection: unknown) => {
        this.#settleAct(act, subject, consoleRefusalFrom(rejection, PENDING_INVITE_ORIGIN));
      },
    );
  }

  /** Install one act's answer, unless the head moved out from under it. */
  #settleAct(act: PendingInviteAct, subject: string, refusal: ConsoleRefusal | undefined): void {
    if (this.#isDisposed || this.#actInFlight !== act || this.#headSubject() !== subject) {
      return;
    }
    this.#actInFlight = undefined;
    this.#actRefusal = refusal;
    if (refusal === undefined && act !== "confirm") {
      // The two acts whose own reply settles them. A dismissal produces no outcome,
      // because nothing happened that anybody is owed an answer about; a retry's
      // answer is a fresh preview state on the pending feed rather than a reply to
      // this call, and the handle it was dispatched on is spent either way.
      this.#releaseHead();
      return;
    }
    this.#publish();
  }

  /**
   * Drop the head, forget what it recorded, and ask for anything the bound deferred.
   *
   * THE RELEASE IS WHERE CAPACITY OPENS, so it is where the replay belongs: main
   * holds every reference until an act releases it, and re-opening the pending feed
   * re-delivers them — which is the whole reason a bound is admissible above.
   */
  #releaseHead(): void {
    const released = this.#arrivals.releaseHead();
    if (released?.status === "ready") {
      this.#outcomeByReference.delete(released.reference);
    }
    this.#actRefusal = undefined;
    if (this.#arrivals.takeDeferredReplay()) {
      void this.#feeds.replayPending();
    }
    this.#publish();
  }

  /** Hold one arrival, and redraw only where the queue actually moved. */
  #admit(arrival: GrowthPendingInviteState): void {
    if (this.#arrivals.admit(arrival)) {
      this.#publish();
    }
  }

  /**
   * Install one outcome against the reference it names.
   *
   * MATCHED ON THE REFERENCE rather than assumed to be about the head: a window can
   * receive the answer to an invitation it dismissed a moment ago, and an outcome
   * rendered against the wrong invitation is worse than one nobody sees.
   */
  #applyOutcome(outcome: GrowthInviteOutcome): void {
    if (!this.#arrivals.holdsReference(outcome.reference)) {
      return;
    }
    this.#outcomeByReference.set(outcome.reference, outcome);
    if (this.#readyHead()?.reference === outcome.reference) {
      this.#actInFlight = undefined;
    }
    this.#publish();
  }

  /** Rebuild the reading and tell the sinks. The one writer of `#snapshot`. */
  #publish(): void {
    const head = this.#arrivals.head;
    const invite = head?.status === "ready" ? head : undefined;
    this.#snapshot = {
      invite,
      previewFailure: head === undefined || head.status === "ready" ? undefined : head,
      waitingBehind: this.#arrivals.waitingBehind,
      hasDeferredArrivals: this.#arrivals.hasDeferredArrivals,
      outcome: invite === undefined ? undefined : this.#outcomeByReference.get(invite.reference),
      canRetry: head?.status === "unavailable",
      actInFlight: this.#actInFlight,
      actRefusal: this.#actRefusal,
      feedRefusal: this.#feeds.refusal,
    };
    this.#changes.emit();
  }
}
