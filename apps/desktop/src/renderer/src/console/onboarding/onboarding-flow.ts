// The walkthrough's state, and every growth call it makes.
//
// ONE CLASS RATHER THAN A HOOK PER CALL, because the five operations it makes are one
// conversation: the state read says where a person is, the two dialogs answer the two
// group-A questions, and the two step verbs record what happened. Split across
// components each would need its own in-flight flag and its own supersession rule,
// and the rules would diverge the first time one of them was written twice.
//
// AND NOT ONE OF THEM RECORDS THE PROVIDER STEP. `Spec-026 §Provider Authentication
// (Group B)` has that group persist "no config key, no partial-state entry, no
// keystore entry, and no event" — the account registry is where every fact it
// establishes already lives. This class therefore has no skip verb at all: it used to,
// and the provider step's own control was wired to it, so leaving that step wrote a
// completed-step entry into the daemon's set for a group the corpus says holds no
// state. Leaving is a LOCAL act now — the walkthrough's **Not now** — and the absence
// of the verb is what keeps it one rather than a comment asking the next author not to
// call it. `onboardingStepSkip` is still served by the fixture and still on the wire;
// nothing in this console reaches it.
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
// recorded, a choice made, a node finished — and every other reason to re-read arrives
// through `requestRead`, which is `RefreshScheduler`'s to coalesce. There is no timer
// anywhere in this family, and no second scheduler: `store/read/refresh-scheduler.ts` owns the one
// this flow constructs. The walkthrough hands this flow to the WINDOW trigger set,
// which is the pair a node-scoped reading takes: the arrival, and the window
// regaining focus. A repaired connection and a timeline event are a SESSION's
// reasons, and this flow holds no session.
//
// THE OPEN AND THE POST-ACT RE-READ ARE PERFORMED DIRECTLY, and that is the queue
// reading's own precedent rather than an exception carved here. This reading has no
// tail keeping it current, and the fixture's clock is frozen — `ManualClock` runs a
// timeout only when a caller advances it — so a first read parked behind the
// scheduler's debounce window would never happen at all in fixture mode, and the
// walkthrough would open on `reading` forever. What the scheduler is for is the reason
// that arrives in bursts: a window regaining focus. Direct does not mean unordered:
// every read, whichever door it came through, takes the same latch key below.
//
// AND ITS TRIGGERING EVENT SET IS EMPTY, which is a claim rather than an omission.
// Onboarding is NODE-scoped: nothing appended to a session's timeline says this
// node's onboarding state moved, because the acts that move it are this flow's own
// and it re-reads on each of them.
//
// SUPERSESSION IS THE STORE'S REGISTER AND NOT AN EPOCH OF THIS FILE'S OWN. Four
// conversations run over one snapshot — the state read, the two step verbs, and the
// two main-process dialogs — and each takes its own key on one `GenerationLatch`, so a
// settlement is admitted only while the key it holds still names its round. The
// dialogs are main's and outlive this window's interest in them.
//
// A flow-local counter could express only the coarsest of those rules, and did: it
// moved on teardown alone, so the opening read and a post-act read carried the SAME
// stamp and neither superseded the other — an opening reply landing after the post-act
// one overwrote the newer completed-step set and the rail regressed to the state
// before the step. Two rules replace it, and both are the latch's:
//
//   • Every read supersedes the read before it, because they answer one question and
//     the older answer has nothing left to say about it.
//   • Every ACT supersedes every read started before that act SETTLED — the moment is
//     the settlement and not the dispatch, because a reply already in flight when the
//     daemon accepted the step describes this node as it was before it.
//
// The acts keep a key of their own rather than sharing the read's, so a refusal a
// person is owed is not silently dropped by a read that happened to answer first.
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
  GenerationLatch,
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
  /**
   * What the daemon says is done, as of this snapshot. Empty until one answers.
   *
   * A PROJECTION AND NOT A SECOND RECORD: on the answered arm this IS
   * `reading.completed`, the same object rather than a copy, and on the other two it
   * is the empty set THIS publish minted. Every surface stands on the same value, so
   * "the read has not answered" and "the daemon says nothing is done" render alike
   * without either of them writing that rule down.
   *
   * MINTED PER PUBLISH, which is the point. Two components each held a module-level
   * `new Set()` for the unanswered case, and `ReadonlySet` is a compile-time view of
   * a collection that is mutable at runtime — so one accidental `add` contaminated
   * the baseline of every later activation in the renderer, for the life of the
   * process. A value minted where the reading is published cannot outlive it, and no
   * two activations are ever handed the same one.
   */
  readonly completedSteps: ReadonlySet<OnboardingStepId>;
  readonly relayChoice: RelayChoiceReading;
  readonly telemetry: TelemetryReading;
}

/**
 * The four keys this walkthrough's conversations run under, on one register.
 *
 * FOUR AND NOT ONE, because "one in flight" is one per SUBJECT and these are four
 * subjects sharing a snapshot. A single key would have made a state read and a relay
 * dialog supersede each other, which is false — they answer different questions and
 * land in different members — while one key per CALL would have let two step verbs run
 * as though they were unrelated, which is equally false: they write one record and the
 * newest press is the one a person is waiting on.
 *
 * The subject every key is claimed under is the flow itself. It has no object of its
 * own to key by — a node's onboarding is not addressed by anything — and the latch
 * holds a subject weakly, so a retired walkthrough takes its keys with it.
 */
const STATE_READ_KEY = "state-read";
const STEP_ACT_KEY = "step-act";
const RELAY_CHOICE_KEY = "relay-choice";
const TELEMETRY_PROMPT_KEY = "telemetry-prompt";

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
  /**
   * Which round each of the four conversations is on.
   *
   * The console's one generation register rather than a counter of this file's own, so
   * "this answer was superseded" and "this answer outlived the walkthrough" are one
   * question with one mechanism — and so the two supersession rules the header states
   * are expressed by which entry point takes the key rather than by arithmetic here.
   */
  readonly #rounds = new GenerationLatch();
  #snapshot: OnboardingSnapshot = {
    reading: { kind: "reading" },
    completedSteps: completedStepsFrom([]),
    relayChoice: { kind: "unasked" },
    telemetry: { kind: "unasked" },
  };

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
    this.#rounds.supersedeAll();
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
    // Claimed before the call and never after it: a read taken after the await would
    // stamp itself with whatever round the register had reached by then, which is the
    // shape that let two reads believe they were the same one.
    const round = this.#rounds.supersedeAndClaim(this, STATE_READ_KEY);
    const settlement = await settleGrowthRead(this.#bridge.growth.onboardingStateRead({}));
    if (!round.isCurrent) {
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
    const round = this.#rounds.supersedeAndClaim(this, RELAY_CHOICE_KEY);
    this.#publishRelayChoice({ kind: "asking" });
    const settlement = await settleGrowthRead(this.#bridge.growth.onboardingPresentChoice({}));
    if (!round.isCurrent) {
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
    const round = this.#rounds.supersedeAndClaim(this, TELEMETRY_PROMPT_KEY);
    this.#publishTelemetry({ kind: "asking" });
    const settlement = await settleGrowthRead(this.#bridge.growth.onboardingTelemetryPrompt({}));
    if (!round.isCurrent) {
      return;
    }
    if (settlement.status !== "served") {
      this.#publishTelemetry({ kind: "refused", refusal: settlement });
      return;
    }
    this.#publishTelemetry({ kind: "answered", enabled: settlement.value.enabled });
    await this.advance("telemetry");
  }

  /**
   * Record a step as done, then re-read — the daemon owns what "done" means.
   *
   * REACHED BY GROUP A'S TWO ANSWERS AND BY NOTHING ELSE. Both call sites are above:
   * a relay choice that came back with an identifier this build recognises, and a
   * telemetry question that was actually put. There is no third, and no verb of this
   * class records the provider step — see the header.
   */
  public async advance(stepId: OnboardingStepId): Promise<void> {
    await this.#recordThenRead(this.#bridge.growth.onboardingStepAdvance({ stepId }));
  }

  /** Finish. Legitimate with providers untouched — group B is never demanded. */
  public async complete(): Promise<void> {
    await this.#recordThenRead(this.#bridge.growth.onboardingComplete({}));
  }

  async #recordThenRead(record: Promise<GrowthOutcome<void>>): Promise<void> {
    const round = this.#rounds.supersedeAndClaim(this, STEP_ACT_KEY);
    const settlement = await settleGrowthRead(record);
    if (!round.isCurrent) {
      return;
    }
    // AN ACT SUPERSEDES EVERY READ STARTED BEFORE IT SETTLED, and this line is the
    // whole of that rule. Such a read was dispatched against this node as it was
    // BEFORE the daemon answered, so its reply — however late it lands — describes a
    // state this act has already moved past, and publishing it would take the rail
    // back to it. Done on both arms below rather than only on the served one: a
    // refusal a person is owed must not be overwritten by a read either.
    this.#rounds.supersede(this, STATE_READ_KEY);
    if (settlement.status !== "served") {
      this.#publishReading({ kind: "unreadable", refusal: settlement });
      return;
    }
    await this.read();
  }

  #publishReading(reading: OnboardingReading): void {
    this.#publish({
      ...this.#snapshot,
      reading,
      // The read arm's own set, and a freshly narrowed empty one otherwise — which is
      // what the daemon would have answered for a node nobody has set up. Minted here
      // rather than shared, so nothing a surface does to one publish's value can
      // reach the next.
      completedSteps: reading.kind === "read" ? reading.completed : completedStepsFrom([]),
    });
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
