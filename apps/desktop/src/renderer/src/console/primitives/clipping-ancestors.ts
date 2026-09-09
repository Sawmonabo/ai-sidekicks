// The console's one clipping-ancestor walk.
//
// Two view families ask the same question — which ancestors of this element clip what
// is inside them — for different reasons: `workspace/deck/` intersects the answers
// into the rectangle a native view may occupy, and `browser/geometry/` collects their
// boxes so the sampler can subtract them. They sit beside each other in the console's
// DAG, so neither can read the other's copy, and each writing its own was the shape
// `apps/desktop/AGENTS.md §Shared code` warns about: two copies of one normalization
// drift, and the gate stays green. These had, three ways — the data structure (a
// module-level `Set` against a frozen tuple), the predicate (one read the `overflow`
// shorthand, the other did not), and the evidence (one was covered, the other was
// not). `primitives/` is the lowest family both consumers sit above and it already
// owns the DOM-touching seams; `core/` cannot take it, because that family is
// compiled by a Node-context program with no DOM lib and `Element` does not resolve
// there.
//
// THE LONGHANDS ARE THE AUTHORITY AND THE SHORTHAND IS A FALLBACK, which is the
// reconciliation neither copy made. `overflow` is a shorthand for `overflow-x` and
// `overflow-y` (CSS Overflow 3 §3), and CSSOM serializes a shorthand's resolved value
// FROM its longhands — so on a conformant engine the shorthand can carry nothing the
// axes do not already say, and when the axes differ it serializes as two
// space-separated keywords that no single-keyword membership test would match. Read
// as a third co-equal test, which is how the deck's copy read it, it is dead code on
// the engine that ships. It is not dead everywhere: `happy-dom`, the document the
// `console-unit` tier runs on, expands neither direction — an element with
// `style.overflow = "auto"` reports the empty string for both axes there, and an
// `overflow-x`-only element reports the empty string for the shorthand — so the
// browser copy, which read only the axes, was blind under that tier to exactly the
// ancestors the deck's suite builds. The axes are therefore read first and the
// shorthand is consulted only when neither axis is readable at all: a branch no
// conformant engine reaches, and the only reading a shim like that offers.

/**
 * The computed `overflow` values that clip a descendant.
 *
 * A closed positive set rather than a `!== "visible"` test: the negative form calls an
 * ancestor a clipper on any value it does not recognise, and a stylesheet-free document
 * reports the empty string for every box. Under that reading every pane is clipped to
 * nothing by an unlaid-out ancestor and hides itself, which looks exactly like a pane
 * that never attached.
 *
 * A TUPLE AND NOT A `Set`. `apps/desktop/AGENTS.md` rejects a module-level `Set`
 * singleton, and the rule is right about this one rather than merely applying to it:
 * five frozen literals need no collection to be read, a membership test over five
 * strings is not a lookup worth a hash table, and a container built at module load is
 * mutable for the life of the process while what it holds is a constant. The tuple is
 * the declaration, the union is derived from it, and a sixth value is added in exactly
 * one place.
 */
export const CLIPPING_OVERFLOW_VALUES = ["hidden", "clip", "scroll", "auto", "overlay"] as const;

/** One computed `overflow` value that clips. Derived from the tuple, never restated. */
export type ClippingOverflowValue = (typeof CLIPPING_OVERFLOW_VALUES)[number];

/**
 * Whether one computed `overflow` value clips its contents.
 *
 * A comparison over the tuple rather than `includes`, which would need a cast at the
 * call site to widen the parameter that a `===` comparison takes for free.
 */
export function clipsItsContents(overflowValue: string): boolean {
  return CLIPPING_OVERFLOW_VALUES.some((clippingValue) => clippingValue === overflowValue);
}

/**
 * Whether one computed style clips what is inside its box.
 *
 * The axes decide whenever either of them is readable, and the shorthand is consulted
 * only when neither is — the module header says why. The shorthand arm splits on
 * whitespace because that is the shorthand's own grammar (`overflow: <x> [<y>]`), so a
 * two-value declaration is read as the two axes it names rather than missed for not
 * being one keyword.
 *
 * `?? ""` on all three reads rather than trusting the declared type: a fake standing in
 * for a computed style supplies the members its case needs and nothing else, so an
 * absent axis arrives as `undefined` and `.trim()` on it would throw inside a walk
 * whose whole job is answering.
 */
function styleClipsItsContents(style: CSSStyleDeclaration): boolean {
  const horizontalAxis = style.overflowX ?? "";
  const verticalAxis = style.overflowY ?? "";
  if (horizontalAxis !== "" || verticalAxis !== "") {
    return clipsItsContents(horizontalAxis) || clipsItsContents(verticalAxis);
  }
  return (style.overflow ?? "")
    .trim()
    .split(/\s+/u)
    .some((axisValue) => clipsItsContents(axisValue));
}

/**
 * Every ancestor of `element` that clips what is inside it, innermost first.
 *
 * A GENERATOR, and the laziness is the point rather than a flourish. One caller
 * intersects the boxes as it goes and stops the moment the running clip is empty, so a
 * pane already scrolled out of the frame pays for the ancestors it reached and not for
 * the ones above them; an array would take one `getComputedStyle` per ancestor to the
 * document root on every pass, and a pass is armed on capture-phase document scroll.
 * The other caller takes the whole run and reverses it, which costs a generator
 * nothing.
 *
 * One `getComputedStyle` per ancestor per pass, and the walk stops at the document: the
 * cost is the read, and the read is the thing that makes the answer true.
 *
 * `?? null` on the parent reads rather than a bare `!== null` test: an element standing
 * in for a host in a test carries no `parentElement` at all, and walking into
 * `undefined` would read a style off nothing.
 */
export function* clippingAncestorsOf(element: Element): Generator<HTMLElement> {
  if (typeof window === "undefined") {
    return;
  }
  let ancestor: HTMLElement | null = element.parentElement ?? null;
  while (ancestor !== null) {
    if (styleClipsItsContents(window.getComputedStyle(ancestor))) {
      yield ancestor;
    }
    ancestor = ancestor.parentElement ?? null;
  }
}
