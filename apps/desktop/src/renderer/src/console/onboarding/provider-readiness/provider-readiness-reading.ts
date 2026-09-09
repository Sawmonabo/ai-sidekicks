// What the provider step READS, and the projections a surface takes over it.
//
// SPLIT FROM `provider-readiness.ts`, which owns the model. That module says what this
// window DOES — the read, the one act, the scope it is addressed at, and what the
// supervisor's condition closes; this one says what a surface is handed and what it may
// derive from it. The seam is the one `store/shell/shell-state.ts` and its neighbour already
// set: a vocabulary and the behaviour over it are two jobs with two readers, and
// together they were one file past the package's ceiling.
//
// The readers of this half never touch the model. `ProviderRow.tsx` renders one act,
// `ProviderReadinessStep.tsx` renders one arm of the reading and joins accounts to a
// row, and `CompletionSummary.tsx` names which providers are not ready — three surfaces
// over the daemon's own projection, composing nothing of their own.

import type { ProviderAccount, ProviderReadiness } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../../core/index.js";
import type { ShellMutationBlock } from "../../store/index.js";

/** What the step knows about this node's providers. Closed; every arm renders. */
export type ProviderReadinessReading =
  | { readonly kind: "reading" }
  | {
      readonly kind: "read";
      readonly entries: readonly ProviderReadiness[];
      readonly accounts: readonly ProviderAccount[];
    }
  | { readonly kind: "unreadable"; readonly refusal: ConsoleRefusal };

/**
 * What this window has done about ONE provider since the step opened.
 *
 * THREE ARMS AND NOT FIVE, because this step performs exactly one act against a
 * provider. `Spec-026 §Provider Authentication (Group B)` has the sign-in step
 * "**display** the invocation and never run it on the operator's behalf", and
 * `Spec-029 §Brokered interactive sign-in` excludes even the account plane's own login
 * verbs from this flow — so a sign-in is a remedy the row RENDERS and never an act it
 * dispatches, and there is nothing for a `handing-off` or a `handed-off` arm to report.
 */
export type ProviderActionReading =
  | { readonly kind: "idle" }
  | { readonly kind: "rechecking" }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** The idle reading, shared rather than rebuilt, so an untouched row is one object. */
export const IDLE_PROVIDER_ACTION: ProviderActionReading = { kind: "idle" };

/**
 * Everything one render of the step reads, as one value it can compare.
 *
 * `useSyncExternalStore` compares what its snapshot getter answers with `Object.is`
 * and renders nothing when the answer has not moved, so the acts ride a map REPLACED
 * on every publish: one mutated behind a stable reference is a change nothing
 * downstream can see.
 */
export interface ProviderReadinessSnapshot {
  readonly reading: ProviderReadinessReading;
  /** What this window has done about each provider. Absent means untouched. */
  readonly actions: ReadonlyMap<string, ProviderActionReading>;
  /**
   * Why a re-check may not be put right now, or `undefined` while nothing closes it.
   *
   * ON THE SNAPSHOT AND NOT THREADED AS A PROP, because the step already subscribes to
   * this value and a second channel for one fact would be a second answer to it. The
   * model derives it from the shell state through the store's own per-method seam and
   * republishes when it moves, so a row re-enables while a person is looking at it
   * rather than at the next mount.
   */
  readonly recheckBlock: ShellMutationBlock | undefined;
}

/**
 * The zero reading, shared for `IDLE_PROVIDER_ACTION`'s reason: the model opens in it
 * and a re-addressing returns to it, and one object makes that reset legible as the
 * same state rather than as a second spelling of it.
 */
const ZERO_STATE_READING: ProviderReadinessReading = { kind: "reading" };

/**
 * Where the model starts, and where a re-addressing returns it to.
 *
 * A FACTORY AND NOT A SHARED VALUE, because the act map is a collection:
 * `ReadonlyMap` restricts the TypeScript view and not the runtime object, so one held
 * at module scope would be mutable from every model in the renderer. The reading beside
 * it is a literal, which is why that one stays a constant.
 *
 * The block is CARRIED IN rather than cleared, because it is a fact about the window
 * and not about the account the model was addressed at: a scope that moves does not
 * reconnect the shell, and a reset that dropped it would re-enable a control the
 * supervisor still refuses.
 */
export function zeroStateSnapshot(
  recheckBlock: ShellMutationBlock | undefined,
): ProviderReadinessSnapshot {
  return { reading: ZERO_STATE_READING, actions: new Map(), recheckBlock };
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

/*
 * NO `signInAccountFor` HERE ANY MORE, and its absence is the fix rather than a
 * simplification. It resolved which account a sign-in HAND-OFF should name, and there
 * is no hand-off: the remedy names its own account, its own invocation, and its own
 * credential home, and the row renders all three. A helper that picked one account out
 * of a remedy so a caller could dispatch against it is precisely the surface
 * `Spec-026 §Provider Authentication (Group B)` forbids.
 */
