// The one brokered sign-in this window may have running, and what a second start gets.
//
// ONE FLOW, BECAUSE THE DAEMON RUNS ONE. A brokered sign-in spawns the provider's own
// login binary against one credential home, and the account plane answers a second
// start with `provideraccount.signin_in_flight`. The page held that flow in a single
// `useState` cell and offered the control on every readiness row, so a second press
// replaced the live attempt with `starting` and then with the daemon's refusal —
// taking the verification code the operator was typing and the cancel control that was
// the only way to stop the flow, over a press the page should never have accepted.
//
// SO THE GUARD IS `store/read/generation-latch.ts` AND NOT A FLAG. Single flight is that
// register's one job, its key is per SUBJECT rather than per mount, and its refusal is
// the answer `claim` already gives: a key that is held answers `undefined`, in the same
// tick as the press, before anything is dispatched. A boolean read out of the rendered
// flow would be the value from the render that produced the handler, so two presses in
// one frame would both find the plane idle and both dispatch — which is the defect one
// layer down from the one this module exists to close.
//
// AND IT HOLDS NO WIRE. The two calls are handed in bound: a class that publishes a
// snapshot AND holds a `ConsoleBridge` is a reading, and the console requires every one
// of those to be refreshable through a scheduler and the trigger contract. A start and a
// cancel are acts a person takes, not answers that go stale, so this takes the
// operations rather than the connection.
//
// AND WHAT IS IN THE WAY IS SAID ONCE. Two surfaces say it — the disabled control's
// reason, and the refusal a press that got past that control is answered with — so the
// words are composed here and the caller hands in the label it holds. Two spellings of
// one fact drift apart, and the drift is invisible because both of them render.
//
// Exactly two things end a flow: a cancel that answered `cancelled` or `notFound`, and
// the registry's own tail reporting that attempt completed
// ({@link SignInPlane.noteLoginCompleted}).

import type { ProviderAccountId, ProviderAccountLoginResponse } from "@ai-sidekicks/contracts";

import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { refuse, type ConsoleRefusal } from "@renderer/lib/refusal.js";
import { GenerationLatch } from "@renderer/console/store/read/generation-latch.js";
import {
  IDLE_SIGN_IN_FLOW,
  SIGN_IN_ENDED_BY_REGISTRY,
  isSignInPlaneHeld,
  signInPlaneHolderAccountId,
  type SignInCancelOutcome,
  type SignInFlowState,
  type SignInStartOutcome,
} from "./sign-in-flow.js";

/** The subsystem name the one refusal this module raises on its own carries. */
export const SIGN_IN_PLANE_REFUSAL_ORIGIN = "provider-account-signin";

/** Why this plane declined a start it never sent. Its own code, never a daemon's. */
const START_ALREADY_RUNNING_CODE = "signin-already-running";

/**
 * The one key the plane's flow is claimed under.
 *
 * ONE KEY FOR EVERY ACCOUNT, which is the rule rather than an economy: the daemon runs
 * one brokered flow at a time whichever account it is for, so a key per account would
 * admit two starts the daemon would then refuse — and the refusal would arrive after
 * the page had already replaced the live attempt.
 */
const SIGN_IN_FLOW_KEY = "brokered-sign-in";

/** Everything the accounts shell renders the sign-in plane from, in one value. */
export interface SignInPlaneSnapshot {
  /** The flow this window is running, where it is running one. */
  readonly flow: SignInFlowState;
  /** The last refused start per account, dropped when that account is tried again. */
  readonly refusalByAccountId: ReadonlyMap<ProviderAccountId, ConsoleRefusal>;
  /** Bumped on every transition, so `useSyncExternalStore` sees a new identity. */
  readonly revision: number;
}

const NOTHING_STARTED: SignInPlaneSnapshot = {
  flow: IDLE_SIGN_IN_FLOW,
  refusalByAccountId: new Map(),
  revision: 0,
};

export interface SignInPlaneOptions {
  /** Start one brokered sign-in. Supplied by the caller, never held here. */
  readonly startSignIn: (accountId: ProviderAccountId) => Promise<SignInStartOutcome>;
  /** Cancel the flow this plane is tracking. Likewise supplied by the caller. */
  readonly cancelSignIn: (attempt: ProviderAccountLoginResponse) => Promise<SignInCancelOutcome>;
  /**
   * Called once a cancelled flow has settled, either way.
   *
   * The plane learns nothing about the ACCOUNT from a flow ending — the daemon reads
   * nothing the provider's login binary writes — so the only honest response is to ask
   * the registry again, and the read belongs to whoever owns it.
   */
  readonly onFlowSettled: () => void;
}

/**
 * One window's brokered sign-in: which flow is running, and which starts were declined.
 *
 * A class with private fields rather than a pair of `useState` cells, per
 * `apps/desktop/AGENTS.md`: it owns a single-flight claim, two calls in flight, and the
 * rule that decides which of their settlements installs. The React binding lives in
 * `AccountsShell.tsx` and holds nothing.
 */
export class SignInPlane {
  readonly #startSignIn: (accountId: ProviderAccountId) => Promise<SignInStartOutcome>;
  readonly #cancelSignIn: (attempt: ProviderAccountLoginResponse) => Promise<SignInCancelOutcome>;
  readonly #onFlowSettled: () => void;
  readonly #changes = new Emitter<void>("sign-in plane change");
  /**
   * Which flow this plane is on, through the console's one single-flight register.
   *
   * The key is held from the start that took it until the flow leaves the plane —
   * ended or cancelled — so a settlement arriving for a round something has
   * superseded installs nothing and a disposed plane installs nothing at all.
   */
  readonly #flows = new GenerationLatch();
  /**
   * The newest attempt the registry has reported finished.
   *
   * Held because the tail opens BEFORE `providerAccount.login` is called — the ordering
   * the registered contract states — so a flow that finishes fast reports its
   * completion while the start reply is still travelling. Without this the plane would
   * seat an attempt that is already over and hold the key until somebody pressed
   * cancel. ONE id and not a set: the daemon runs one brokered flow at a time, so the
   * newest completion is the only one a seating attempt could be.
   */
  #completedAttemptId: string | undefined = undefined;
  #snapshot: SignInPlaneSnapshot = NOTHING_STARTED;
  #isDisposed = false;

  public constructor(options: SignInPlaneOptions) {
    this.#startSignIn = options.startSignIn;
    this.#cancelSignIn = options.cancelSignIn;
    this.#onFlowSettled = options.onFlowSettled;
  }

  public snapshot(): SignInPlaneSnapshot {
    return this.#snapshot;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Start a brokered sign-in for one account.
   *
   * The surface disables every start control while the plane is held, so a press that
   * reaches here is one that surface could not intercept — a stale frame, a keyboard
   * activation racing a commit. Doing nothing would be indistinguishable from a broken
   * control, so the row that asked gets this plane's own refusal saying what is in the
   * way, and the flow that is running is not touched.
   */
  public start(accountId: ProviderAccountId): void {
    if (this.#isDisposed) {
      return;
    }
    const claim = this.#flows.claim(this, SIGN_IN_FLOW_KEY);
    if (claim === undefined) {
      this.#publish({
        refusalByAccountId: this.#refusalsWith(
          accountId,
          startAlreadyRunning(this.#isHolder(accountId)),
        ),
      });
      return;
    }
    // Dropped on the attempt rather than on its settlement, so a person pressing again
    // does not read last time's reason beside this time's spinner.
    this.#publish({
      flow: { kind: "starting", accountId },
      refusalByAccountId: this.#refusalsWithout(accountId),
    });
    void this.#startSignIn(accountId).then((outcome) => {
      claim.settle(() => {
        if (outcome.attempt.attemptId === this.#completedAttemptId) {
          // The registry reported this very attempt finished while its start reply was
          // still travelling, which the registered ordering makes ordinary: the tail is
          // open before the call goes out. Seating it would put a card on screen for a
          // flow that is over.
          claim.release();
          this.#settleEndedFlow(SIGN_IN_ENDED_BY_REGISTRY);
          return;
        }
        this.#publish({ flow: outcome });
      });
    });
  }

  /**
   * Cancel the live flow.
   *
   * `cancelled` and `notFound` are both the daemon telling this window there is no flow
   * of its making left, so both end the flow and free the key.
   */
  public cancel(): void {
    const { flow } = this.#snapshot;
    if (this.#isDisposed || flow.kind !== "live") {
      return;
    }
    const { accountId, attempt } = flow;
    const round = this.#flows.currentClaim(this, SIGN_IN_FLOW_KEY);
    this.#publish({ flow: { kind: "cancelling", accountId, attempt } });
    void this.#cancelSignIn(attempt).then((outcome) => {
      round.settle(() => {
        this.#flows.supersede(this, SIGN_IN_FLOW_KEY);
        this.#publish({ flow: outcome });
        this.#onFlowSettled();
      });
    });
  }

  /**
   * The registry's tail reports one brokered attempt finished.
   *
   * THE SECOND OF THE TWO THINGS THAT END A FLOW, and the one that is evidence rather
   * than a reply: `providerAccount.subscribe` carries `login_completed` correlated on
   * the attempt id, so a plane still holding an attempt is released by the node.
   *
   * CORRELATED AND NEVER ASSUMED. Another window's brokered flow completes on this same
   * node-scoped tail, and taking that as this card's ending would clear a live
   * attempt's verification code. The id the plane is tracking is the only one that
   * moves it.
   *
   * The completion is REMEMBERED whether or not it matched, because a flow that
   * finishes fast reports its completion while its own start reply is still in flight —
   * {@link start} reads it on the seating arm.
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
    this.#flows.supersede(this, SIGN_IN_FLOW_KEY);
    this.#settleEndedFlow(SIGN_IN_ENDED_BY_REGISTRY);
  }

  /** Terminal. A settlement landing after this installs nothing. */
  public dispose(): void {
    this.#isDisposed = true;
    this.#flows.supersedeAll();
  }

  /**
   * Leave the flow ended and ask whoever owns the registry read to take a fresh one.
   *
   * The pair is written once because the two are one act: a flow ending is never a
   * verdict about the account, so every path that ends one owes the same re-read.
   */
  #settleEndedFlow(because: string): void {
    this.#publish({ flow: { kind: "ended", because } });
    this.#onFlowSettled();
  }

  /** Whether the account asking is the one already holding the plane. */
  #isHolder(accountId: ProviderAccountId): boolean {
    return signInPlaneHolder(this.#snapshot) === accountId;
  }

  #refusalsWith(
    accountId: ProviderAccountId,
    refusal: ConsoleRefusal,
  ): ReadonlyMap<ProviderAccountId, ConsoleRefusal> {
    return new Map(this.#snapshot.refusalByAccountId).set(accountId, refusal);
  }

  #refusalsWithout(accountId: ProviderAccountId): ReadonlyMap<ProviderAccountId, ConsoleRefusal> {
    const remaining = new Map(this.#snapshot.refusalByAccountId);
    remaining.delete(accountId);
    return remaining;
  }

  /**
   * Fold one transition in and hand out a new identity.
   *
   * The snapshot is HELD rather than composed per read, because `useSyncExternalStore`
   * compares identity: a getter returning a fresh object every call renders forever.
   */
  #publish(changes: Partial<Omit<SignInPlaneSnapshot, "revision">>): void {
    this.#snapshot = { ...this.#snapshot, ...changes, revision: this.#snapshot.revision + 1 };
    this.#changes.emit();
  }
}

/**
 * The account whose sign-in is holding the plane, where one is.
 *
 * A function over the SNAPSHOT rather than a getter on the plane, because the surface
 * reads the snapshot through `useSyncExternalStore` and a getter reaching past it
 * would be a second reading of the same fact with no guarantee the two agree in one
 * render. The plane's own guard calls it too, so the derivation has one spelling.
 */
export function signInPlaneHolder(snapshot: SignInPlaneSnapshot): ProviderAccountId | undefined {
  const { flow } = snapshot;
  return isSignInPlaneHeld(flow) ? signInPlaneHolderAccountId(flow) : undefined;
}

/**
 * What is in the way of a start, in the words both surfaces that say it use.
 *
 * TWO SENTENCES UNDER ONE RULE, because what a person does next differs: their own
 * account's sign-in is already the one running, and another account's is in front of
 * theirs. The second NAMES the account where the caller holds a label for it and
 * degrades to "another account" where it does not — which is what a refusal has to say,
 * being raised on the row that asked rather than beside the registry the label is in.
 */
export function signInHeldSentence(options: {
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
 * Why this plane declined a start it never sent.
 *
 * Its own code rather than the daemon's `provideraccount.signin_in_flight` — that code
 * belongs to a call this plane deliberately did not make, and borrowing it would report
 * a daemon refusal that never happened. The detail is the sentence above without a
 * label, because a refusal reaches the row from here and the registry is the surface's.
 */
function startAlreadyRunning(isTheSameAccount: boolean): ConsoleRefusal {
  return refuse(
    SIGN_IN_PLANE_REFUSAL_ORIGIN,
    START_ALREADY_RUNNING_CODE,
    signInHeldSentence({ isTheSameAccount, holdingAccountLabel: undefined }),
  );
}
