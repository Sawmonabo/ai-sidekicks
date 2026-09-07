// The two acts this window performs AGAINST a provider, and the register that retires
// them.
//
// SPLIT FROM THE MODEL BECAUSE THEY ARE A DIFFERENT JOB. `provider-readiness.ts` holds
// a READING — what the daemon's registry says this node can run — and keeps it current
// through one scheduler and one read line. What lives here is the other half: two
// MUTATIONS a person dispatches from a row, each of which ends by asking that reading
// to be taken again. The two halves share nothing but the snapshot they publish into,
// which is why the model composes this rather than inheriting it, and why the seam is
// a pair of collaborators rather than a reach back into private state.
//
// AND THE GENERATION CAME WITH THEM, because it is theirs. It stamps an act at the
// moment it is dispatched and refuses its settlement where the model has since been
// retired or re-addressed — a hand-off's `handed-off` and a re-check's refusal are
// both ABOUT the account that was on screen, so neither may land beside a scope that
// never produced it. The READ has no use for it any more: the model's read line is
// addressed at the scope, so a re-address abandons the line the old read is on and a
// newer read supersedes an older one, which is the same claim expressed where it can
// also STOP the call rather than only ignore its reply.
//
// NEITHER ACT REPORTS ITS OWN SUCCESS. A sign-in process's exit is not the definition
// of success and a probe's own reply is not the row's new state — the readiness
// derivation is, per `Spec-029`, which is why both legs end at `readProjection` and
// why nothing here composes a reading of its own.

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import { callDaemon, settleGrowthRead, type ConsoleBridge } from "../../bridge/index.js";
import type { MutatingDaemonMethod } from "../../store/index.js";
import {
  IDLE_PROVIDER_ACTION,
  signInAccountFor,
  type ProviderActionReading,
  type ProviderReadinessReading,
} from "./provider-readiness-reading.js";

/**
 * The mutating verb a re-check dispatches, named once and bound to the closed set.
 *
 * The `satisfies` IS the binding, and it is what keeps the classification out of this
 * file: `MUTATING_DAEMON_METHODS` is the store family's registration of what a
 * supervisor's condition closes, so a probe that ever left that tuple stops compiling
 * here rather than quietly going back to being dispatchable through a stopped shell.
 * The literal type survives it, which is what `callDaemon` needs to type the request
 * and the reply — a wider annotation would take both.
 *
 * Exported because the model asks the shell seam about this same method before it
 * dispatches, and a second literal there would be the verb written twice — and
 * annotated with its own literal because `isolatedDeclarations` will not infer an
 * exported const's type. The annotation does not displace the `satisfies`: the check
 * against the closed tuple still runs, and the literal type still reaches `callDaemon`.
 */
export const RECHECK_METHOD: "providerAccount.probe" =
  "providerAccount.probe" satisfies MutatingDaemonMethod;

/**
 * What an act needs from the model that owns the snapshot it lands in.
 *
 * TWO NAMED MEMBERS AND NOT THE MODEL ITSELF, so this class can reach exactly the two
 * things an act does and nothing else: it records what the window did, and it asks for
 * the projection to be read again. Handed as an object rather than as two positional
 * callbacks, so a call site cannot silently pass them in the wrong order.
 */
export interface ProviderActHost {
  /** Record what this window has done about one provider. */
  readonly publishAction: (providerName: string, action: ProviderActionReading) => void;
  /** Take the readiness projection again — the only thing that reports an outcome. */
  readonly readProjection: () => Promise<void>;
}

/** The acts a provider row dispatches, and the register that decides what may land. */
export class ProviderActs {
  readonly #bridge: ConsoleBridge;
  readonly #host: ProviderActHost;
  #generation = 0;

  public constructor(bridge: ConsoleBridge, host: ProviderActHost) {
    this.#bridge = bridge;
    this.#host = host;
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
  public retireInFlight(): void {
    this.#generation += 1;
  }

  /**
   * Hand the participant to one provider's own sign-in, and read again afterwards.
   *
   * THE ACCOUNT TRAVELS WITH THE PROVIDER. The remedy this control was rendered from
   * names the account whose credential home the invocation authenticates into, and a
   * provider with two registered accounts has two such homes — so a hand-off carrying
   * only the provider name leaves the surface behind it to elect one, and the
   * election it can afford is the provider default: a different account from the one
   * whose remedy the person pressed. The reading is a PARAMETER for that reason: it
   * is resolved from the snapshot the control was rendered against, before the first
   * await, rather than read back off a model that may have published since.
   *
   * The re-read is the point: the sign-in process's exit is NOT the definition of
   * success — the probe behind the readiness derivation is — so what this reports is
   * whatever the projection says next, never that the hand-off "worked".
   */
  public async handOffSignIn(
    providerName: string,
    reading: ProviderReadinessReading,
  ): Promise<void> {
    const generation = this.#generation;
    const providerAccountId = signInAccountFor(reading, providerName);
    this.#host.publishAction(providerName, { kind: "handing-off" });
    const settlement = await settleGrowthRead(
      this.#bridge.growth.onboardingProviderSignInHandoff(
        providerAccountId === undefined ? { providerName } : { providerName, providerAccountId },
      ),
    );
    if (generation !== this.#generation) {
      return;
    }
    if (settlement.status !== "served") {
      this.#host.publishAction(providerName, { kind: "refused", refusal: settlement });
      return;
    }
    this.#host.publishAction(providerName, { kind: "handed-off" });
    await this.#host.readProjection();
  }

  /**
   * Probe one account, then read the projection again.
   *
   * Two calls and not one, because they answer different questions: the probe
   * observes ONE account's credential state and the derivation answers per provider
   * from whichever account resolved. Reading the probe's own reply as the row's new
   * state would be this console re-deriving readiness, which is the defect the
   * required `readiness` member exists to remove.
   *
   * THE SUPERVISOR'S BLOCK IS CHECKED BY THE CALLER AND NOT HERE, which is the same
   * claim the model's own method states: the guard is fail-closed at the DISPATCH
   * site, ahead of the in-flight publish, and this class holds no window state to
   * derive it from. Arriving here means the write was admitted.
   */
  public async recheck(providerName: string, accountId: ProviderAccountId): Promise<void> {
    const generation = this.#generation;
    this.#host.publishAction(providerName, { kind: "rechecking" });
    const reply = await callDaemon(this.#bridge, RECHECK_METHOD, { accountId });
    if (generation !== this.#generation) {
      return;
    }
    if (reply.status !== "served") {
      this.#host.publishAction(providerName, { kind: "refused", refusal: reply.refusal });
      return;
    }
    this.#host.publishAction(providerName, IDLE_PROVIDER_ACTION);
    await this.#host.readProjection();
  }
}
