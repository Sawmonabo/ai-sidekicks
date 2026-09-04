// One rejection normalizer, for the whole console.
//
// A rejected promise off the bridge can be anything: an `Error`, a wire envelope
// that crossed the preload boundary as a plain object, an SDK `Error` subclass
// carrying the code on a property, a `ConsoleRefusal` a fixture threw, a string, a
// symbol, `undefined`, or a null-prototype object that throws inside `String()`.
// Before this module every family answered that with its own function, and the six
// answers disagreed on five separate axes — how many arms, whether a carried refusal
// is recognized structurally or by `instanceof`, which fallback code, whether the
// terminal detail is total, and whether the daemon's own code survives at all. One
// of them had no envelope arm, so every daemon code — a permission denial, a missing
// session, a lease conflict — rendered as one generic `read-failed`, and another
// reached for a bare `String(...)` that throws on the very value it exists to show.
//
// THE HOME. `src/shared/wire-errors.ts` is not it, and the reason is structural
// rather than a preference: this function answers with a `ConsoleRefusal`, a
// renderer-only shape declared in `core/refusal.ts`, and `src/shared/` may import
// the contracts package and nothing else (`.dependency-cruiser.mjs`,
// `shared-imports-nothing`) precisely because main and preload compile it too. What
// genuinely IS cross-process — the envelope guard, the total property reader, the
// total stringifier — already lives there, and this module consumes all three
// rather than restating any of them.
//
// WHAT IT ADDS OVER EVERY COPY IT REPLACES: the JSON-RPC arm. `JsonRpcRemoteError`
// (`packages/client-sdk/src/transport/jsonRpcClient.ts`) carries `code` as the
// JSON-RPC *numeric* — `-32603` and its four siblings — while the project's dotted
// code rides at `data.type`, which `packages/contracts` states callers MUST
// discriminate on. A `{ code: string }` guard does not match a number, so every
// family copy dropped `session.not_found`, `repo.not_found`, and every other
// registered code on the floor and rendered its own invented one instead. That arm
// is checked FIRST for the same reason the contract gives: `data.type` is the
// canonical code and a top-level string `code` is the already-flattened form.

import {
  isWireErrorEnvelope,
  lossyStringify,
  readGuardedProperty,
} from "../../../../shared/wire-errors.js";

import { parseInstant } from "./instant.js";
import { isConsoleRefusal, refuse, type ConsoleRefusal } from "./refusal.js";

/**
 * A caller-written refusal for a rejection that carries no code of its own.
 *
 * Some seams know their failure better than the thrown value does: "the call into
 * the browser never answered" names what a person can do next, where the transport's
 * own message names a socket. It replaces the synthesized `<origin>-call-failed`
 * pair — and only that pair. It never displaces a code the other side sent, which is
 * the whole reason the typed arms run first.
 */
export interface RejectionFallback {
  readonly code: string;
  readonly detail: string;
}

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
 * A rejection, as the one shape the console renders.
 *
 * A `ConsoleRefusal` widened by one optional member, so every renderer that already
 * takes a refusal takes this unchanged and only a surface that offers a retry has to
 * know the member exists. `isConsoleRefusal` is structural, so this satisfies it.
 */
export interface WireRefusal extends ConsoleRefusal {
  readonly retry?: WireRetryHint;
}

/** The two positions a retry bound is registered at, read guardedly. */
function retryHintFrom(source: unknown): WireRetryHint | undefined {
  const afterSeconds = readGuardedProperty(source, "retryAfter");
  const resetAt = readGuardedProperty(source, "resetAt");
  const hint: { afterSeconds?: number; atEpochMilliseconds?: number } = {};
  if (typeof afterSeconds === "number" && Number.isFinite(afterSeconds) && afterSeconds >= 0) {
    hint.afterSeconds = afterSeconds;
  }
  if (typeof resetAt === "string") {
    const reset = parseInstant(resetAt);
    if (reset.kind === "instant") {
      hint.atEpochMilliseconds = reset.epochMilliseconds;
    }
  }
  return hint.afterSeconds === undefined && hint.atEpochMilliseconds === undefined
    ? undefined
    : hint;
}

/**
 * Attach a hint only where one was actually read.
 *
 * Written once rather than at each arm so no arm can ship a `retry: undefined`
 * member: the refusal shape is compared structurally in tests and rendered by
 * components that ask whether the member is present, and a present-but-undefined
 * member answers that question wrongly.
 */
function withRetryHint(refusal: ConsoleRefusal, hint: WireRetryHint | undefined): WireRefusal {
  return hint === undefined ? refusal : { ...refusal, retry: hint };
}

/**
 * The typed arms, in order. May throw; {@link normalizeWireRejection} owns totality.
 *
 * Ordered most specific first, because each earlier arm carries a code the later
 * ones would throw away:
 *
 *   1. A value that already IS a `ConsoleRefusal` names its own author and passes
 *      through untouched — including any retry hint it already carries.
 *   2. A value CARRYING a refusal (`ConsoleRefusalError`, the fixture bridge's error,
 *      and any other error built around one) is unwrapped. The check is STRUCTURAL
 *      rather than `instanceof ConsoleRefusalError`, and that is strictly stronger:
 *      `instanceof` walks a prototype chain, which a value that crossed a realm or a
 *      structured clone no longer has, and the failure mode there is silent — the
 *      refusal falls to the terminal arm and its author's code is replaced by one
 *      this function invented.
 *   3. The JSON-RPC `data` envelope: the dotted project code at `data.type`, with the
 *      retry bound from `data.fields`. See this module's header for why it is first
 *      among the wire arms.
 *   4. A flat wire envelope — `{ code, message }` — keeps its code VERBATIM. Rule 9:
 *      the console renders the daemon's code and the daemon's sentence, never a
 *      paraphrase, because `permission_denied` and a lease conflict are different
 *      next moves and both are unactionable once folded into one code.
 */
function classifyRejection(
  origin: string,
  rejection: unknown,
  fallback: RejectionFallback | undefined,
): WireRefusal | undefined {
  if (isConsoleRefusal(rejection)) {
    return rejection;
  }
  const carried = readGuardedProperty(rejection, "refusal");
  if (isConsoleRefusal(carried)) {
    return carried;
  }
  const data = readGuardedProperty(rejection, "data");
  const dottedCode = readGuardedProperty(data, "type");
  const message = readGuardedProperty(rejection, "message");
  if (typeof dottedCode === "string" && dottedCode.length > 0) {
    return withRetryHint(
      refuse(origin, dottedCode, typeof message === "string" ? message : lossyStringify(rejection)),
      retryHintFrom(readGuardedProperty(data, "fields")),
    );
  }
  if (isWireErrorEnvelope(rejection)) {
    return withRetryHint(
      refuse(origin, rejection.code, rejection.message),
      retryHintFrom(rejection),
    );
  }
  if (fallback !== undefined) {
    return refuse(origin, fallback.code, fallback.detail);
  }
  return undefined;
}

/**
 * Normalize any rejection into the console's one refusal shape.
 *
 * TOTAL. It answers a refusal for every input and throws for none, and the `try` is
 * what makes that claim provable rather than merely likely: the guarded reads above
 * cannot throw on their own, but `isConsoleRefusal` and `isWireErrorEnvelope` are
 * shared predicates whose contracts are structural recognition rather than totality,
 * and a value carrying a hostile `refusal` getter would otherwise propagate out of
 * the very function a surface calls to say that something failed — a throw on the
 * failure path, landing in a `catch` that has already been left.
 *
 * `origin` is the calling subsystem, and it is what the synthesized terminal code is
 * built from, so even a rejection that said nothing machine-readable still names the
 * seam it came from.
 */
export function normalizeWireRejection(
  origin: string,
  rejection: unknown,
  fallback?: RejectionFallback,
): WireRefusal {
  try {
    const classified = classifyRejection(origin, rejection, fallback);
    if (classified !== undefined) {
      return classified;
    }
  } catch {
    // A value whose own property access throws carries no readable code, which is
    // exactly what the terminal arm below is for. Swallowed deliberately and not
    // reported: this IS the report path, and a tripwire raised from inside it would
    // be a second failure to render for the same one failure.
  }
  // Read guardedly even here: `Error.prototype.message` is an ordinary data property,
  // but a subclass is free to define an accessor over it, and this arm is reached
  // precisely when the value has already misbehaved once.
  const terminalMessage = readGuardedProperty(rejection, "message");
  return refuse(
    origin,
    `${origin}-call-failed`,
    // An `Error` gives up its message; anything else goes through the total
    // stringifier rather than `String(...)`, which runs ToPrimitive and so throws on
    // a null-prototype value carrying no `toString`.
    rejection instanceof Error && typeof terminalMessage === "string"
      ? terminalMessage
      : lossyStringify(rejection),
  );
}
