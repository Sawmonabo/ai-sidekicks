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
  #reading: ProviderReadinessReading = { kind: "reading" };
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
   * SETS AND READS NOTHING, which is the whole of its job: the scope is a property of
   * the ACTIVATION and the read is the trigger set's, so folding them into one call
   * would put a second read beside the routed one and make which of the two answered
   * a question of ordering. Called before the trigger set opens, and again whenever a
   * later activation addresses this model somewhere else.
   */
  public addressAt(accountScope: ProviderAccountId | undefined): void {
    this.#accountScope = accountScope;
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
    this.#generation += 1;
    this.#refresh.dispose();
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
   * The re-read is the point: the sign-in process's exit is NOT the definition of
   * success — the probe behind the readiness derivation is — so what this reports is
   * whatever the projection says next, never that the hand-off "worked".
   */
  public async handOffSignIn(providerName: string): Promise<void> {
    const generation = this.#generation;
    this.#publishAction(providerName, { kind: "handing-off" });
    const settlement = await settleGrowthRead(
      this.#bridge.growth.onboardingProviderSignInHandoff({ providerName }),
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
