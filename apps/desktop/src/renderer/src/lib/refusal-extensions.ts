// The members a refusal may carry beyond `code`, `detail` and `origin`, and the reader for each.
//
// `wire-rejection.ts` rebuilds every refusal onto a fresh object, which drops unknown members, so
// the rebuild reads exactly this registered set. `REFUSAL_EXTENSION_READERS` is a mapped type over
// `RefusalExtensions`: a member without a reader, or a reader without a member, fails to compile.
// An arbitrary key a producer invented reaches no reader and no rebuilt refusal.
//
// Each member is read once through `readGuardedProperty` and type-checked, so a throwing getter is
// an absent member and a hostile value contributes nothing. `code`, `detail` and `origin` are not
// here: they are the refusal itself, and `wire-rejection.ts` classifies on them.

import { readGuardedProperty } from "./wire-errors.js";

import { parseInstant } from "./instant.js";
import type { Refusal } from "./refusal.js";
import { readWireString } from "./wire-strings.js";

/**
 * When the refusing side said the caller may try again. An envelope naming neither bound yields
 * no hint rather than a zero, since "retry immediately" and "said nothing" are different facts.
 * The wire's `resetAt` (an RFC 3339 instant) is parsed by {@link parseInstant} and dropped when
 * unreadable, so what survives is a number a countdown can use.
 */
export interface WireRetryHint {
  /** Seconds until a retry is allowed, where the wire named a relative bound. */
  readonly afterSeconds?: number;
  /** Epoch milliseconds at which the limit resets, where the wire named an instant. */
  readonly atEpochMilliseconds?: number;
}

/** Every member a producer may carry on a refusal beyond the core three; each is optional. */
export interface RefusalExtensions {
  /** Registered by `wire-rejection.ts`: when a retry is allowed. */
  readonly retry?: WireRetryHint;
  /**
   * Registered by `wire-rejection.ts`: the bindings a fan-out mutation failed on, carried on
   * `data.fields` for `session.goal_delivery_failed`. Identifiers, not prose; a component
   * renders them as wire figures.
   */
  readonly failedBindingIds?: readonly string[];
}

/** A refusal plus whatever registered members its producer carried on it. */
export type ExtendedRefusal = Refusal & RefusalExtensions;

/**
 * The retry bound as the wire spells it (`retryAfter` seconds, `resetAt` instant), as an
 * extension. Not held by the reader registry, since it reads an envelope that is not a refusal.
 * A bound the wire did not send is an absent member, not a present `undefined`.
 */
export function wireRetryExtension(source: unknown): RefusalExtensions {
  const resetAt = readGuardedProperty(source, "resetAt");
  const reset = typeof resetAt === "string" ? parseInstant(resetAt) : undefined;
  const retry = retryHintOf(
    readGuardedProperty(source, "retryAfter"),
    reset?.kind === "instant" ? reset.epochMilliseconds : undefined,
  );
  return retry === undefined ? {} : { retry };
}

/** The failed bindings a wire envelope named, as an extension; see {@link wireRetryExtension}. */
export function wireFailedBindingsExtension(source: unknown): RefusalExtensions {
  const failedBindingIds = identifierListOf(readGuardedProperty(source, "failedBindingIds"));
  return failedBindingIds === undefined ? {} : { failedBindingIds };
}

/** Assembles a hint from two candidate numbers, or none. Shared by both hint readers. */
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

/** A hint a refusal already carries, in this console's own spelling, read guardedly. */
function carriedRetryHint(candidate: unknown): WireRetryHint | undefined {
  // One read of `retry`, so a getter answering differently the second time cannot mix two objects.
  const carried = readGuardedProperty(candidate, "retry");
  return retryHintOf(
    readGuardedProperty(carried, "afterSeconds"),
    readGuardedProperty(carried, "atEpochMilliseconds"),
  );
}

/**
 * A list of non-empty strings, or nothing. Unreadable elements are dropped; a non-array or an
 * all-unreadable list answers `undefined`, since an empty list would claim the daemon named none.
 */
function identifierListOf(source: unknown): readonly string[] | undefined {
  if (!Array.isArray(source)) {
    return undefined;
  }
  const identifiers = source.flatMap((element: unknown) => {
    const identifier = readWireString(element);
    return identifier === undefined ? [] : [identifier];
  });
  return identifiers.length === 0 ? undefined : identifiers;
}

/** One reader per registered member; the mapped type keeps registry and interface identical. */
const REFUSAL_EXTENSION_READERS: {
  readonly [Member in keyof Required<RefusalExtensions>]: (
    candidate: unknown,
  ) => Required<RefusalExtensions>[Member] | undefined;
} = {
  retry: carriedRetryHint,
  failedBindingIds: (candidate: unknown) =>
    identifierListOf(readGuardedProperty(candidate, "failedBindingIds")),
};

/**
 * Reads every registered extension a candidate carries, and nothing else. Total, like
 * `isRefusal`: an absent, unreadable or mistyped member is left off the answer. The cast is on the
 * accumulator because `Object.entries` erases the key-to-reader pairing the table above checks.
 */
export function readRefusalExtensions(candidate: unknown): RefusalExtensions {
  const extensions: Record<string, unknown> = {};
  for (const [memberName, readMember] of Object.entries(REFUSAL_EXTENSION_READERS)) {
    const value = readMember(candidate);
    if (value !== undefined) {
      extensions[memberName] = value;
    }
  }
  return extensions as RefusalExtensions;
}

/** Attaches only the extensions actually read, so no arm ships a present-but-undefined member. */
export function withRefusalExtensions(
  refusal: Refusal,
  extensions: RefusalExtensions,
): ExtendedRefusal {
  return { ...refusal, ...extensions };
}
