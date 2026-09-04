// One refusal shape for the whole console.
//
// `Spec-023 §Console Design (Meridian)` rule 9 gives refusals three RENDERINGS —
// inline on the control, a card in the surface, a banner across the workspace —
// and `RefusalBanner` / `InlineRefusal` / `RefusalCard` all consume the same two
// fields. What the console lacked was one refusal VALUE for them to consume: the
// growth port, the fixture bridge, the when-clause parser, the key-binding table,
// and the palette each minted their own vocabulary, so a surface that wanted to
// render two of them had to translate between five shapes to reach three renderers.
//
// Three fields, and each earns its place:
//
//   • `code` — the machine-readable reason, rendered verbatim in mono. Never
//     prose, never localized, never reworded between the producer and the screen:
//     it is what a person pastes into a search or an issue.
//   • `detail` — one sentence a person can act on. Says what was refused and what
//     would change the answer. Never the refused value itself, which may be
//     participant content.
//   • `origin` — which subsystem refused, so a refusal that surfaces three layers
//     from where it was raised still names its author.
//
// `code` is deliberately a `string` rather than a union of every producer's codes.
// A closed union here would make this module import each producer, inverting the
// DAG: `core/` is the bottom family and knows none of them. Each producer keeps
// its own closed code union and widens into this shape at its boundary.

import { isWireErrorEnvelope, lossyStringify } from "../../../../shared/wire-errors.js";

/**
 * A caller-written refusal for a rejection that carries no code of its own.
 *
 * Some seams know their failure better than the thrown value does: "the call into
 * the browser never answered" names what a person can do next, where the preload's
 * own message names a transport. Supplied to {@link refusalFromRejection} it
 * replaces the synthesized `<origin>-call-failed` pair — and only that pair.
 */
export interface RejectionFallback {
  readonly code: string;
  readonly detail: string;
}

export interface ConsoleRefusal {
  /** Machine-readable, rendered verbatim. */
  readonly code: string;
  /** One actionable sentence. Never the refused value. */
  readonly detail: string;
  /** The subsystem that refused — `"persistence"`, `"growth-port"`, `"keybindings"`. */
  readonly origin: string;
}

/**
 * Build a refusal.
 *
 * A function rather than an object literal at each site so the field order and the
 * `origin` vocabulary stay uniform, and so a producer that forgets `origin` fails
 * to compile rather than shipping a refusal that names nobody.
 */
export function refuse(origin: string, code: string, detail: string): ConsoleRefusal {
  return { code, detail, origin };
}

/**
 * An error carrying a refusal.
 *
 * For the seams where a refusal has to travel as an exception — a constructor, a
 * `throw` inside a library callback — rather than as a return value. Returning a
 * refusal is the default and this is the exception: an error costs a stack unwind
 * and forces every caller into a `try`.
 */
export class ConsoleRefusalError extends Error {
  public readonly refusal: ConsoleRefusal;

  public constructor(refusal: ConsoleRefusal, options?: { readonly cause?: unknown }) {
    super(`${refusal.origin}: ${refusal.code}: ${refusal.detail}`, options);
    this.name = "ConsoleRefusalError";
    this.refusal = refusal;
  }
}

/** True when a value is a refusal, for a seam that returns a result or a refusal. */
export function isConsoleRefusal(value: unknown): value is ConsoleRefusal {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    readonly code?: unknown;
    readonly detail?: unknown;
    readonly origin?: unknown;
  };
  return (
    typeof candidate.code === "string" &&
    typeof candidate.detail === "string" &&
    typeof candidate.origin === "string"
  );
}

/**
 * A REJECTED promise, as the one refusal shape the console renders.
 *
 * Four arms, in this order, because each earlier one carries a code the later ones
 * would throw away:
 *
 *   1. A `ConsoleRefusal` that travelled as a rejection is already this shape and
 *      already names its own author, so it passes through untouched.
 *   2. A {@link ConsoleRefusalError} is unwrapped to the refusal it carries. Left
 *      to arm 4 it would render `<origin>-call-failed` over an `Error` whose
 *      message happens to read `origin: code: detail` — the code a person pastes
 *      into an issue replaced by one this function invented.
 *   3. A wire envelope — `{ code, message }`, whether it arrived as a plain object
 *      across the preload boundary or as an `Error` subclass carrying the code —
 *      keeps its code VERBATIM, which is the whole point: `permission_denied` and
 *      a lease conflict are different next moves, and both are unactionable once
 *      flattened into one call-failed code. The guard is
 *      `src/shared/wire-errors.ts`'s rather than a second structural check or a
 *      schema parse: that module owns this shape for every renderer surface, and
 *      it records why the recognition is structural — the same envelope arrives
 *      as an object and as an `Error`, and a schema bound to one set of codes
 *      would narrow it below what its callers need.
 *   4. Anything else is this caller's own refusal. When the caller wrote a
 *      {@link RejectionFallback} it is used verbatim — a sentence that names the
 *      person's next move beats a thrown value's message. Otherwise an `Error`
 *      gives up its message; anything else goes through the total stringifier
 *      rather than through `String(...)`, which itself throws on a null-prototype
 *      object — the value a surface exists to SURFACE must not take the surface
 *      down.
 *
 * `origin` is the caller's subsystem name and is what arm 4's synthesized code is
 * built from, so a call-failed refusal still says which seam failed. The fallback
 * never displaces arms 1–3: a code the other side sent is more actionable than any
 * prose written here, which is the whole reason this function exists.
 */
export function refusalFromRejection(
  origin: string,
  error: unknown,
  fallback?: RejectionFallback,
): ConsoleRefusal {
  if (isConsoleRefusal(error)) {
    return error;
  }
  if (error instanceof ConsoleRefusalError) {
    return error.refusal;
  }
  if (isWireErrorEnvelope(error)) {
    return refuse(origin, error.code, error.message);
  }
  if (fallback !== undefined) {
    return refuse(origin, fallback.code, fallback.detail);
  }
  return refuse(
    origin,
    `${origin}-call-failed`,
    error instanceof Error ? error.message : lossyStringify(error),
  );
}
