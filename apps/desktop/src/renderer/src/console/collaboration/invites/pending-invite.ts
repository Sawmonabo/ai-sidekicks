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

import {
  Emitter,
  PENDING_INVITE_QUEUE_MAX,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../../core/index.js";
import {
  consoleClockFor,
  type ConsoleBridge,
  type GrowthInviteOutcome,
  type GrowthOutcome,
  type GrowthPendingInvite,
} from "../../bridge/index.js";
import { consoleRefusalFrom } from "../../seats/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../../store/index.js";
import { PENDING_INVITE_ORIGIN, PendingInviteFeeds } from "./pending-invite-feeds.js";

/** What one act on a reference can be waiting on. */
export type PendingInviteAct = "confirm" | "retry" | "dismiss";

/** What a surface renders. Recomputed only when something below actually moved. */
export interface PendingInviteSnapshot {
  /** The invitation at the head of the queue, or `undefined` where none is waiting. */
  readonly invite: GrowthPendingInvite | undefined;
  /** Invitations behind the head. Rendered as a count, never as a second card. */
  readonly waitingBehind: number;
  /** How the head's own attempt ended, once one has. */
  readonly outcome: GrowthInviteOutcome | undefined;
  /** The act in flight on the head, if any. Nothing else may be dispatched. */
  readonly actInFlight: PendingInviteAct | undefined;
  /** An act that the port refused. Cleared by the next act on the same head. */
  readonly actRefusal: ConsoleRefusal | undefined;
  /** A feed that was reached and broke. The unbuilt-wire case is deliberately absent. */
  readonly feedRefusal: ConsoleRefusal | undefined;
}

const EMPTY_SNAPSHOT: PendingInviteSnapshot = {
  invite: undefined,
  waitingBehind: 0,
  outcome: undefined,
  actInFlight: undefined,
  actRefusal: undefined,
  feedRefusal: undefined,
};

/**
 * The invitations waiting on this window, and the acts a person can perform on them.
 *
 * A class with private fields: it owns an openable feed pair, a bounded queue, a latch
 * and a scheduler — and therefore a teardown — and a suite drives every arm of it
 * without rendering anything.
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
  readonly #queue: GrowthPendingInvite[] = [];
  readonly #outcomeByReference = new Map<string, GrowthInviteOutcome>();
  readonly #bridge: ConsoleBridge;
  readonly #feeds: PendingInviteFeeds;
  readonly #refresh: RefreshScheduler;
  #actInFlight: PendingInviteAct | undefined;
  #actRefusal: ConsoleRefusal | undefined;
  #snapshot: PendingInviteSnapshot = EMPTY_SNAPSHOT;
  #isDisposed = false;

  public constructor(bridge: ConsoleBridge) {
    this.#bridge = bridge;
    this.#feeds = new PendingInviteFeeds(bridge, {
      onInvite: (invite) => {
        this.#enqueue(invite);
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
    this.#queue.length = 0;
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
    this.#dispatch("confirm", async (reference) =>
      this.#bridge.growth.inviteConfirmPending({ reference }),
    );
  }

  /**
   * Try the same reference again after an attempt that could be retried.
   *
   * The same reference rather than a new one, so a second attempt is the same
   * invitation and not a second claim on it.
   */
  public retry(): void {
    this.#dispatch("retry", async (reference) =>
      this.#bridge.growth.inviteRetryPending({ reference }),
    );
  }

  /**
   * Put this invitation away.
   *
   * LOCAL AND SILENT. `Spec-002 §Required Behavior` mints no decline verb and
   * `InviteState` has no declined member to move to, so nobody is told: what this
   * does is release the reference main is holding, which is a different act from
   * refusing an invitation and is the only one the wire has.
   */
  public dismiss(): void {
    this.#dispatch("dismiss", async (reference) =>
      this.#bridge.growth.inviteDismissPending({ reference }),
    );
  }

  /**
   * Acknowledge a settled outcome and move to whatever is behind it.
   *
   * Local, and it sends nothing: the reference is already spent, so there is nothing
   * left to release. What it releases is the SCREEN — which is why it is a press and
   * not a timer, since a result that cleared itself would be a result somebody did
   * not read.
   */
  public acknowledge(): void {
    const head = this.#queue[0];
    if (head === undefined || this.#outcomeByReference.get(head.reference) === undefined) {
      return;
    }
    this.#releaseHead();
  }

  /** Perform one act on the head, under the one-at-a-time latch. */
  #dispatch(
    act: PendingInviteAct,
    perform: (reference: string) => Promise<GrowthOutcome<undefined>>,
  ): void {
    const head = this.#queue[0];
    if (head === undefined || this.#actInFlight !== undefined) {
      return;
    }
    const { reference } = head;
    this.#actInFlight = act;
    this.#actRefusal = undefined;
    this.#publish();
    void perform(reference).then(
      (outcome) => {
        this.#settleAct(act, reference, outcome.status === "served" ? undefined : outcome);
      },
      (rejection: unknown) => {
        this.#settleAct(act, reference, consoleRefusalFrom(rejection, PENDING_INVITE_ORIGIN));
      },
    );
  }

  /** Install one act's answer, unless the head moved out from under it. */
  #settleAct(act: PendingInviteAct, reference: string, refusal: ConsoleRefusal | undefined): void {
    if (this.#isDisposed || this.#actInFlight !== act || this.#queue[0]?.reference !== reference) {
      return;
    }
    this.#actInFlight = undefined;
    this.#actRefusal = refusal;
    if (refusal === undefined && act === "dismiss") {
      // The one act whose own reply settles it: a dismissal produces no outcome,
      // because nothing happened that anybody is owed an answer about.
      this.#releaseHead();
      return;
    }
    this.#publish();
  }

  /** Drop the head, forget its outcome, and show whatever was behind it. */
  #releaseHead(): void {
    const head = this.#queue.shift();
    if (head !== undefined) {
      this.#outcomeByReference.delete(head.reference);
    }
    this.#actRefusal = undefined;
    this.#publish();
  }

  /** Queue one arrival, up to the bound, ignoring one this window already holds. */
  #enqueue(invite: GrowthPendingInvite): void {
    if (this.#queue.some((held) => held.reference === invite.reference)) {
      return;
    }
    if (this.#queue.length >= PENDING_INVITE_QUEUE_MAX) {
      return;
    }
    this.#queue.push(invite);
    this.#publish();
  }

  /**
   * Install one outcome against the reference it names.
   *
   * MATCHED ON THE REFERENCE rather than assumed to be about the head: a window can
   * receive the answer to an invitation it dismissed a moment ago, and an outcome
   * rendered against the wrong invitation is worse than one nobody sees.
   */
  #applyOutcome(outcome: GrowthInviteOutcome): void {
    if (!this.#queue.some((held) => held.reference === outcome.reference)) {
      return;
    }
    this.#outcomeByReference.set(outcome.reference, outcome);
    if (this.#queue[0]?.reference === outcome.reference) {
      this.#actInFlight = undefined;
    }
    this.#publish();
  }

  /** Rebuild the reading and tell the sinks. The one writer of `#snapshot`. */
  #publish(): void {
    const head = this.#queue[0];
    this.#snapshot = {
      invite: head,
      waitingBehind: Math.max(0, this.#queue.length - 1),
      outcome: head === undefined ? undefined : this.#outcomeByReference.get(head.reference),
      actInFlight: this.#actInFlight,
      actRefusal: this.#actRefusal,
      feedRefusal: this.#feeds.refusal,
    };
    this.#changes.emit();
  }
}

/**
 * Whether an outcome names a step a person can take again.
 *
 * ONLY THE TWO AUTHENTICATION ARMS. A wire refusal is the control plane's own answer
 * about this invitation — not found, already accepted, expired, revoked — and pressing
 * again sends the identical request to the identical answer, so offering a retry there
 * would be offering a control that cannot work. Authentication is the opposite: it
 * names something the person completes and then comes back from.
 */
export function isRetryableOutcome(outcome: GrowthInviteOutcome | undefined): boolean {
  return outcome?.kind === "authentication-required" || outcome?.kind === "authentication-failed";
}
