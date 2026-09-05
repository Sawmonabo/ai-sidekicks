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
// genuinely IS cross-process — the total property reader and the total stringifier
// — already lives there, and this module consumes both rather than restating either.
//
// EACH MEMBER IS READ ONCE, and the arms classify the snapshot. The first arm and
// the flat-envelope arm both want `code`; the JSON-RPC arm and the flat-envelope arm
// both want `message`. Read at each arm, a member whose getter answers once — or
// answers differently the second time — is classified across two readings and falls
// to the backstop with an invented code, which is the one outcome every arm exists
// to prevent. So the members are read up front, into plain locals, and no arm
// touches the candidate again.
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
  isErrorInstance,
  lossyStringify,
  readGuardedProperty,
} from "../../../../shared/wire-errors.js";

import { parseInstant } from "./instant.js";
import { refuse, type ConsoleRefusal } from "./refusal.js";

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

/**
 * Assemble a hint from two candidate numbers, or answer none.
 *
 * The one assembler both readers below share. They differ in WHERE the two numbers
 * are read from — the wire's spelling versus the console's own — and agree on what
 * counts as a bound, which is the half that would drift if it were written twice.
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

/** The two positions a retry bound is registered at on the WIRE, read guardedly. */
function retryHintFrom(source: unknown): WireRetryHint | undefined {
  const resetAt = readGuardedProperty(source, "resetAt");
  const reset = typeof resetAt === "string" ? parseInstant(resetAt) : undefined;
  return retryHintOf(
    readGuardedProperty(source, "retryAfter"),
    reset?.kind === "instant" ? reset.epochMilliseconds : undefined,
  );
}

/** A hint a refusal already carries, in this console's own spelling, read guardedly. */
function carriedRetryHint(candidate: unknown): WireRetryHint | undefined {
  const carried = readGuardedProperty(candidate, "retry");
  return retryHintOf(
    readGuardedProperty(carried, "afterSeconds"),
    readGuardedProperty(carried, "atEpochMilliseconds"),
  );
}

/** The members a refusal-shaped candidate is classified on, each read exactly once. */
interface RefusalMembers {
  readonly code: unknown;
  readonly detail: unknown;
  readonly origin: unknown;
  readonly retry: WireRetryHint | undefined;
}

/** One read per member. The only place a candidate's refusal members are touched. */
function readRefusalMembers(candidate: unknown): RefusalMembers {
  return {
    code: readGuardedProperty(candidate, "code"),
    detail: readGuardedProperty(candidate, "detail"),
    origin: readGuardedProperty(candidate, "origin"),
    retry: carriedRetryHint(candidate),
  };
}

/**
 * Rebuild a refusal from the members already read off a candidate.
 *
 * REBUILT, never handed back by reference, and that is the whole of it. Recognizing a
 * refusal structurally means three properties were read once and they were strings;
 * it does NOT mean the next reader gets the same answer. A getter that throws on its
 * second read, a Proxy trap that throws after the first call — either one turns a
 * returned candidate into a rejection deferred into the renderer, where
 * `refusal.code` throws while painting the sentence that says something failed. A
 * normalizer whose job is to produce a renderable shape must produce one, so what
 * comes back is a plain object carrying bounded strings and nothing of the candidate.
 */
function rebuiltRefusal(members: RefusalMembers): WireRefusal | undefined {
  const { code, detail, origin } = members;
  if (typeof code !== "string" || typeof detail !== "string" || typeof origin !== "string") {
    return undefined;
  }
  return withRetryHint(refuse(origin, code, detail), members.retry);
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
 *   1. A value that already IS a `ConsoleRefusal` keeps its own author, its own code
 *      and any retry hint it carries — rebuilt onto a fresh object rather than passed
 *      through by reference, for the reason {@link rebuiltRefusal} states.
 *   2. A value CARRYING a refusal (`ConsoleRefusalError`, the fixture bridge's error,
 *      and any other error built around one) is unwrapped, and rebuilt the same way.
 *      The check is STRUCTURAL rather than `instanceof ConsoleRefusalError`, and that
 *      is strictly stronger: `instanceof` walks a prototype chain, which a value that
 *      crossed a realm or a structured clone no longer has, and the failure mode
 *      there is silent — the refusal falls to the terminal arm and its author's code
 *      is replaced by one this function invented.
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
  const members = readRefusalMembers(rejection);
  const own = rebuiltRefusal(members);
  if (own !== undefined) {
    return own;
  }
  const carried = rebuiltRefusal(readRefusalMembers(readGuardedProperty(rejection, "refusal")));
  if (carried !== undefined) {
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
  // The flat envelope — `{ code, message }` — from the same two readings the arms
  // above already took, never a second pass over the candidate.
  if (typeof members.code === "string" && typeof message === "string") {
    return withRetryHint(refuse(origin, members.code, message), retryHintFrom(rejection));
  }
  if (fallback !== undefined) {
    return refuse(origin, fallback.code, fallback.detail);
  }
  return undefined;
}

/**
 * Normalize any rejection into the console's one refusal shape.
 *
 * TOTAL. It answers a refusal for every input and throws for none.
 *
 * Every step of `classifyRejection` is itself total today — every read goes through
 * `readGuardedProperty`, and the ONE
 * prototype question this module asks goes through `isErrorInstance`, because
 * `instanceof` throws on a revoked Proxy and the terminal arm below sits outside the
 * backstop. The hostile-value cases in this module's test prove that by passing with
 * the `try` removed. The `try` is kept as a BACKSTOP rather than as the mechanism,
 * and the distinction is the reason: without it, totality here would be a property of
 * two other functions staying total, and the edit that broke one of them would show
 * up as a throw on the failure path — in a `catch` that has already been left, in the
 * one function a surface calls to say that something failed. It costs nothing on a
 * path that only runs when a call already failed, and it is the one arm nobody has to
 * re-prove.
 *
 * NOTHING OF THE REJECTION SURVIVES ONTO THE ANSWER. Every arm rebuilds, so what a
 * renderer receives is a plain object of strings this function already read — never
 * the candidate itself, whose next property access is the throw this whole module
 * exists to prevent, arriving one layer later and outside every `catch`.
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
    isErrorInstance(rejection) && typeof terminalMessage === "string"
      ? terminalMessage
      : lossyStringify(rejection),
  );
}
