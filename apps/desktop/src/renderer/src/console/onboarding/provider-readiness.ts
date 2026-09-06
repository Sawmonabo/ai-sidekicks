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

import { Emitter, type ConsoleRefusal, type Unsubscribe } from "../core/index.js";
import { callDaemon, settleGrowthRead, type ConsoleBridge } from "../bridge/index.js";

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

export class ProviderReadinessModel {
  readonly #bridge: ConsoleBridge;
  readonly #changes = new Emitter<void>("provider readiness");
  readonly #actionsByProvider = new Map<string, ProviderActionReading>();
  #reading: ProviderReadinessReading = { kind: "reading" };
  #generation = 0;

  public constructor(bridge: ConsoleBridge) {
    this.#bridge = bridge;
  }

  public get reading(): ProviderReadinessReading {
    return this.#reading;
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
  }

  /**
   * Read the readiness projection, optionally scoped to one account.
   *
   * The scope exists for the post-refusal path alone: a run bound to a per-run
   * account override was refused about THAT account, and an unscoped read would hand
   * back the provider default's remedy — a different account, possibly healthy.
   */
  public async read(accountScope: ProviderAccountId | undefined): Promise<void> {
    const generation = this.#generation;
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
  public async handOffSignIn(
    providerName: string,
    accountScope: ProviderAccountId | undefined,
  ): Promise<void> {
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
    await this.read(accountScope);
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
  public async recheck(
    providerName: string,
    accountId: ProviderAccountId,
    accountScope: ProviderAccountId | undefined,
  ): Promise<void> {
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
    await this.read(accountScope);
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
