// What a refusal may carry BEYOND the three members every refusal has, and how each
// one is read back off a value nobody validated.
//
// `core/refusal.ts` closes the refusal at `code` / `detail` / `origin` and says why:
// three fields, each earning its place, one shape for the whole console. Producers
// still widen it — this module's own `retry` for a rate-limited wire reply, and the
// growth port's `operationId` / `slateRow` / `owningDocument` for a wire the corpus
// has not registered yet — and a widening is legitimate exactly while it is
// REGISTERED. That is what this file is: the registry, and one reader per member.
//
// IT EXISTS BECAUSE THE NORMALIZER REBUILDS. `core/wire-rejection.ts` recognizes a
// refusal structurally and then rebuilds it onto a fresh object rather than handing
// the candidate back, because a candidate's second property read is free to throw
// into a renderer that has already left every `catch`. That rebuild is correct and it
// dropped everything it did not know about — so a growth refusal that travelled as a
// thrown `ConsoleRefusalError` reached a surface with its ledger gone, and the one
// answer available was for the caller to skip the normalizer for that case and hand
// the value back verbatim. Verbatim is the thing the rebuild exists to prevent. So
// the rebuild learns the set instead, and there is no arm anywhere that returns a
// candidate by reference.
//
// THE SET IS CLOSED AND IT IS CLOSED HERE, not at each producer, and the two halves
// are held together by {@link REFUSAL_EXTENSION_READERS}: its type is a mapped type
// over {@link ConsoleRefusalExtensions}, so a member added to the interface without a
// reader fails to compile and a reader for a member the interface does not declare
// fails the same way. An arbitrary key a producer invented reaches no reader and so
// reaches no rebuilt refusal — which is the property that makes carrying members
// through a rebuild safe at all.
//
// EACH MEMBER IS READ ONCE, GUARDEDLY, AND TYPE-CHECKED. Every reader goes through
// `readGuardedProperty`, so a getter that throws is an absent member rather than a
// throw on the failure path; and every reader answers `undefined` for a value that is
// not what the member is registered as, so a hostile `{ operationId: { …a Proxy… } }`
// contributes nothing rather than travelling to a renderer that will format it.
//
// `code`, `detail` and `origin` are NOT here. They are the refusal, not an extension
// of one, and `wire-rejection.ts` classifies on them — a member in both places would
// be read twice and could be classified one way and rebuilt another.
//
// AND A UNION'S DISCRIMINANT IS NOT AN EXTENSION EITHER. `GrowthUnavailable` carries
// `status: "unavailable"` because it is one arm of `GrowthOutcome`, and that member is
// deliberately absent from the registry below: reading it off an unvalidated candidate
// and carrying it onto a rebuilt refusal would let a rejection that happened to spell
// `status: "served"` answer as the arm it is not, and the next reader would go looking
// for the value that arm carries. What travels is the ledger a person can act on, never
// the word that decides which shape a value is.

import { readGuardedProperty } from "../../../../shared/wire-errors.js";

import { parseInstant } from "./instant.js";
import type { ConsoleRefusal } from "./refusal.js";

/**
 * When the refusing side said the caller may try again.
 *
 * Both members are registered: `error-contracts.md §Rate Limiting` puts
 * `retryAfter` (seconds) and `resetAt` (an RFC 3339 instant) on the rate-limit
 * envelope, and the JSON-RPC mapping carries them through `data.fields`. Nothing is
 * invented here — an envelope that names neither produces no hint at all rather than
 * a zero, because "retry immediately" and "the refusing side said nothing about
 * retrying" are different facts and a surface must not render the second as the
 * first.
 *
 * `resetAt` is READ rather than carried: a hint that names an instant this console
 * cannot parse is not a hint, so it is dropped by {@link parseInstant} the same way
 * every other unreadable stamp is, and what survives is a number a countdown can use.
 */
export interface WireRetryHint {
  /** Seconds until a retry is allowed, where the wire named a relative bound. */
  readonly afterSeconds?: number;
  /** Epoch milliseconds at which the limit resets, where the wire named an instant. */
  readonly atEpochMilliseconds?: number;
}

/**
 * Every member a console producer may carry on a refusal beyond the core three.
 *
 * Each is optional because each belongs to one producer, and a refusal from any other
 * producer carries none of them. They are typed as widely as `core/` can type them:
 * the three ledger members are `GrowthOperationId` / `GrowthSlateRowId` / a document
 * name at their producer, and naming those types here would make the bottom family
 * import the bridge — the inversion `core/refusal.ts` refuses for `code` and refuses
 * again here.
 */
export interface ConsoleRefusalExtensions {
  /** Registered by `core/wire-rejection.ts`: when a retry is allowed. */
  readonly retry?: WireRetryHint;
  /** Registered by `bridge/growth-port/growth-port.ts`: which growth operation was called. */
  readonly operationId?: string;
  /** Registered by `bridge/growth-port/growth-port.ts`: which growth-slate row it serves. */
  readonly slateRow?: string;
  /** Registered by `bridge/growth-port/growth-port.ts`: which document owes the wire. */
  readonly owningDocument?: string;
}

/** A refusal plus whatever registered members its producer carried on it. */
export type ExtendedConsoleRefusal = ConsoleRefusal & ConsoleRefusalExtensions;

/**
 * Assemble a hint from two candidate numbers, or answer none.
 *
 * The one assembler both hint readers share. They differ in WHERE the two numbers are
 * read from — the wire's spelling versus this console's own — and agree on what counts
 * as a bound, which is the half that would drift if it were written twice.
 */
function retryHintOf(
  afterSeconds: unknown,
  atEpochMilliseconds: unknown,
): WireRetryHint | undefined {
  const hint: { afterSeconds?: number; atEpochMilliseconds?: number } = {};
  if (typeof afterSeconds === "number" && Number.isFinite(afterSeconds) && afterSeconds >= 0) {
    hint.afterSeconds = afterSeconds;
  }
  if (typeof atEpochMilliseconds === "number" && Number.isFinite(atEpochMilliseconds)) {
    hint.atEpochMilliseconds = atEpochMilliseconds;
  }
  return hint.afterSeconds === undefined && hint.atEpochMilliseconds === undefined
    ? undefined
    : hint;
}

/**
 * The two positions a retry bound is registered at on the WIRE, as an extension.
 *
 * Not an extension READER: it takes the wire's own spelling off an envelope that is
 * not a refusal at all, which is why the registry below does not hold it and the two
 * wire arms call it directly. It answers the same `ConsoleRefusalExtensions` shape
 * they do, so a bound the wire did not send is an ABSENT member rather than a present
 * `undefined` one — the distinction a renderer asking "does it carry a retry" reads.
 */
export function wireRetryExtension(source: unknown): ConsoleRefusalExtensions {
  const resetAt = readGuardedProperty(source, "resetAt");
  const reset = typeof resetAt === "string" ? parseInstant(resetAt) : undefined;
  const retry = retryHintOf(
    readGuardedProperty(source, "retryAfter"),
    reset?.kind === "instant" ? reset.epochMilliseconds : undefined,
  );
  return retry === undefined ? {} : { retry };
}

/** A hint a refusal already carries, in this console's own spelling, read guardedly. */
function carriedRetryHint(candidate: unknown): WireRetryHint | undefined {
  // One read of `retry`, then two of the hint it produced: a getter that answers
  // differently the second time would otherwise assemble a hint from two objects.
  const carried = readGuardedProperty(candidate, "retry");
  return retryHintOf(
    readGuardedProperty(carried, "afterSeconds"),
    readGuardedProperty(carried, "atEpochMilliseconds"),
  );
}

/**
 * A member registered as an identifier: a non-empty string, or nothing.
 *
 * Non-EMPTY rather than merely a string, because an empty identifier is not one — it
 * would travel to a ledger renderer as a row naming nobody, which is worse than the
 * member being absent and honest about it.
 */
function identifierMemberReader(memberName: string): (candidate: unknown) => string | undefined {
  return (candidate: unknown): string | undefined => {
    const value = readGuardedProperty(candidate, memberName);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
}

/**
 * One reader per registered member, and the reason the set cannot drift.
 *
 * The mapped type over `Required<ConsoleRefusalExtensions>` is the mechanism: the
 * compiler demands an entry for every member the interface declares and refuses one
 * for a member it does not, so the registry and the type it registers are the same
 * set by construction rather than by review.
 */
const REFUSAL_EXTENSION_READERS: {
  readonly [Member in keyof Required<ConsoleRefusalExtensions>]: (
    candidate: unknown,
  ) => Required<ConsoleRefusalExtensions>[Member] | undefined;
} = {
  retry: carriedRetryHint,
  operationId: identifierMemberReader("operationId"),
  slateRow: identifierMemberReader("slateRow"),
  owningDocument: identifierMemberReader("owningDocument"),
};

/** Every registered extension member, as a set a test can walk. */
export const CONSOLE_REFUSAL_EXTENSION_MEMBERS: readonly (keyof ConsoleRefusalExtensions)[] =
  Object.keys(REFUSAL_EXTENSION_READERS) as (keyof ConsoleRefusalExtensions)[];

/**
 * Read every registered extension a candidate carries, and nothing else.
 *
 * TOTAL, for the same reason `isConsoleRefusal` is: every caller is on a failure path
 * and the value is whatever a producer threw. A member that is absent, unreadable, or
 * not the type it is registered as is simply not on the answer — and a member NOT on
 * the registry is not on the answer whatever the candidate carries, which is the whole
 * of "a closed set, never arbitrary keys".
 *
 * The one cast is on the accumulator's index: `Object.entries` erases the pairing
 * between a key and its reader's return type, and the table above is where that
 * pairing is actually checked.
 */
export function readRefusalExtensions(candidate: unknown): ConsoleRefusalExtensions {
  const extensions: Record<string, unknown> = {};
  for (const [memberName, readMember] of Object.entries(REFUSAL_EXTENSION_READERS)) {
    const value = readMember(candidate);
    if (value !== undefined) {
      extensions[memberName] = value;
    }
  }
  return extensions as ConsoleRefusalExtensions;
}

/**
 * Attach only the extensions that were actually read.
 *
 * Written once rather than at each arm so no arm can ship a `retry: undefined`
 * member: the refusal shape is compared structurally in tests and rendered by
 * components that ask whether the member is PRESENT, and a present-but-undefined
 * member answers that question wrongly.
 */
export function withRefusalExtensions(
  refusal: ConsoleRefusal,
  extensions: ConsoleRefusalExtensions,
): ExtendedConsoleRefusal {
  return { ...refusal, ...extensions };
}
