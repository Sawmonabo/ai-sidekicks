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
