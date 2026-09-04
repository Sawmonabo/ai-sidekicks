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
//
// The one import is `src/shared/wire-errors.ts`, which is not a producer and not a
// family: it is the cross-process leaf, it imports nothing itself, and what is taken
// from it is the total property reader. See {@link isConsoleRefusal}.

import { readGuardedProperty } from "../../../../shared/wire-errors.js";

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

/**
 * True when a value is a refusal, for a seam that returns a result or a refusal.
 *
 * TOTAL, and that is the point rather than a nicety. Every caller is on a failure
 * path: the value being asked about is a caught rejection or an `unknown` result
 * that crossed a family boundary, so it is whatever a producer threw. A plain
 * `candidate.code` runs a getter, and a getter that throws — a hostile accessor, a
 * Proxy `get` trap, or merely a broken one — propagates out of the guard, out of the
 * `catch` that has already been left, and takes down the surface whose whole job was
 * to say that something failed. The reads therefore go through
 * `readGuardedProperty`, which collapses "absent" and "unreadable" to the same
 * `undefined`; here those mean the same thing, because a refusal whose `code` cannot
 * be read is not one this console can render.
 *
 * The `typeof value !== "object"` pre-check is gone rather than kept beside the
 * guarded reads: the reader already answers `undefined` for every primitive, and a
 * null-prototype FUNCTION carrying the three members is a refusal that the old
 * pre-check rejected outright.
 */
export function isConsoleRefusal(value: unknown): value is ConsoleRefusal {
  return (
    typeof readGuardedProperty(value, "code") === "string" &&
    typeof readGuardedProperty(value, "detail") === "string" &&
    typeof readGuardedProperty(value, "origin") === "string"
  );
}
