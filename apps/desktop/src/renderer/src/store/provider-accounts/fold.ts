// The account quota fold: which reading is current for each `(accountId, limitId)`, and
// how the pair is read out. It is pure and opens no wire, so tests drive it without a bridge.
//
// The key is `(accountId, limitId)` and not the window's duration, because a pinned provider
// publishes three distinct windows of the same length and a duration key would collapse them.
//
// Supersession is two rules in one order. A same-window reading never moves backward, and that
// guard runs first: consumption inside one window rises monotonically, so a lower
// `usedPercent` for the same `limitId` and `resetsAt` is an erroneous or out-of-order
// reading, and storing it on timestamp alone would hide imminent exhaustion. Only then does
// observation time decide, with arrival order breaking an exact tie. A moved `resetsAt` is a
// window reset, not a regression, so a lower reading under a new `resetsAt` is stored normally.
//
// A reading behind its own account's current `credentialGeneration` is stale as a fact, since a
// credential-home rebuild does not clear stored readings.

import type {
  ProviderAccount,
  ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts/provider/account/record";

import { accountLabel } from "#renderer/lib/account-plane-sentences.js";
import { compareInstants, parseInstant } from "#renderer/lib/instant.js";
import { structuralKey } from "#renderer/lib/structural-key.js";

/** One provider account's quota in one limit window, as a view renders it. */
export interface ProviderQuotaReading {
  readonly accountId: string;
  readonly limitId: string;
  /** What the account is named by; `undefined` where its provider has reported nothing yet. */
  readonly accountLabel: string | undefined;
  /**
   * The window's own label where the provider publishes one, and its `limitId` verbatim where
   * it does not, since inventing a name would put a word on screen no provider used.
   */
  readonly limitLabel: string;
  /** Utilization as sent, not clamped: a soft limit can be over-consumed. */
  readonly usedPercent: number;
  /** RFC 3339 where the provider supplied one. A countdown renders only if it did. */
  readonly resetsAt: string | undefined;
  /** RFC 3339 observation instant — the merge key. */
  readonly observedAt: string;
  /**
   * True when this reading was observed under an older credential generation than its account
   * is on now. The provider-side allowance keeps running while the home is empty, so the
   * reading stays the best figure available and is presented as one taken before the current
   * credential.
   */
  readonly isStale: boolean;
}

/**
 * What merging one reading into the fold did. The two held arms are distinct: a reading held
 * because a newer observation stands is the ordinary case, while one held by the monotonicity
 * guard is a reading the wire should not have sent, and the caller records it.
 */
export const USAGE_WINDOW_MERGE_DISPOSITIONS = [
  "stored",
  "held",
  "dropped-below-high-water",
] as const;

/** One merge outcome, derived from the tuple above. */
export type UsageWindowMergeDisposition = (typeof USAGE_WINDOW_MERGE_DISPOSITIONS)[number];

/**
 * Which of two readings for one key is current.
 *
 * The high-water guard runs before observation time, so a lower same-window reading loses
 * however new it claims to be. `isCandidateLaterArrival` breaks an exact `observedAt` tie and
 * decides nothing else.
 */
export function decideUsageWindowMerge(
  candidate: ProviderAccountUsageWindow,
  held: ProviderAccountUsageWindow,
  isCandidateLaterArrival: boolean,
): UsageWindowMergeDisposition {
  if (isSameWindow(candidate, held) && candidate.usedPercent < held.usedPercent) {
    return "dropped-below-high-water";
  }
  const ranked = compareInstants(
    parseInstant(candidate.observedAt),
    parseInstant(held.observedAt),
    "newest-first",
  );
  if (ranked === 0) {
    return isCandidateLaterArrival ? "stored" : "held";
  }
  return ranked < 0 ? "stored" : "held";
}

/**
 * Whether two readings describe the same limit window.
 *
 * The account half of the key is not compared, since the fold's key already pairs them. An
 * absent `resetsAt` on both sides compares equal: a provider with no reset horizon publishes
 * one continuing window, and treating those readings as different would disable the guard.
 */
function isSameWindow(
  candidate: ProviderAccountUsageWindow,
  held: ProviderAccountUsageWindow,
): boolean {
  return candidate.limitId === held.limitId && candidate.resetsAt === held.resetsAt;
}

/** One quota row with the arrival ordinal that breaks an exact `observedAt` tie. */
interface HeldQuotaWindow {
  readonly usageWindow: ProviderAccountUsageWindow;
  readonly arrivalOrdinal: number;
}

const NO_READINGS: readonly ProviderQuotaReading[] = Object.freeze([]);

/**
 * The accounts and quota rows one bridge has seen, and the readings they compose into. The
 * merge rule and the arrival ordinal that breaks its ties are one piece of state, so the fold
 * hands out ordinals itself.
 */
export class ProviderAccountFold {
  readonly #accountsById = new Map<string, ProviderAccount>();
  readonly #windowsByKey = new Map<string, HeldQuotaWindow>();
  #nextArrivalOrdinal = 0;

  /** Record an account whole. The registry sends state, not deltas. */
  public putAccount(account: ProviderAccount): void {
    this.#accountsById.set(account.accountId, account);
  }

  /**
   * Drops an account and every reading filed under it. `accountId` is daemon-minted and
   * immutable, so a re-registration mints a new one and the old rows could never be claimed.
   */
  public forgetAccount(accountId: string): void {
    this.#accountsById.delete(accountId);
    for (const [key, held] of this.#windowsByKey) {
      if (held.usageWindow.accountId === accountId) {
        this.#windowsByKey.delete(key);
      }
    }
  }

  /** Merge one reading under its `(accountId, limitId)` key, and say what that did. */
  public mergeUsageWindow(usageWindow: ProviderAccountUsageWindow): UsageWindowMergeDisposition {
    const key = quotaKey(usageWindow.accountId, usageWindow.limitId);
    const held = this.#windowsByKey.get(key);
    const arrivalOrdinal = this.#nextArrivalOrdinal;
    this.#nextArrivalOrdinal += 1;
    if (held === undefined) {
      this.#windowsByKey.set(key, { usageWindow, arrivalOrdinal });
      return "stored";
    }
    const disposition = decideUsageWindowMerge(
      usageWindow,
      held.usageWindow,
      arrivalOrdinal > held.arrivalOrdinal,
    );
    if (disposition === "stored") {
      this.#windowsByKey.set(key, { usageWindow, arrivalOrdinal });
    }
    return disposition;
  }

  /** One reading per key, ordered by account then limit label. */
  public readings(): readonly ProviderQuotaReading[] {
    const readings: ProviderQuotaReading[] = [];
    for (const held of this.#windowsByKey.values()) {
      const account = this.#accountsById.get(held.usageWindow.accountId);
      if (account === undefined) {
        // A reading whose account the registry does not carry is dropped rather than rendered
        // under an opaque id nobody chose.
        continue;
      }
      readings.push(readingFor(held.usageWindow, account));
    }
    return readings.length === 0 ? NO_READINGS : readings.sort(compareByLabels);
  }

  /**
   * Every account the registry carries, whole, in the order it was first seen.
   *
   * Beside {@link accountLabels} because a view that lists the registry needs the rows
   * (`billingMode`, health, generation, timestamps), not only the label. Arrival order, not a
   * sort: an account put again keeps its position and a new one appends, so a row does not move
   * under a person's cursor.
   */
  public accounts(): readonly ProviderAccount[] {
    return [...this.#accountsById.values()];
  }

  /**
   * Every quota reading currently held, one per `(accountId, limitId)`: the superseded set, not
   * everything ever seen. A view that renders a window's own members reads the wire row rather
   * than a projection of it.
   */
  public usageWindows(): readonly ProviderAccountUsageWindow[] {
    return [...this.#windowsByKey.values()].map((held) => held.usageWindow);
  }

  /**
   * Every account the registry carries, by the id the daemon minted for it.
   *
   * Off the same held accounts as the readings, so a view naming a paying account joins
   * `accountId` to its label here instead of taking its own `providerAccount.list`, which
   * would be a second reading of one registry. Separate from {@link readings} because an
   * account with no observed window still has a label to render. An account nothing names yet
   * has no entry.
   */
  public accountLabels(): ReadonlyMap<string, string> {
    const labels = new Map<string, string>();
    for (const account of this.#accountsById.values()) {
      const label = accountLabel(account);
      if (label !== undefined) {
        labels.set(account.accountId, label);
      }
    }
    return labels;
  }
}

/** One window and its account, as a view renders the pair. */
function readingFor(
  usageWindow: ProviderAccountUsageWindow,
  account: ProviderAccount,
): ProviderQuotaReading {
  return {
    accountId: usageWindow.accountId,
    limitId: usageWindow.limitId,
    accountLabel: accountLabel(account),
    limitLabel: usageWindow.label ?? usageWindow.limitId,
    usedPercent: usageWindow.usedPercent,
    resetsAt: usageWindow.resetsAt,
    observedAt: usageWindow.observedAt,
    isStale: usageWindow.observedCredentialGeneration < account.credentialGeneration,
  };
}

/**
 * The `(accountId, limitId)` pair, spelled once through the console's tuple encoder. `limitId`
 * is free-form on the wire, so a plain separator join could fold two limits of one account
 * onto one reading.
 */
function quotaKey(accountId: string, limitId: string): string {
  return structuralKey([accountId, limitId]);
}

/**
 * Ordered by label so two renders of one reading place a chip in the same position. Not by
 * urgency: a chip that moves when its number moves is hard to re-find when it matters.
 */
function compareByLabels(left: ProviderQuotaReading, right: ProviderQuotaReading): number {
  const byAccount = (left.accountLabel ?? "").localeCompare(right.accountLabel ?? "");
  return byAccount === 0 ? left.limitLabel.localeCompare(right.limitLabel) : byAccount;
}
