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
// A DETAIL IS A SENTENCE SOMEBODY WROTE, NEVER A SERIALIZATION OF THE REJECTION.
// `core/refusal.ts` states the rule this module has to keep — `detail` is "never the
// refused value itself, which may be participant content" — and a rejection off the
// bridge is `unknown`, so its members are request values, repository paths, headers,
// or a token as easily as they are prose. Every arm here therefore renders one of
// exactly three things: a string the producing side wrote AS a sentence (a wire
// `message`, a refusal's own `detail`, an `Error`'s `message`, a thrown string), the
// CALLER's fallback sentence, or {@link UNREPRESENTABLE_VALUE_TEXT}. A structure is
// never stringified into it — not on the arm that has a code and no sentence, and not
// on the terminal arm, where `String({ … })` is at best `[object Object]` and at worst
// whatever a producer's own `toString` decided to disclose.
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
  isPropertyContainer,
  lossyStringify,
  readGuardedProperty,
  UNREPRESENTABLE_VALUE_TEXT,
} from "../../../../shared/wire-errors.js";

// The envelope shape itself, re-published rather than re-declared. `src/shared/` sits
// on no rung of the console's family DAG, so a view family reaching it directly is the
// edge `console-view-family-shared-through-core` reports; this module is already the
// console's reading of that envelope, so it is the layer family that owns the shape
// for everything above it. Re-export and not a second interface: two declarations of
// one wire shape is exactly the drift the rule exists to stop.
//
// AND IT IS ON `core/index.ts`. It is held off no longer for want of a production
// reader: `bridge/scenario-runtime/scenario.ts` and `scripted-reply.ts` both read the
// shape, so the door line has the readers `barrel-census` asks for, and the reading
// layer beside them takes the same one name from the same door.
//
// THE CLAIM IS ABOUT THE SHAPE, NOT ABOUT THE MODULE THAT DECLARES IT. That leaf also
// declares the envelope's READERS, and a door line for a function reached only by
// tests would be the census failure this note exists to avoid. A reader is not a
// second declaration of the shape, so that edge drifts nothing — the rule governs
// where the console's one reading of the envelope lives, and it lives here.
export type { WireErrorEnvelope } from "../../../../shared/wire-errors.js";

import {
  readRefusalExtensions,
  wireFailedBindingsExtension,
  wireRetryExtension,
  withRefusalExtensions,
  type ConsoleRefusalExtensions,
  type ExtendedConsoleRefusal,
} from "./refusal-extensions.js";
import { refuse } from "./refusal.js";

/**
 * A caller-written refusal for a rejection that carries no code of its own.
 *
 * Some seams know their failure better than the thrown value does: "the call into
 * the browser never answered" names what a person can do next, where the transport's
 * own message names a socket.
 *
 * ITS `code` REPLACES THE SYNTHESIZED `<origin>-call-failed` PAIR AND ONLY THAT
 * PAIR — it never displaces a code the other side sent, which is the whole reason
 * the typed arms run first. Its `detail` reaches one place more: a wire arm that
 * found a code and no readable sentence. That is not a displacement either, because
 * there was no sentence to displace, and the alternative on that arm is a fixed
 * constant naming nothing.
 */
export interface RejectionFallback {
  readonly code: string;
  readonly detail: string;
}

/**
 * A rejection, as the one shape the console renders.
 *
 * A `ConsoleRefusal` widened by the REGISTERED extension members and by nothing else
 * (`core/refusal-extensions.ts`), so every renderer that already takes a refusal takes
 * this unchanged and only a surface that reads one of those members has to know it
 * exists. `isConsoleRefusal` is structural, so this satisfies it.
 *
 * Named here rather than declared here, because what it is IS the extended refusal:
 * a second interface saying so would be the mirrored union the package forbids.
 */
export type WireRefusal = ExtendedConsoleRefusal;

/**
 * The sentence a CODE-BEARING arm renders, which is never the rejection itself.
 *
 * Both wire arms reach it, and that is the point: they differ in where the code was
 * found and agree on what may stand in for a sentence, which is the half that drifts
 * when it is written twice. A wire envelope whose `message` is missing or is not a
 * string is a malformed producer, and the console's answer to that is the caller's
 * own sentence or a constant — never `data.fields`, which
 * `error-contracts.md §Rate Limiting` puts request values in by design.
 *
 * The CODE survives regardless, because it is the half a person acts on:
 * `session.not_found` and a lease conflict are different next moves, and folding
 * either into `<origin>-call-failed` because the sentence beside it was unreadable
 * would throw away the one part that was.
 */
function envelopeDetail(message: unknown, fallback: RejectionFallback | undefined): string {
  if (typeof message === "string") {
    return message;
  }
  return fallback?.detail ?? UNREPRESENTABLE_VALUE_TEXT;
}

/**
 * The sentence the terminal arm renders, for a rejection carrying no code at all.
 *
 * THREE OUTCOMES AND A STRUCTURE IS NONE OF THEM. An `Error` gives up its `message`
 * and a thrown string IS its own message — both are prose a producer wrote, which is
 * what a detail is. Every other primitive goes through the total stringifier, which
 * for a number, a symbol, a boolean, `null` or `undefined` is a bounded rendering of
 * the value and carries no members. An object, an array or a function is refused:
 * its serialization is `[object Object]` at best and, where a producer defined its
 * own `toString`, exactly the disclosure this module's header forbids.
 *
 * `isPropertyContainer` rather than a `typeof` pair written again here — it is the
 * same question `readGuardedProperty` asks, and two copies of it drift.
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
  readonly extensions: ConsoleRefusalExtensions;
}

/** One read per member. The only place a candidate's refusal members are touched. */
function readRefusalMembers(candidate: unknown): RefusalMembers {
  return {
    code: readGuardedProperty(candidate, "code"),
    detail: readGuardedProperty(candidate, "detail"),
    origin: readGuardedProperty(candidate, "origin"),
    extensions: readRefusalExtensions(candidate),
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
  return withRefusalExtensions(refuse(origin, code, detail), members.extensions);
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
 *
 * BOTH WIRE ARMS ARE ADMITTED BY THEIR CODE ALONE, and the sentence beside it is
 * whatever {@link envelopeDetail} allows. An envelope carrying a code and an
 * unreadable message is a malformed producer, and answering it with the synthesized
 * terminal pair would throw away the one machine-readable thing it did send.
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
    const fields = readGuardedProperty(data, "fields");
    return withRefusalExtensions(refuse(origin, dottedCode, envelopeDetail(message, fallback)), {
      // Both `data.fields` readers, merged rather than chosen between: an envelope
      // may carry a retry bound, a failed-binding list, both, or neither, and each
      // reader contributes only the member it actually found.
      ...wireRetryExtension(fields),
      ...wireFailedBindingsExtension(fields),
    });
  }
  // The flat envelope — `{ code, message }` — from the same two readings the arms
  // above already took, never a second pass over the candidate.
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
 * exists to prevent, arriving one layer later and outside every `catch`. And no arm
 * SERIALIZES it either: see this module's header on what a `detail` may be, which is
 * the second half of the same rule and the half a rebuild alone does not give.
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
  return refuse(origin, `${origin}-call-failed`, terminalDetail(rejection, terminalMessage));
}
