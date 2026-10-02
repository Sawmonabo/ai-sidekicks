// The one brokered sign-in this window may have running, and what a second start gets.
//
// The daemon runs one brokered flow at a time, so a second start is refused here, in the
// same tick as the press, through the single-flight latch. A boolean read from the rendered
// flow could be stale, and two presses in one frame would both dispatch.
//
// The tracker takes the start and cancel calls bound, not a bridge: they are acts, not
// readings that go stale. The words for what is in the way are composed once, here.
//
// Exactly two things end a flow: a cancel that answered `canceled` or `notFound`, and
// the registry's own tail reporting that attempt completed
// ({@link ProviderSignInFlowTracker.noteLoginCompleted}).

import type { ProviderAccountId, ProviderAccountLoginResponse } from "@ai-sidekicks/contracts";

import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { GenerationLatch } from "@renderer/lib/reads/generation-latch.js";
import {
  IDLE_PROVIDER_SIGN_IN_FLOW,
  PROVIDER_SIGN_IN_ENDED_BY_REGISTRY,
  isProviderSignInRunning,
  readProviderSignInAccountId,
  type ProviderSignInCancelOutcome,
  type ProviderSignInFlowState,
  type ProviderSignInStartOutcome,
} from "./provider-sign-in-flow.js";

/** The subsystem name the one refusal this module raises on its own carries. */
export const PROVIDER_SIGN_IN_REFUSAL_ORIGIN = "provider-account-sign-in";

/** Why this tracker declined a start it never sent. Its own code, never a daemon's. */
const START_ALREADY_RUNNING_CODE = "sign-in-already-running";

/**
 * The one key the sign-in flow is claimed under.
 *
 * One key for every account: the daemon runs one brokered flow whichever account it is for,
 * so a key per account would admit a second start the daemon then refuses.
 */
const PROVIDER_SIGN_IN_FLOW_KEY = "brokered-sign-in";

/** Everything the accounts fixture body renders the sign-in flow from, in one value. */
export interface ProviderSignInFlowTrackerSnapshot {
  /** The flow this window is running, where it is running one. */
  readonly flow: ProviderSignInFlowState;
  /** The last refused start per account, dropped when that account is tried again. */
  readonly refusalByAccountId: ReadonlyMap<ProviderAccountId, Refusal>;
  /** Bumped on every transition, so `useSyncExternalStore` sees a new identity. */
  readonly revision: number;
}

const NOTHING_STARTED: ProviderSignInFlowTrackerSnapshot = {
  flow: IDLE_PROVIDER_SIGN_IN_FLOW,
  refusalByAccountId: new Map(),
  revision: 0,
};

/** The calls a {@link ProviderSignInFlowTracker} makes, all supplied by its owner. */
export interface ProviderSignInFlowTrackerOptions {
  /** Start one brokered sign-in. Supplied by the caller, never held here. */
  readonly startProviderSignIn: (
    accountId: ProviderAccountId,
  ) => Promise<ProviderSignInStartOutcome>;
  /** Cancel the flow this tracker holds. Likewise supplied by the caller. */
  readonly cancelProviderSignIn: (
    attempt: ProviderAccountLoginResponse,
  ) => Promise<ProviderSignInCancelOutcome>;
  /**
   * Called once a canceled flow has settled, either way.
   *
   * A flow ending says nothing about the account, so the owner of the registry read takes
   * a fresh one.
   */
  readonly onFlowSettled: () => void;
}

/**
 * One window's brokered sign-in: which flow is running, and which starts were declined.
 *
 * Owns the single-flight claim and decides which settlement installs. The React binding is
 * in `AccountsFixtureBody.tsx`.
 */
export class ProviderSignInFlowTracker {
  readonly #startProviderSignIn: (
    accountId: ProviderAccountId,
  ) => Promise<ProviderSignInStartOutcome>;
  readonly #cancelProviderSignIn: (
    attempt: ProviderAccountLoginResponse,
  ) => Promise<ProviderSignInCancelOutcome>;
  readonly #onFlowSettled: () => void;
  readonly #changes = new Emitter<void>("sign-in flow change");
  /**
   * Single-flight register for the sign-in key.
   *
   * Held from the start that took it until the flow ends or is canceled, so a settlement
   * for a superseded round, or after dispose, installs nothing.
   */
  readonly #flows = new GenerationLatch();
  /**
   * The newest attempt the registry has reported finished.
   *
   * A fast flow can report completion while its start reply is still traveling; without
   * this the tracker would record a finished attempt as running. One id is enough because
   * the daemon runs one brokered flow at a time.
   */
  #completedAttemptId: string | undefined = undefined;
  #snapshot: ProviderSignInFlowTrackerSnapshot = NOTHING_STARTED;
  #isDisposed = false;

  public constructor(options: ProviderSignInFlowTrackerOptions) {
    this.#startProviderSignIn = options.startProviderSignIn;
    this.#cancelProviderSignIn = options.cancelProviderSignIn;
    this.#onFlowSettled = options.onFlowSettled;
  }

  public snapshot(): ProviderSignInFlowTrackerSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Start a brokered sign-in for one account.
   *
   * A press that reaches here while a flow runs (a stale frame, a keyboard activation
   * racing a commit) gets a refusal on its own row saying what is in the way; the running
   * flow is untouched.
   */
  public start(accountId: ProviderAccountId): void {
    if (this.#isDisposed) {
      return;
    }
    const claim = this.#flows.claim(this, PROVIDER_SIGN_IN_FLOW_KEY);
    if (claim === undefined) {
      this.#publish({
        refusalByAccountId: this.#refusalsWith(
          accountId,
          startAlreadyRunning(this.#isHolder(accountId)),
        ),
      });
      return;
    }
    // Dropped on the attempt, not its settlement, so a repeat press does not show last
    // time's reason beside this time's spinner.
    this.#publish({
      flow: { kind: "starting", accountId },
      refusalByAccountId: this.#refusalsWithout(accountId),
    });
    void this.#startProviderSignIn(accountId).then((outcome) => {
      claim.settle(() => {
        if (outcome.attempt.attemptId === this.#completedAttemptId) {
          // The registry reported this attempt finished before its start reply arrived;
          // recording it would put a card on screen for a flow that is over.
          claim.release();
          this.#settleEndedFlow(PROVIDER_SIGN_IN_ENDED_BY_REGISTRY);
          return;
        }
        this.#publish({ flow: outcome });
      });
    });
  }

  /**
   * Cancel the live flow.
   *
   * `canceled` and `notFound` both mean the daemon holds no flow of this window's, so both
   * end the flow and free the key.
   */
  public cancel(): void {
    const { flow } = this.#snapshot;
    if (this.#isDisposed || flow.kind !== "live") {
      return;
    }
    const { accountId, attempt } = flow;
    const round = this.#flows.currentClaim(this, PROVIDER_SIGN_IN_FLOW_KEY);
    this.#publish({ flow: { kind: "canceling", accountId, attempt } });
    void this.#cancelProviderSignIn(attempt).then((outcome) => {
      round.settle(() => {
        this.#flows.supersede(this, PROVIDER_SIGN_IN_FLOW_KEY);
        this.#publish({ flow: outcome });
        this.#onFlowSettled();
      });
    });
  }

  /**
   * The registry's tail reports one brokered attempt finished.
   *
   * Only the attempt id this tracker holds ends its flow: another window's flow completes
   * on the same node-scoped tail and must not clear this card's verification code. Every
   * completion is remembered, matched or not, for {@link start} to read.
   */
  public noteLoginCompleted(attemptId: string): void {
    if (this.#isDisposed) {
      return;
    }
    this.#completedAttemptId = attemptId;
    const { flow } = this.#snapshot;
    if (!("attempt" in flow) || flow.attempt.attemptId !== attemptId) {
      return;
    }
    this.#flows.supersede(this, PROVIDER_SIGN_IN_FLOW_KEY);
    this.#settleEndedFlow(PROVIDER_SIGN_IN_ENDED_BY_REGISTRY);
  }

  /** Terminal. A settlement landing after this installs nothing. */
  public dispose(): void {
    this.#isDisposed = true;
    this.#flows.supersedeAll();
  }

  /**
   * Leave the flow ended and ask the owner of the registry read to take a fresh one.
   *
   * A flow ending is never a verdict about the account, so every path that ends one owes
   * the same re-read.
   */
  #settleEndedFlow(because: string): void {
    this.#publish({ flow: { kind: "ended", because } });
    this.#onFlowSettled();
  }

  /** Whether the account asking is the one whose sign-in is already running. */
  #isHolder(accountId: ProviderAccountId): boolean {
    return findRunningProviderSignInAccountId(this.#snapshot) === accountId;
  }

  #refusalsWith(
    accountId: ProviderAccountId,
    refusal: Refusal,
  ): ReadonlyMap<ProviderAccountId, Refusal> {
    return new Map(this.#snapshot.refusalByAccountId).set(accountId, refusal);
  }

  #refusalsWithout(accountId: ProviderAccountId): ReadonlyMap<ProviderAccountId, Refusal> {
    const remaining = new Map(this.#snapshot.refusalByAccountId);
    remaining.delete(accountId);
    return remaining;
  }

  /**
   * Fold one transition in and hand out a new identity.
   *
   * The snapshot is held, not composed per read, because `useSyncExternalStore` compares
   * identity.
   */
  #publish(changes: Partial<Omit<ProviderSignInFlowTrackerSnapshot, "revision">>): void {
    this.#snapshot = { ...this.#snapshot, ...changes, revision: this.#snapshot.revision + 1 };
    this.#changes.emit();
  }
}

/**
 * The account whose sign-in is running, where one is.
 *
 * A function over the snapshot, so the page and the tracker's guard derive it the same way
 * from one reading.
 */
export function findRunningProviderSignInAccountId(
  snapshot: ProviderSignInFlowTrackerSnapshot,
): ProviderAccountId | undefined {
  const { flow } = snapshot;
  return isProviderSignInRunning(flow) ? readProviderSignInAccountId(flow) : undefined;
}

/**
 * What is in the way of a start, in the words both places that say it use.
 *
 * The other-account sentence names the account where the caller holds a label for it, and
 * says "another account" where it does not.
 */
export function describeRunningProviderSignIn(options: {
  readonly isTheSameAccount: boolean;
  readonly holdingAccountLabel: string | undefined;
}): string {
  if (options.isTheSameAccount) {
    return "A sign-in for this account is already running. Finish it at the provider, or cancel it, before starting another.";
  }
  const holder = options.holdingAccountLabel ?? "another account";
  return `A sign-in for ${holder} is already running. Cancel it before starting this one — this machine runs one brokered sign-in at a time.`;
}
/**
 * Why this tracker declined a start it never sent.
 *
 * Its own code rather than the daemon's `provideraccount.signin_in_flight`: that call was
 * never made, so borrowing the code would report a daemon refusal that did not happen. The
 * detail is the sentence above without a label, since the registry is the page's.
 */
function startAlreadyRunning(isTheSameAccount: boolean): Refusal {
  return refuse(
    PROVIDER_SIGN_IN_REFUSAL_ORIGIN,
    START_ALREADY_RUNNING_CODE,
    describeRunningProviderSignIn({ isTheSameAccount, holdingAccountLabel: undefined }),
  );
}
