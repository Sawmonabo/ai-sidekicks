// One rejection normalizer for the whole app. A rejected bridge promise can be anything (an
// `Error`, a wire envelope as a plain object, an SDK error carrying a code, a `Refusal`, a string,
// `undefined`, a null-prototype object), and every caller answers it through this module.
//
// Each member is read once, up front, into plain locals: an arm that re-read a getter could
// classify across two readings and fall to the backstop with an invented code.
//
// A `detail` is a sentence someone wrote, never a serialization of the rejection, which may hold
// request values, paths or tokens. Every arm renders a producer-written string (a wire `message`,
// a refusal's `detail`, an `Error` message, a thrown string), the caller's fallback sentence, or
// `UNREPRESENTABLE_VALUE_TEXT`; a structure is never stringified.
//
// The JSON-RPC arm comes first among the wire arms. `JsonRpcRemoteError`
// (`packages/client-sdk/src/transport/json-rpc-client.ts`) carries a numeric JSON-RPC `code`,
// while the project's dotted code rides at `data.type`, which the contracts say callers must
// discriminate on. A top-level string `code` is the already-flattened form.

import {
  isErrorInstance,
  isPropertyContainer,
  lossyStringify,
  readGuardedProperty,
  UNREPRESENTABLE_VALUE_TEXT,
} from "./wire-errors.js";

import {
  readRefusalExtensions,
  wireRetryExtension,
  withRefusalExtensions,
  type RefusalExtensions,
  type ExtendedRefusal,
} from "./refusal-extensions.js";
import { refuse } from "./refusal.js";

/**
 * A caller-written refusal for a rejection that carries no code of its own, for seams that know
 * their failure better than the thrown value. Its `code` replaces only the synthesized
 * `<origin>-call-failed` pair and never a code the other side sent; its `detail` also fills in for
 * a wire arm that found a code but no readable sentence.
 */
export interface RejectionFallback {
  readonly code: string;
  readonly detail: string;
}

/**
 * A rejection as the one shape the app renders: a `Refusal` widened only by the registered
 * extension members (`refusal-extensions.ts`), so any renderer that takes a refusal takes it.
 */
export type WireRefusal = ExtendedRefusal;

/**
 * Normalizes any rejection into the app's one refusal shape. Total: it answers a refusal for
 * every input and never throws. `origin` is the calling subsystem and builds the synthesized
 * `<origin>-call-failed` code, so even an unreadable rejection names its seam.
 *
 * Nothing of the rejection survives onto the answer: every arm rebuilds a plain object of strings
 * already read, so a renderer never touches the candidate.
 */
export function normalizeWireRejection(
  origin: string,
  rejection: unknown,
  fallback?: RejectionFallback,
): WireRefusal {
  const classified = classifyRejection(origin, rejection, fallback);
  if (classified !== undefined) {
    return classified;
  }
  // Read guardedly: a subclass may define an accessor over `message`, and this arm is reached
  // when the value has already misbehaved.
  const terminalMessage = readGuardedProperty(rejection, "message");
  return refuse(origin, `${origin}-call-failed`, terminalDetail(rejection, terminalMessage));
}

/**
 * The sentence a code-bearing wire arm renders. A missing or non-string `message` is a malformed
 * producer, answered with the caller's sentence or a constant, never `data.fields`, which holds
 * request values. The code survives regardless, since it is what a person acts on.
 */
function envelopeDetail(message: unknown, fallback: RejectionFallback | undefined): string {
  if (typeof message === "string") {
    return message;
  }
  return fallback?.detail ?? UNREPRESENTABLE_VALUE_TEXT;
}

/**
 * The sentence the terminal arm renders for a rejection with no code. An `Error` gives its
 * `message` and a thrown string is its own message; other primitives go through the total
 * stringifier; an object, array or function is refused, since its `toString` may disclose.
 */
function terminalDetail(rejection: unknown, message: unknown): string {
  if (isErrorInstance(rejection) && typeof message === "string") {
    return message;
  }
  return isPropertyContainer(rejection) ? UNREPRESENTABLE_VALUE_TEXT : lossyStringify(rejection);
}

/** The members a refusal-shaped candidate is classified on, each read exactly once. */
interface RefusalMembers {
  readonly code: unknown;
  readonly detail: unknown;
  readonly origin: unknown;
  readonly extensions: RefusalExtensions;
}

/** Reads each refusal member once; the only place a candidate's members are touched. */
function readRefusalMembers(candidate: unknown): RefusalMembers {
  return {
    code: readGuardedProperty(candidate, "code"),
    detail: readGuardedProperty(candidate, "detail"),
    origin: readGuardedProperty(candidate, "origin"),
    extensions: readRefusalExtensions(candidate),
  };
}

/**
 * Rebuilds a refusal from members already read, never returning the candidate by reference: a
 * getter or Proxy trap that throws on its second read would otherwise throw inside the renderer.
 */
function rebuiltRefusal(members: RefusalMembers): WireRefusal | undefined {
  const { code, detail, origin } = members;
  if (typeof code !== "string" || typeof detail !== "string" || typeof origin !== "string") {
    return undefined;
  }
  return withRefusalExtensions(refuse(origin, code, detail), members.extensions);
}

/**
 * The typed arms, most specific first, since each carries a code the later ones would discard.
 * Total: every member is read through the guarded readers, so a throwing access reads as absent.
 *
 *   1. A value that already is a `Refusal` keeps its author, code and extensions.
 *   2. A value carrying a refusal (`RefusalError` or any error built around one) is unwrapped.
 *      The check is structural, not `instanceof`, which fails silently on a value that crossed
 *      a realm or a structured clone.
 *   3. The JSON-RPC `data` envelope: the dotted code at `data.type`, extensions from
 *      `data.fields`.
 *   4. A flat `{ code, message }` wire envelope keeps its code verbatim.
 *
 * Both wire arms are admitted by their code alone; the sentence is whatever
 * {@link envelopeDetail} allows.
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
    // The retry bound rides on `data.fields` in this envelope.
    return withRefusalExtensions(
      refuse(origin, dottedCode, envelopeDetail(message, fallback)),
      wireRetryExtension(readGuardedProperty(data, "fields")),
    );
  }
  // The flat envelope, from the readings already taken. It carries its retry bound at the root.
  if (typeof members.code === "string") {
    return withRefusalExtensions(
      refuse(origin, members.code, envelopeDetail(message, fallback)),
      wireRetryExtension(rejection),
    );
  }
  if (fallback !== undefined) {
    return refuse(origin, fallback.code, fallback.detail);
  }
  return undefined;
}
