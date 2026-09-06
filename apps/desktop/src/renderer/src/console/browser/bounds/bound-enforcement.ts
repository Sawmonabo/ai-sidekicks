// Where a bound is actually SPENT, as opposed to where it is declared.
//
// `Spec-023 §Console Design (Meridian)` 12.10 closes on one sentence — "every bound
// is a named constant in one module, and every refusal names the constant it hit" —
// and the second half of it has to be built somewhere. `browser-bounds.ts` beside
// this module is the first half: twenty named constants and their derivations, which
// `BudgetMeter.tsx` renders. This module is the second: the three admissions the
// renderer is in a position to make, each answering with a refusal that names its
// constant and, where the design says so, the current count.
//
// THREE AND NOT TWENTY, AND THE LINE IS WHERE THE ARITHMETIC IS. A bound the renderer
// can measure is a bound the renderer can enforce; the rest are the daemon browser
// service's, because the renderer cannot count pages on a node, cannot observe a
// view's resident bytes, and cannot time a page operation. Those stay declared, they
// stay rendered on the meter, and no half-check here pretends otherwise — a renderer
// that guessed at a node-wide count would be deriving eligibility the daemon owns.
//
//   • **The session page cap.** The strip knows how many pages it is drawing, so the
//     create control can answer before it dispatches. 12.10's refusal state names
//     this case exactly: "a per-run or per-session page cap answers with the cap's
//     name and the current count".
//   • **The full-page capture extent.** A capture asking for a box is a box this
//     renderer composed, so the pair is checkable here against the one bound that is
//     measured in pixels.
//   • **The byte ceilings.** One admission over the five scalar bounds that are
//     measured in bytes — and deliberately NOT over the sixth byte-shaped row.
//     `CAPTURE_AND_DOWNLOAD_BYTES` is `deferred`: the ingest pipeline owns it, and
//     admitting a length against it here would be the second ceiling 12.10's own
//     "the console never mints a second byte ceiling" forbids. The tuple below is
//     what makes that a compile error rather than a review note.
//
// EVERY ANSWER IS A `ConsoleRefusal` OR NOTHING. Not a boolean, and not a thrown
// error: the caller's next move is to render what it got back, and a boolean would
// make every call site compose the sentence again — which is how one bound acquires
// four spellings of the number it protects.

import { refuse, type ConsoleRefusal } from "../../core/index.js";
import { formatByteQuantity, formatCount } from "../../primitives/index.js";
import { BROWSER_BOUNDS, type BrowserBoundName } from "./browser-bounds.js";

/** The subsystem every refusal raised here names as its author. */
export const BROWSER_BOUND_REFUSAL_ORIGIN = "browser-bounds";

/**
 * The refusal code every bound trip carries.
 *
 * ONE CODE FOR ALL OF THEM, because the code answers "what kind of thing happened"
 * and the answer is the same for every row: a named ceiling was reached. Which
 * ceiling is the sentence's own first words, so a person reads the constant rather
 * than decoding a per-bound code, and a surface rendering the refusal does not have
 * to enumerate twenty codes to know it is looking at a bound.
 */
export const BROWSER_BOUND_REFUSAL_CODE = "bound-reached";

/**
 * The bounds a byte admission may name, hand-stated and then checked twice.
 *
 * NOT DERIVED FROM THE TABLE, and that is a deliberate cost: `BROWSER_BOUNDS` is
 * annotated as a total record of one widened value type, so a mapped conditional over
 * it narrows nothing and would hand back every name in the block — including the
 * deferred row this set exists to exclude. So the names are written out, and then two
 * different mechanisms check them. `Extract` is the compile-time half: a name that is
 * not a bound is dropped from the union rather than admitted, which makes the literal
 * below unassignable, so a typo is a build failure and not a silently narrower set.
 * The co-located test is the runtime half: it asserts every member is a scalar bound
 * whose unit is a byte unit, and that no byte bound in the block is missing from here.
 */
export type BrowserByteBoundName = Extract<
  BrowserBoundName,
  | "SNAPSHOT_TEXT_MAX"
  | "EVALUATE_RESULT_MAX"
  | "LOCATOR_RESULT_MAX"
  | "CONSOLE_ENTRY_MAX"
  | "CLIPBOARD_MAX"
>;

/** The byte-measured bounds. `CAPTURE_AND_DOWNLOAD_BYTES` is deliberately not one. */
export const BROWSER_BYTE_BOUND_NAMES: readonly BrowserByteBoundName[] = [
  "SNAPSHOT_TEXT_MAX",
  "EVALUATE_RESULT_MAX",
  "LOCATOR_RESULT_MAX",
  "CONSOLE_ENTRY_MAX",
  "CLIPBOARD_MAX",
];

/** The scalar value of a bound the caller has already established is scalar. */
function scalarValueOf(name: BrowserBoundName): number {
  const measure = BROWSER_BOUNDS[name].measure;
  // The tuple above is checked against this by the co-located test, so the fallback
  // is unreachable rather than a silent widening — and `0` is the fail-closed value:
  // a bound that lost its number refuses everything rather than admitting everything.
  return measure.kind === "scalar" ? measure.value : 0;
}

/**
 * Admit one more page, or refuse naming the cap and the current count.
 *
 * `currentCount` is the count the caller is drawing, not one this module keeps: a
 * second copy of the page count would be a second source of truth for a list the
 * subscription owns, and it would be wrong for exactly as long as a frame was in
 * flight.
 */
export function admitAnotherPage(currentCount: number): ConsoleRefusal | undefined {
  const cap = scalarValueOf("PAGES_PER_SESSION_MAX");
  if (currentCount < cap) {
    return undefined;
  }
  return refuse(
    BROWSER_BOUND_REFUSAL_ORIGIN,
    BROWSER_BOUND_REFUSAL_CODE,
    `PAGES_PER_SESSION_MAX is ${formatCount(cap)} pages and this session already owns ${formatCount(currentCount)}. Close a page before opening another.`,
  );
}

/**
 * Admit a full-page capture's box, or refuse naming the extent it exceeded.
 *
 * Both dimensions are checked and the sentence names both ceilings, because a capture
 * refused for its height while its width is also over would be refused twice — once
 * per correction — which reads as the ceiling moving.
 */
export function admitFullPageCapture(
  widthPx: number,
  heightPx: number,
): ConsoleRefusal | undefined {
  const measure = BROWSER_BOUNDS.FULL_PAGE_CAPTURE_MAX.measure;
  if (measure.kind !== "extent") {
    // Unreachable while the block declares this bound as an extent, and it refuses
    // rather than admits for `scalarValueOf`'s reason: a bound that lost its shape
    // refuses everything, never admits everything.
    return refuse(
      BROWSER_BOUND_REFUSAL_ORIGIN,
      BROWSER_BOUND_REFUSAL_CODE,
      "FULL_PAGE_CAPTURE_MAX no longer declares an extent, so no capture box can be checked against it. Capture the viewport instead.",
    );
  }
  if (widthPx <= measure.widthPx && heightPx <= measure.heightPx) {
    return undefined;
  }
  return refuse(
    BROWSER_BOUND_REFUSAL_ORIGIN,
    BROWSER_BOUND_REFUSAL_CODE,
    `FULL_PAGE_CAPTURE_MAX is ${formatCount(measure.widthPx)} by ${formatCount(measure.heightPx)} pixels and this capture asks for ${formatCount(widthPx)} by ${formatCount(heightPx)}. Capture the viewport, or a clip of it, instead.`,
  );
}

/**
 * Admit a length against one byte ceiling, or refuse naming the constant.
 *
 * The figure goes through the console's single byte-scaling site, which is what makes
 * the sentence agree with every other byte quantity on screen — a raw decimal here
 * would read as a different kind of number from the same value on the meter two
 * inches away.
 */
export function admitByteLength(
  bound: BrowserByteBoundName,
  byteLength: number,
): ConsoleRefusal | undefined {
  const ceiling = scalarValueOf(bound);
  if (byteLength <= ceiling) {
    return undefined;
  }
  return refuse(
    BROWSER_BOUND_REFUSAL_ORIGIN,
    BROWSER_BOUND_REFUSAL_CODE,
    `${bound} is ${formatByteQuantity(ceiling).text} and this value is ${formatByteQuantity(byteLength).text}. It is refused rather than trimmed to fit.`,
  );
}
