// The account-plane quota fold: which reading is current, and how the pair is read out.
//
// Split out of `provider-account-quota.ts` because the two halves answer different
// questions. That module owns the WIRE — one read, one tail, one reading per bridge,
// and what it says when either could not be read. This one owns the FOLD, which is
// pure: given the accounts and the quota rows seen so far, which reading is current
// for each `(accountId, limitId)`, and what does a surface render for it. A pure fold
// is drivable from a test with no bridge and no React, which is what the supersession
// rules below need, and the two together were past the size at which one file is
// doing one job.
//
// THE KEY IS `(accountId, limitId)` AND NOT THE WINDOW'S DURATION, because a pinned
// provider surface publishes three distinct windows of the same length and a duration
// key silently collapses them into whichever arrived last.
//
// SUPERSESSION IS TWO RULES IN ONE ORDER, AND THE ORDER IS THE POINT.
// `Spec-029 §Per-limit provider quota` states them as "newest wins, by observation
// time — except that a same-window reading never moves backward", and the exception
// is evaluated FIRST. Consumption inside one window rises monotonically, so a lower
// `usedPercent` against the same `limitId` and the same `resetsAt` is not a newer
// truth however new its timestamp is: it is an erroneous or out-of-order reading, and
// seating it on timestamp alone would drop a 90%-consumed account to 20% and hide
// imminent exhaustion until the window actually resets. Only once that guard has
// passed does observation time decide, with arrival order breaking an exact tie.
//
// A NEW WINDOW IS NOT A REGRESSION. `resetsAt` moving is exactly what a window reset
// looks like, so a lower reading under a different `resetsAt` is the ordinary case and
// is seated on its timestamp like any other — which is why the guard keys on the reset
// horizon rather than on the percentage alone.
//
// AND SUPERSESSION IS ALSO A COMPARISON AGAINST THE ACCOUNT ITSELF. Every quota row
// carries the `credentialGeneration` it was observed under and every account carries
// the generation it is on now, so a reading behind its own account's current
// generation is stale as a fact rather than as an inference — which is what the
// account plane's own contract asks a renderer to do, because a credential-home
// rebuild does not clear stored readings.

import type { ProviderAccount, ProviderAccountUsageWindow } from "@ai-sidekicks/contracts";

import { compareInstants, parseInstant } from "../../core/index.js";

/** One provider account's quota in one limit window, as a surface renders it. */
export interface ProviderQuotaReading {
  readonly accountId: string;
  readonly limitId: string;
  /** The account's operator-chosen label. A chip that named no account names nothing. */
  readonly accountLabel: string;
  /**
   * The window's own label where the provider publishes one, and its `limitId`
   * verbatim where it does not.
   *
   * The fallback is the wire's own identifier rather than composed prose: the id is
   * what the provider calls this window, so it is the most specific true thing the
   * console holds, and inventing a name would put a word on screen no provider used.
   */
  readonly limitLabel: string;
  /** Utilization as sent. NOT clamped: a soft limit can genuinely be over-consumed. */
  readonly usedPercent: number;
  /** RFC 3339 where the provider supplied one. A countdown renders only if it did. */
  readonly resetsAt: string | undefined;
  /** RFC 3339 observation instant — the merge key. */
  readonly observedAt: string;
  /**
   * True when this reading was observed under an older credential generation than
   * its own account is on now.
   *
   * A credential-home rebuild does not clear stored readings — the provider-side
   * allowance keeps running while the home is empty — so the reading stays the best
   * figure available and is presented as one taken before the current credential.
   */
  readonly isStale: boolean;
}

/** Remaining quota, from the consumed figure the wire supplies. Never sent as such. */
export function remainingPercentOf(reading: ProviderQuotaReading): number {
  // Floored at zero for the same reason the used figure is NOT clamped: the wire may
  // report over-consumption against a soft limit, which is a true reading to show,
  // while a negative remainder is an arithmetic artefact rather than a quota.
  return Math.max(0, 100 - reading.usedPercent);
}

/**
 * What merging one reading into the fold did. Closed, and derived into a union below
 * so a fourth outcome cannot appear in the rule while a caller still handles three.
 *
 * The two held arms are deliberately DISTINCT rather than one "not seated": a reading
 * held because a newer observation already stands is the ordinary case and worth no
 * word anywhere, while one held by the monotonicity guard is a reading the wire should
 * not have sent, and the caller records it. Collapsing them would make the second
 * unreportable.
 */
export const QUOTA_MERGE_DISPOSITIONS = ["seated", "held", "dropped-below-high-water"] as const;

/** One merge outcome, derived from the tuple above. */
export type QuotaMergeDisposition = (typeof QUOTA_MERGE_DISPOSITIONS)[number];

/**
 * Which of two readings for one key is current.
 *
 * The high-water guard runs BEFORE observation time, which is the whole rule: a lower
 * same-window reading loses however new it claims to be. `isCandidateLaterArrival`
 * breaks an exact `observedAt` tie and decides nothing else — arrival order is the
 * weakest evidence here, so it is consulted last and only when the wire's own ordering
 * key cannot separate the two.
 */
export function quotaMergeDispositionFor(
  candidate: ProviderAccountUsageWindow,
  held: ProviderAccountUsageWindow,
  isCandidateLaterArrival: boolean,
): QuotaMergeDisposition {
  if (isSameWindow(candidate, held) && candidate.usedPercent < held.usedPercent) {
    return "dropped-below-high-water";
  }
  const ranked = compareInstants(
    parseInstant(candidate.observedAt),
    parseInstant(held.observedAt),
    "newest-first",
  );
  if (ranked === 0) {
    return isCandidateLaterArrival ? "seated" : "held";
  }
  return ranked < 0 ? "seated" : "held";
}

/**
 * Whether two readings describe the same limit window.
 *
 * Both halves are compared even though the fold's own key already pairs the account
 * with the limit, which makes the first a tautology for every reading that reaches the
 * fold. It is checked anyway because this function is total over any two readings a
 * caller hands it, and because the spec states the guard's condition as both members —
 * a reader comparing the code against the rule should find both.
 *
 * An absent `resetsAt` on both sides compares equal, which is correct: a provider that
 * publishes no reset horizon publishes one continuing window, and treating two such
 * readings as different windows would disable the guard for exactly that provider.
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
 * The accounts and quota rows one bridge has seen, and the readings they compose into.
 *
 * A class with private fields rather than two maps passed around, because the merge
 * rule and the arrival ordinal that breaks its ties are one piece of state: an ordinal
 * handed out by a caller could be reused, and a reused ordinal makes an exact-tie
 * comparison answer differently depending on who asked.
 */
export class ProviderQuotaFold {
  readonly #accountsById = new Map<string, ProviderAccount>();
  readonly #windowsByKey = new Map<string, HeldQuotaWindow>();
  #nextArrivalOrdinal = 0;

  /** Record an account whole. The registry sends state, not deltas. */
  public seatAccount(account: ProviderAccount): void {
    this.#accountsById.set(account.accountId, account);
  }

  /**
   * Drop an account and every reading filed under it.
   *
   * The readings go with the account rather than being left keyed to an id nothing
   * can label: `accountId` is daemon-minted and immutable, so a re-registration
   * mints a NEW one and these rows could never be claimed again — they would sit in
   * the fold for the life of the window describing an account that has left.
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
  public mergeWindow(usageWindow: ProviderAccountUsageWindow): QuotaMergeDisposition {
    const key = quotaKey(usageWindow.accountId, usageWindow.limitId);
    const held = this.#windowsByKey.get(key);
    const arrivalOrdinal = this.#nextArrivalOrdinal;
    this.#nextArrivalOrdinal += 1;
    if (held === undefined) {
      this.#windowsByKey.set(key, { usageWindow, arrivalOrdinal });
      return "seated";
    }
    const disposition = quotaMergeDispositionFor(
      usageWindow,
      held.usageWindow,
      arrivalOrdinal > held.arrivalOrdinal,
    );
    if (disposition === "seated") {
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
        // A reading whose account the registry does not carry is dropped rather than
        // rendered under its opaque id: the chip's first word is whose quota this is,
        // and an id nobody chose answers that question with a value nobody recognises.
        continue;
      }
      readings.push(readingFor(held.usageWindow, account));
    }
    return readings.length === 0 ? NO_READINGS : readings.sort(compareByLabels);
  }

  /**
   * Every account the registry carries, by the id the daemon minted for it.
   *
   * OFF THE SAME SEATING AS THE READINGS, and that is the whole point of publishing
   * it here. `accountId` is a handle and `displayLabel` is what a person reads, so
   * any surface naming a paying account has to join the two — and the account plane
   * has exactly one reader in this window, whose read and tail already hold every
   * account whole. A surface that took its own `providerAccount.list` would be a
   * second reading of one registry: two arrival orders, and no way to say which was
   * right when a removal reached one of them first.
   *
   * A SEPARATE ANSWER FROM {@link readings}, because the two have different
   * membership. A reading exists only where a quota row has been observed, and an
   * account with no observed window still has a label to render — so a consumer that
   * scanned the readings for one would find nothing and fall back to the handle,
   * which is the state that rule forbids.
   */
  public accountLabels(): ReadonlyMap<string, string> {
    const labels = new Map<string, string>();
    for (const account of this.#accountsById.values()) {
      labels.set(account.accountId, account.displayLabel);
    }
    return labels;
  }
}

/** One window and its account, as a surface renders the pair. */
function readingFor(
  usageWindow: ProviderAccountUsageWindow,
  account: ProviderAccount,
): ProviderQuotaReading {
  return {
    accountId: usageWindow.accountId,
    limitId: usageWindow.limitId,
    accountLabel: account.displayLabel,
    limitLabel: usageWindow.label ?? usageWindow.limitId,
    usedPercent: usageWindow.usedPercent,
    resetsAt: usageWindow.resetsAt,
    observedAt: usageWindow.observedAt,
    isStale: usageWindow.observedCredentialGeneration < account.credentialGeneration,
  };
}

/** The `(accountId, limitId)` pair, spelled once. */
function quotaKey(accountId: string, limitId: string): string {
  return `${accountId} ${limitId}`;
}

/**
 * Ordered by label so two renders of one reading place a chip in the same position.
 *
 * Deliberately NOT by urgency: a chip that moves when its own number moves is a chip
 * a person has to re-find at the moment they most need to read it.
 */
function compareByLabels(left: ProviderQuotaReading, right: ProviderQuotaReading): number {
  const byAccount = left.accountLabel.localeCompare(right.accountLabel);
  return byAccount === 0 ? left.limitLabel.localeCompare(right.limitLabel) : byAccount;
}
