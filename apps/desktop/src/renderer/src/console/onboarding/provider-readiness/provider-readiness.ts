// Which providers this node can actually run, and the three acts the step offers.
//
// A VIEW OVER THE ACCOUNT PLANE THAT MINTS NOTHING. The readiness projection arrives
// on `providerAccount.list` as a REQUIRED member with exactly one entry per selected
// provider, so this model composes no state of its own from account fields: it holds
// what the reply said and what this window has done since. `Spec-029` is emphatic
// that readiness is a derivation of the registry served from the STORED last-probe
// result — a registry read spawns no provider process — and that it authorizes
// nothing, so nothing here gates anything.
//
// NOTHING POLLS, AND THERE IS NO STALENESS TEST. The contract carries no read-path
// age member and no stale arm, so `observedAt` is displayed as what it is and never
// compared against a clock. A re-check is a deliberate act a person performs, which
// is why `providerAccount.probe` is reached only from a control.
//
// AND THE READ GOES THROUGH THE ONE SCHEDULER, which is what separates "nothing
// polls" from "nothing can ask again". This model used to read once from the step's
// own arrival and hold whatever that answered for the life of the window: current at
// mount and stale the first time somebody came back to it, with nothing on screen
// saying so. It is a `ReadTriggerTarget` the walkthrough WIRES now — declaring the
// contract and never being handed to it is the same staleness with a green gate — so
// the two reasons a node-scoped reading takes, a surface arriving and a window
// regaining focus, reach it through `requestRead` and are coalesced by
// `RefreshScheduler`, exactly as `onboarding-flow.ts` next door takes them. A
// repaired connection is a SESSION's reason, and this reading holds no session.
//
// THE SCOPE ARRIVES THROUGH ONE VERB AND THE READ LEAVES THROUGH ANOTHER, which is
// why `addressAt` exists and why no read is public at all. An activation names which
// account the readiness read is addressed at, and a scheduler keyed on nothing could
// not tell two scopes apart — so the walkthrough ADDRESSES this model at that scope
// before its trigger set opens, this model remembers it, and every reason afterwards
// — the arrival included — re-reads THAT scope rather than silently widening to the
// provider default. A public read beside a routed one is what let the arrival bypass
// the scheduler in the first place, so there is no longer one to reach for.
//
// AND A CHANGE OF SCOPE RETIRES WHAT THE PREVIOUS ONE PUT ON SCREEN. Everything this
// model holds is ABOUT the account it was addressed at, so a scope that moves while a
// call is out has to move the generation with it: the previous account's reply would
// otherwise pass the generation check and install its projection over the new
// account's, and the previous account's hand-off and re-check outcomes would stay
// rendered — and stay pressable — beside a scope that never produced them.
//
// THE THREE ACTS THIS MODEL PERFORMS, and why there is no fourth. Sign-in hands the
// participant to the provider's own first-party flow through the growth port — the
// daemon spawns the unmodified login binary and this console reads nothing it writes.
// A re-check probes ONE account and then re-reads, because the probe answers about an
// account and the readiness derivation answers about a provider. And the read itself,
// optionally scoped to one account for the post-refusal path. Registration and
// choosing a default are MUTATING REGISTRY VERBS that belong to the account registry's
// own page; this step renders the remedy for them as text, which is what the design
// requires of a remedy in any case.
//
// SUPERSESSION IS THE FLOW'S RULE. A generation stamps every call and a settlement
// arriving after this model was retired publishes nowhere.

import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderReadiness,
} from "@ai-sidekicks/contracts";

import { Emitter, type ConsoleRefusal, type Unsubscribe } from "../../core/index.js";
import {
  callDaemon,
  consoleClockFor,
  settleGrowthRead,
  type ConsoleBridge,
} from "../../bridge/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  RefreshScheduler,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../../store/index.js";

/** What the step knows about this node's providers. Closed; every arm renders. */
export type ProviderReadinessReading =
  | { readonly kind: "reading" }
  | {
      readonly kind: "read";
      readonly entries: readonly ProviderReadiness[];
      readonly accounts: readonly ProviderAccount[];
    }
  | { readonly kind: "unreadable"; readonly refusal: ConsoleRefusal };

/** What this window has done about ONE provider since the step opened. */
export type ProviderActionReading =
  | { readonly kind: "idle" }
  | { readonly kind: "handing-off" }
  | { readonly kind: "handed-off" }
  | { readonly kind: "rechecking" }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** The idle reading, shared rather than rebuilt, so an untouched row is one object. */
const IDLE: ProviderActionReading = { kind: "idle" };

/**
 * The zero state, shared for `IDLE`'s reason and for one more.
 *
 * Two positions hold it — where the model starts and where a re-addressing resets it
 * — and a rebuilt object at the second would notify every subscriber of a value equal
 * to the one it already had. One object makes the reset legible as the same state the
 * model opens in rather than as a second spelling of it.
 */
const ZERO_STATE_READING: ProviderReadinessReading = { kind: "reading" };

export class ProviderReadinessModel implements ReadTriggerTarget {
  /**
   * Nothing in any session's timeline says this node's provider accounts changed.
   *
   * The empty set is a claim read off the contract rather than an omission: the
   * provider-account registry is un-evented by design — its own subscribe verb
   * "carries a WIRE-ONLY notification and NEVER an `EventEnvelope`", because a
   * node-local operator act on a node-local registry has no session to belong to. So
   * there is no session event kind that could legitimately re-trigger this read, and
   * the sign-in completion is one of those wire notifications rather than an event.
   * This reading goes stale when the window has been away, and never because one
   * session appended something — which is exactly what the account plane's other
   * reading, `NodeProviderQuotaReading`, states at the same field.
   */
  public readonly triggeringEventKinds: ReadonlySet<string> = NO_TRIGGERING_EVENT_KINDS;
  readonly #bridge: ConsoleBridge;
  readonly #refresh: RefreshScheduler;
  readonly #changes = new Emitter<void>("provider readiness");
  readonly #actionsByProvider = new Map<string, ProviderActionReading>();
  #reading: ProviderReadinessReading = ZERO_STATE_READING;
  /**
   * The scope this model is addressed at. Read by every reason, written by one verb.
   *
   * Held rather than re-derived, because the activation that named it is gone by the
   * time a reconnect asks for a fresh read — and a refresh that quietly widened to
   * the provider default would answer about a different account from the one the
   * person is looking at.
   */
  #accountScope: ProviderAccountId | undefined = undefined;
  #generation = 0;

  public constructor(bridge: ConsoleBridge) {
    this.#bridge = bridge;
    this.#refresh = new RefreshScheduler({
      // The fixture's frozen clock wherever a scenario is playing and the real one
      // otherwise, resolved once per model.
      clock: consoleClockFor(bridge),
      perform: async () => {
        await this.#read();
      },
      // A refused read is already this model's own `unreadable` arm, so re-throwing
      // would surface the same fact a second time as an unhandled rejection.
      onError: () => undefined,
    });
  }

  public get reading(): ProviderReadinessReading {
    return this.#reading;
  }

  /**
   * Address this model at one account, or at the provider default.
   *
   * READS NOTHING, which is half of its job: the scope is a property of the
   * ACTIVATION and the read is the trigger set's, so folding them into one call
   * would put a second read beside the routed one and make which of the two answered
   * a question of ordering. Called before the trigger set opens, and again whenever a
   * later activation addresses this model somewhere else.
   *
   * A CHANGE OF SCOPE IS A NEW GENERATION, which is the other half. The reading and
   * the per-provider actions are both ABOUT the account that was addressed, so a
   * scope moved while a call is out retires that call exactly as a retirement does —
   * without it the previous account's reply passes the generation check and overwrites
   * the new account's reading — and the two account-scoped fields return to the zero
   * state, so the previous account's hand-off and re-check outcomes are neither
   * rendered nor pressable against a scope that never produced them. Re-addressing at
   * the SAME scope is not a change: it retires nothing and publishes nothing, so an
   * activation restating where this model already points costs no read and no render.
   */
  public addressAt(accountScope: ProviderAccountId | undefined): void {
    if (accountScope === this.#accountScope) {
      return;
    }
    this.#accountScope = accountScope;
    this.#retireInFlight();
    this.#reading = ZERO_STATE_READING;
    this.#actionsByProvider.clear();
    this.#changes.emit();
  }

  /**
   * Ask for a fresh readiness read, at whatever scope this model was addressed at.
   *
   * The ARRIVAL reads immediately, on `onboarding-flow.ts`' rule and for its reason:
   * this reading has no tail keeping it current and the fixture's clock is frozen, so
   * a first read parked behind the debounce window would never happen at all. The
   * other reason a node-scoped reading takes — a window regaining focus, which
   * arrives in bursts — is the scheduler's to coalesce.
   */
  public requestRead(reason: RefreshReason): void {
    if (reason === "subscribe") {
      void this.#read();
      return;
    }
    this.#refresh.request(reason);
  }

  /** What this window has done about one provider. Never `undefined` — idle is real. */
  public actionFor(providerName: string): ProviderActionReading {
    return this.#actionsByProvider.get(providerName) ?? IDLE;
  }

  public subscribe(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** Drop this model's claim on anything unsettled. Nothing published after this. */
  public supersede(): void {
    this.#retireInFlight();
    this.#refresh.dispose();
  }

  /**
   * Advance the generation, so nothing already in flight publishes.
   *
   * ONE HOME FOR THE RETIREMENT, because two callers perform it and they differ only
   * in what they do next: a retired step also disposes its scheduler, and a
   * re-addressed one keeps the scheduler and resets what the previous scope left on
   * screen. The place copies of a guard drift is the guard itself, and this one is
   * three words long, which is exactly how a second copy comes to be written.
   */
  #retireInFlight(): void {
    this.#generation += 1;
  }

  /**
   * Read the readiness projection at the scope this model holds.
   *
   * The scope exists for the post-refusal path alone: a run bound to a per-run
   * account override was refused about THAT account, and an unscoped read would hand
   * back the provider default's remedy — a different account, possibly healthy.
   */
  async #read(): Promise<void> {
    const generation = this.#generation;
    const accountScope = this.#accountScope;
    const reply = await callDaemon(
      this.#bridge,
      "providerAccount.list",
      accountScope === undefined ? {} : { accountId: accountScope },
    );
    if (generation !== this.#generation) {
      return;
    }
    this.#reading =
      reply.status === "served"
        ? { kind: "read", entries: reply.value.readiness, accounts: reply.value.accounts }
        : { kind: "unreadable", refusal: reply.refusal };
    this.#changes.emit();
  }

  /**
   * Hand the participant to one provider's own sign-in, and read again afterwards.
   *
   * THE ACCOUNT TRAVELS WITH THE PROVIDER. The remedy this control was rendered from
   * names the account whose credential home the invocation authenticates into, and a
   * provider with two registered accounts has two such homes — so a hand-off carrying
   * only the provider name leaves the surface behind it to elect one, and the
   * election it can afford is the provider default: a different account from the one
   * whose remedy the person pressed. Resolved BEFORE the first await, so what travels
   * is the reading the control was rendered against.
   *
   * The re-read is the point: the sign-in process's exit is NOT the definition of
   * success — the probe behind the readiness derivation is — so what this reports is
   * whatever the projection says next, never that the hand-off "worked".
   */
  public async handOffSignIn(providerName: string): Promise<void> {
    const generation = this.#generation;
    const providerAccountId = this.#signInAccountFor(providerName);
    this.#publishAction(providerName, { kind: "handing-off" });
    const settlement = await settleGrowthRead(
      this.#bridge.growth.onboardingProviderSignInHandoff(
        providerAccountId === undefined ? { providerName } : { providerName, providerAccountId },
      ),
    );
    if (generation !== this.#generation) {
      return;
    }
    if (settlement.status !== "served") {
      this.#publishAction(providerName, { kind: "refused", refusal: settlement });
      return;
    }
    this.#publishAction(providerName, { kind: "handed-off" });
    await this.#read();
  }

  /**
   * Probe one account, then read the projection again.
   *
   * Two calls and not one, because they answer different questions: the probe
   * observes ONE account's credential state and the derivation answers per provider
   * from whichever account resolved. Reading the probe's own reply as the row's new
   * state would be this console re-deriving readiness, which is the defect the
   * required `readiness` member exists to remove.
   */
  public async recheck(providerName: string, accountId: ProviderAccountId): Promise<void> {
    const generation = this.#generation;
    this.#publishAction(providerName, { kind: "rechecking" });
    const reply = await callDaemon(this.#bridge, "providerAccount.probe", { accountId });
    if (generation !== this.#generation) {
      return;
    }
    if (reply.status !== "served") {
      this.#publishAction(providerName, { kind: "refused", refusal: reply.refusal });
      return;
    }
    this.#publishAction(providerName, IDLE);
    await this.#read();
  }

  /**
   * The account one provider's sign-in remedy named, where the daemon composed one.
   *
   * OFF THE REMEDY RATHER THAN OFF `resolvedAccountId`, though the contract holds the
   * two equal on this arm: the remedy is what the control was rendered from, and its
   * `accountId` is the account the invocation and the credential home beside it
   * belong to. `undefined` where the reading has not answered, or where the
   * provider's remedy is a registry verb rather than a sign-in — there is no account
   * to name, and naming one anyway would be this console electing one.
   */
  #signInAccountFor(providerName: string): ProviderAccountId | undefined {
    const reading = this.#reading;
    if (reading.kind !== "read") {
      return undefined;
    }
    const remedy = reading.entries.find((entry) => entry.provider === providerName)?.remedy;
    return remedy?.kind === "sign_in" ? remedy.accountId : undefined;
  }

  #publishAction(providerName: string, reading: ProviderActionReading): void {
    this.#actionsByProvider.set(providerName, reading);
    this.#changes.emit();
  }
}

/** Which registered accounts belong to one provider, for the row's disclosure. */
export function accountsForProvider(
  accounts: readonly ProviderAccount[],
  providerName: string,
): readonly ProviderAccount[] {
  return accounts.filter((account) => account.provider === providerName);
}

/** The providers that are NOT ready, named for the completion summary. */
export function providersNotReady(entries: readonly ProviderReadiness[]): readonly string[] {
  return entries.filter((entry) => entry.state !== "authenticated").map((entry) => entry.provider);
}
