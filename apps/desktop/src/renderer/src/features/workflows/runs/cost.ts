// A run's or a step's cost as the screen reads it: the cost itself in the one money format, and
// the account that paid. A run or step that spent nothing reads `$0.00` and names no account. The
// daemon sums a run's cost from its steps' stored amounts; nothing here adds figures. A cost the
// daemon sent is a wire figure; the `$0.00` of a run nothing was billed for is the app's own,
// since the daemon sends no cost for it.

import { accountLabel } from "@ai-sidekicks/contracts/provider/account/label";
import type { ProviderAccount } from "@ai-sidekicks/contracts/provider/account/record";
import type { WorkflowCost } from "@ai-sidekicks/contracts/workflow/run/step/record";

import { formatMoney } from "#renderer/lib/wire/figures.js";
import type { FigureSentencePart } from "#renderer/lib/figure-sentence.js";

/** How many micro-dollars make a dollar. */
const MICROS_PER_DOLLAR = 1_000_000;

/**
 * What the account registry says about the account a cost was paid from: not read yet, read
 * without it because it was removed, carrying it with no name its provider reported yet, or
 * carrying it with the label it is named by.
 */
export type PayerReading =
  | { readonly kind: "unread" }
  | { readonly kind: "removed" }
  | { readonly kind: "unnamed" }
  | { readonly kind: "named"; readonly label: string };

/** The cost alone, `$0.1865` or `$7.30`; a plain `$0.00` where nothing was spent. */
export function costFigure(cost: WorkflowCost | undefined): FigureSentencePart {
  const amount = formatMoney((cost?.usdMicros ?? 0) / MICROS_PER_DOLLAR);
  return cost === undefined ? amount : { wire: amount };
}

/**
 * What `accounts`, the registry as read or `undefined` before the read, says about the account
 * `providerAccountId` names.
 */
export function readPayer(
  accounts: readonly ProviderAccount[] | undefined,
  providerAccountId: string,
): PayerReading {
  if (accounts === undefined) {
    return { kind: "unread" };
  }
  const payer = accounts.find((account) => account.accountId === providerAccountId);
  if (payer === undefined) {
    return { kind: "removed" };
  }
  const label = accountLabel(payer);
  return label === undefined ? { kind: "unnamed" } : { kind: "named", label };
}

/**
 * The cost and the account that paid, `$7.30 · sam@example.com · Max`, or `$7.30 · Removed
 * account` for a payer the read registry no longer carries. Never the account's id: before the
 * registry is read, and while the payer has no name, it is the cost alone.
 */
export function costWithPayer(
  cost: WorkflowCost | undefined,
  payerOf: (providerAccountId: string) => PayerReading,
): readonly FigureSentencePart[] {
  if (cost === undefined) {
    return [costFigure(undefined)];
  }
  const payer = payerOf(cost.providerAccountId);
  const payerWords =
    payer.kind === "removed" ? "Removed account" : payer.kind === "named" ? payer.label : undefined;
  return payerWords === undefined ? [costFigure(cost)] : [costFigure(cost), ` · ${payerWords}`];
}
