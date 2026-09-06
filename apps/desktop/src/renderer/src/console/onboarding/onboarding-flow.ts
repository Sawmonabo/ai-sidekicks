// The walkthrough's state, and every growth call it makes.
//
// ONE CLASS RATHER THAN A HOOK PER CALL, because the seven onboarding operations are
// one conversation: the state read says where a person is, the two dialogs answer the
// two group-A questions, and the three step verbs record what happened. Split across
// components each would need its own in-flight flag and its own supersession rule,
// and the rules would diverge the first time one of them was written twice.
//
// EVERY CALL GOES THROUGH THE GROWTH PORT, which is what makes this surface honest on
// a live build: the console growth slate carries the five daemon methods on its
// `onboarding.*` row and the two bridge methods on the row this lane minted, so the
// live bridge refuses all seven and the walkthrough renders the _not checked_ absence
// rather than an empty progress list. "Nobody has onboarded this node" and "this build
// cannot ask" are different facts.
//
// NOTHING POLLS, AND THE READ GOES THROUGH THE ONE SCHEDULER. The state is read when
// the walkthrough opens and again after each act that could have changed it — a step
// recorded, a step skipped, a choice made — and every other reason to re-read arrives
// through `requestRead`, which is `RefreshScheduler`'s to coalesce. There is no timer
// anywhere in this family. The walkthrough hands this flow to the WINDOW trigger set,
// which is the pair a node-scoped reading takes: the arrival, and the window
// regaining focus. A repaired connection and a timeline event are a SESSION's
// reasons, and this flow holds no session.
//
// THE OPEN AND THE POST-ACT RE-READ ARE PERFORMED DIRECTLY, and that is the queue
// reading's own precedent rather than an exception carved here. This reading has no
// tail keeping it current, and the fixture's clock is frozen — only a scenario beat
// moves it — so a first read parked behind the scheduler's debounce window would
// never happen at all in fixture mode. What the scheduler is for is the reason that
// arrives in bursts: a window regaining focus.
//
// AND ITS TRIGGERING EVENT SET IS EMPTY, which is a claim rather than an omission.
// Onboarding is NODE-scoped: nothing appended to a session's timeline says this
// node's onboarding state moved, because the acts that move it are this flow's own
// and it re-reads on each of them.
//
// SUPERSESSION IS THE SIGN-IN FLOW'S RULE, applied to a longer conversation: a
// generation stamps every call, and a settlement that arrives after the walkthrough
// was retired or re-addressed publishes nowhere. The dialogs are main's and outlive
// this window's interest in them.
//
// EVERY CALL SETTLES THROUGH `settleGrowthRead`, and none of them through a bare
// `await`. A growth call can also REJECT — the fixture throws a scripted daemon
// refusal verbatim, and the live seam will throw the same shape the day the wire
// lands — and a fulfilment handler alone would leave this walkthrough reading
// `reading` for the life of the window over an answer that had already arrived.

import { Emitter, type ConsoleRefusal, type Unsubscribe } from "../core/index.js";
import {
  consoleClockFor,
  settleGrowthRead,
  type ConsoleBridge,
  type GrowthOutcome,
} from "../bridge/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../store/index.js";
import { readRelayMethodId, type RelayMethodId } from "./relay/relay-choice.js";
import { completedStepsFrom, type OnboardingStepId } from "./steps/step-model.js";

/** What the walkthrough knows about where this node is. Closed; every arm renders. */
export type OnboardingReading =
  | { readonly kind: "reading" }
  | {
      readonly kind: "read";
      readonly completed: ReadonlySet<OnboardingStepId>;
      readonly isComplete: boolean;
    }
  | { readonly kind: "unreadable"; readonly refusal: ConsoleRefusal };

/** What the relay step knows about the choice, if one has been made in this window. */
export type RelayChoiceReading =
  | { readonly kind: "unasked" }
  | { readonly kind: "asking" }
  | {
      readonly kind: "chosen";
      readonly methodId: RelayMethodId;
      /**
       * The address this node relays through, as the daemon's config holds it.
       *
       * Rendered as a value and not as presence, which is the opposite of the handle
       * below and for the opposite reason: `Spec-026 §Persistence` keeps `relay_url`
       * in plaintext config, and Option 1's own required prompt is that the current
       * published address be displayed rather than described.
       */
      readonly relayUrl: string;
      /** Opaque; names a secret main holds. Rendered as presence, never as a value. */
      readonly hasCredentialHandle: boolean;
    }
  | { readonly kind: "unrecognised"; readonly reportedId: string }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** What the telemetry step knows. Unasked until the question has been put. */
export type TelemetryReading =
  | { readonly kind: "unasked" }
  | { readonly kind: "asking" }
  | { readonly kind: "answered"; readonly enabled: boolean }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/**
 * Everything one render of the walkthrough reads, as one value.
 *
 * ONE SNAPSHOT RATHER THAN THREE GETTERS, because `useSyncExternalStore` requires a
 * stable reference between publishes and a component reading three of them would
 * subscribe to one emitter three times to get them. It is rebuilt exactly when
 * something changes, which is what makes the identity comparison meaningful.
 */
export interface OnboardingSnapshot {
  readonly reading: OnboardingReading;
  readonly relayChoice: RelayChoiceReading;
  readonly telemetry: TelemetryReading;
}

export class OnboardingFlow implements ReadTriggerTarget {
  /**
   * Nothing in a session's timeline says this node's onboarding state changed.
   *
   * The empty set is the claim the contract admits: onboarding is node-scoped, and
   * the acts that move it are this flow's own, each of which re-reads.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #bridge: ConsoleBridge;
  readonly #refresh: RefreshScheduler;
  readonly #changes = new Emitter<void>("onboarding state");
  #snapshot: OnboardingSnapshot = {
    reading: { kind: "reading" },
    relayChoice: { kind: "unasked" },
    telemetry: { kind: "unasked" },
  };
  #generation = 0;

  public constructor(bridge: ConsoleBridge) {
    this.#bridge = bridge;
    this.#refresh = new RefreshScheduler({
      // The fixture's frozen clock wherever a scenario is playing and the real one
      // otherwise, resolved once per flow.
      clock: consoleClockFor(bridge),
      perform: async () => {
        await this.read();
      },
      // A refused read is already this flow's own `unreadable` arm, so re-throwing
      // would surface the same fact a second time as an unhandled rejection.
      onError: () => undefined,
    });
  }

  public get snapshot(): OnboardingSnapshot {
    return this.#snapshot;
  }

  public subscribe(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** Drop this flow's claim on anything unsettled. Nothing published after this. */
  public supersede(): void {
    this.#generation += 1;
    this.#refresh.dispose();
  }

  /**
   * Ask for a fresh read of where this node is.
   *
   * The walkthrough's ARRIVAL reads immediately — there is no tail keeping this
   * current, and the fixture's clock is frozen, so a first read behind the debounce
   * window would never fire at all. The other reason is coalesced.
   */
  public requestRead(reason: RefreshReason): void {
    if (reason === "subscribe") {
      void this.read();
      return;
    }
    this.#refresh.request(reason);
  }

  /** Read where this node is. The one read, on open and after each recorded act. */
  public async read(): Promise<void> {
    const generation = this.#generation;
    const settlement = await settleGrowthRead(this.#bridge.growth.onboardingStateRead({}));
    if (generation !== this.#generation) {
      return;
    }
    if (settlement.status !== "served") {
      this.#publishReading({ kind: "unreadable", refusal: settlement });
      return;
    }
    this.#publishReading({
      kind: "read",
      completed: completedStepsFrom(settlement.value.completedStepIds),
      isComplete: settlement.value.isComplete,
    });
  }

  /**
   * Put the relay choice in front of the participant, in main's own window.
   *
   * The renderer collects nothing: the option a person picks and the admin token
   * they type both belong to a surface this window cannot read, and what comes back
   * is an identifier and an opaque handle. A recognised identifier records the step;
   * an unrecognised one records nothing and says so, because a console that mapped an
   * identifier it does not know onto its default would report a choice nobody made.
   */
  public async presentRelayChoice(): Promise<void> {
    const generation = this.#generation;
    this.#publishRelayChoice({ kind: "asking" });
    const settlement = await settleGrowthRead(this.#bridge.growth.onboardingPresentChoice({}));
    if (generation !== this.#generation) {
      return;
    }
    if (settlement.status !== "served") {
      this.#publishRelayChoice({ kind: "refused", refusal: settlement });
      return;
    }
    const methodId = readRelayMethodId(settlement.value.relayMethodId);
    if (methodId === undefined) {
      this.#publishRelayChoice({
        kind: "unrecognised",
        reportedId: settlement.value.relayMethodId,
      });
      return;
    }
    this.#publishRelayChoice({
      kind: "chosen",
      methodId,
      relayUrl: settlement.value.relayUrl,
      hasCredentialHandle: settlement.value.credentialHandle !== undefined,
    });
    await this.advance("relay");
  }

  /** Ask the telemetry question, on its own, after the relay choice has resolved. */
  public async presentTelemetryPrompt(): Promise<void> {
    const generation = this.#generation;
    this.#publishTelemetry({ kind: "asking" });
    const settlement = await settleGrowthRead(this.#bridge.growth.onboardingTelemetryPrompt({}));
    if (generation !== this.#generation) {
      return;
    }
    if (settlement.status !== "served") {
      this.#publishTelemetry({ kind: "refused", refusal: settlement });
      return;
    }
    this.#publishTelemetry({ kind: "answered", enabled: settlement.value.enabled });
    await this.advance("telemetry");
  }

  /** Record a step as done, then re-read — the daemon owns what "done" means. */
  public async advance(stepId: OnboardingStepId): Promise<void> {
    await this.#recordThenRead(this.#bridge.growth.onboardingStepAdvance({ stepId }));
  }

  /** Record a step as skipped. A skip is an answer, and it is recorded as one. */
  public async skip(stepId: OnboardingStepId): Promise<void> {
    await this.#recordThenRead(this.#bridge.growth.onboardingStepSkip({ stepId }));
  }

  /** Finish. Legitimate with providers untouched — group B is never demanded. */
  public async complete(): Promise<void> {
    await this.#recordThenRead(this.#bridge.growth.onboardingComplete({}));
  }

  async #recordThenRead(record: Promise<GrowthOutcome<void>>): Promise<void> {
    const generation = this.#generation;
    const settlement = await settleGrowthRead(record);
    if (generation !== this.#generation) {
      return;
    }
    if (settlement.status !== "served") {
      this.#publishReading({ kind: "unreadable", refusal: settlement });
      return;
    }
    await this.read();
  }

  #publishReading(reading: OnboardingReading): void {
    this.#publish({ ...this.#snapshot, reading });
  }

  #publishRelayChoice(relayChoice: RelayChoiceReading): void {
    this.#publish({ ...this.#snapshot, relayChoice });
  }

  #publishTelemetry(telemetry: TelemetryReading): void {
    this.#publish({ ...this.#snapshot, telemetry });
  }

  #publish(snapshot: OnboardingSnapshot): void {
    this.#snapshot = snapshot;
    this.#changes.emit();
  }
}
