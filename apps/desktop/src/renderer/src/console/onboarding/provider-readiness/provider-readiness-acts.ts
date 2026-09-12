// The one act this window performs AGAINST a provider, and the register that retires
// it.
//
// SPLIT FROM THE MODEL BECAUSE IT IS A DIFFERENT JOB. `provider-readiness.ts` holds a
// READING — what the daemon's registry says this node can run — and keeps it current
// through one scheduler and one read line. What lives here is the other half: a
// MUTATION a person dispatches from a row, which ends by asking that reading to be
// taken again. The two halves share nothing but the snapshot they publish into, which
// is why the model composes this rather than inheriting it, and why the seam is a
// collaborator rather than a reach back into private state.
//
// AND THE GENERATION CAME WITH IT, because it is the act's. It stamps the act at the
// moment it is dispatched and refuses its settlement where the model has since been
// retired or re-addressed — a re-check's refusal is ABOUT the account that was on
// screen, so it may not land beside a scope that never produced it. The READ has no
// use for it any more: the model's read line is addressed at the scope, so a
// re-address abandons the line the old read is on and a newer read supersedes an older
// one, which is the same claim expressed where it can also STOP the call rather than
// only ignore its reply.
//
// WHY THERE IS NO SIGN-IN ACT HERE. There was one, and it was a defect: it dispatched
// a growth operation that asked the daemon to start a provider's login.
// This step **displays** the invocation and never runs it on the operator's behalf, and
// the five `onboarding.*` methods are fixed in name, count, and shape. The brokered
// login lives on the provider-management surface, and the first-run step's
// `providerAccount.*` calls exclude `providerAccount.login` and `loginCancel`, so that a
// first run never depends on a brokered process the operator did not ask for. The remedy
// is rendered by `ProviderRow.tsx` out of the readiness entry the daemon already
// composed, and nothing dispatches it.
//
// AND THE ACT DOES NOT REPORT ITS OWN SUCCESS. A probe's own reply is not the row's
// new state — the readiness derivation is — which is why this leg ends at
// `readProjection` and why nothing here composes a reading of its own.

import type { ProviderAccountId } from "@ai-sidekicks/contracts";

import { callDaemon, type ConsoleBridge } from "../../bridge/index.js";
import type { MutatingDaemonMethod } from "../../store/index.js";
import { IDLE_PROVIDER_ACTION, type ProviderActionReading } from "./provider-readiness-reading.js";

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

/** The act a provider row dispatches, and the register that decides what may land. */
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
