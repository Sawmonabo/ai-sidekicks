// The one refusal value the console renders; `RefusalBanner`, `InlineRefusal` and `RefusalCard`
// read the same fields.
//
// `code` is a plain `string`, not a union of every producer's codes: `lib/` sits below every
// producer and must not import them. Each producer keeps its own closed union and widens into
// this shape at its boundary.

import { readGuardedProperty } from "./wire-errors.js";

/** A refusal as every renderer consumes it; `code` is never reworded on its way to the screen. */
export interface Refusal {
  /** Machine-readable, rendered verbatim. */
  readonly code: string;
  /** One actionable sentence. Never the refused value, which may be user content. */
  readonly detail: string;
  /** The subsystem that refused — `"persistence"`, `"sessions"`, `"keybindings"`. */
  readonly origin: string;
}

/**
 * A refusal whose `code` is one member of a producer's closed union. An interface that narrows
 * `code`, not an intersection, which would leave it `string & Code` in every hover and error.
 */
export interface NarrowedRefusal<Code extends string> extends Refusal {
  readonly code: Code;
}

/**
 * An error carrying a refusal, for seams where it must travel as an exception (a constructor, a
 * throw inside a library callback). Returning a refusal is the default.
 */
export class RefusalError extends Error {
  public readonly refusal: Refusal;

  public constructor(refusal: Refusal, options?: { readonly cause?: unknown }) {
    super(`${refusal.origin}: ${refusal.code}: ${refusal.detail}`, options);
    this.name = "RefusalError";
    this.refusal = refusal;
  }
}

/**
 * Builds a refusal. Generic in `Code`, so a producer passing a member of its closed union gets
 * that union back on `code`; a plain `string` yields a plain `Refusal`. A forgotten `origin`
 * fails to compile.
 */
export function refuse<Code extends string>(
  origin: string,
  code: Code,
  detail: string,
): NarrowedRefusal<Code> {
  return { code, detail, origin };
}

/**
 * The member paths a parse refused on, for a refusal's sentence. Paths only, never the refused
 * value: a stream payload may be user content.
 */
export function refusedMemberPaths(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): readonly string[] {
  return issues.map((issue) =>
    issue.path.length === 0 ? "the payload" : issue.path.map(String).join("."),
  );
}

/**
 * True when a value is a refusal. Total: callers are on a failure path holding whatever was
 * thrown, so each read goes through `readGuardedProperty` and a throwing getter or Proxy trap
 * counts as absent instead of escaping the guard.
 */
export function isRefusal(value: unknown): value is Refusal {
  return (
    typeof readGuardedProperty(value, "code") === "string" &&
    typeof readGuardedProperty(value, "detail") === "string" &&
    typeof readGuardedProperty(value, "origin") === "string"
  );
}
