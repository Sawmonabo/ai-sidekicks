// A rewind target position is the WHOLE value a person typed, or it is not a
// position at all.
//
// `Number.parseInt("4oops", 10)` is `4`. A composer that parsed a rewind target that
// way would dispatch a destructive rollback to position 4 from a field whose visible
// contents were never a position, and the daemon — which admits `targetPosition` as
// an ordinary integer — would have no way to tell that request apart from one a
// person meant. The mistake is unrecoverable by the time it reaches the wire, so it
// is refused here, at the affordance, before the confirm.
//
// WHAT THE GRAMMAR IS, AND WHERE IT COMES FROM. `InterventionRequestPayload`'s
// rollback arm parses `targetPosition` through the same non-negative integer parser
// its `expectedRunVersion` uses (`packages/contracts/src/runControl.ts`): an
// integer, not negative, and inside the safe-integer range its `.int()` check
// enforces. This module reads exactly that and nothing more — whether the position
// names a recorded turn boundary of the target run is a daemon admission check
// against durable state, and §7.3's Never list forbids the console computing a cut
// of its own.
//
// THREE THINGS THE WHOLE-VALUE RULE CATCHES that a prefix parse does not: a typed
// suffix (`4oops`), a value in a notation the wire does not take (`1e3`, `4.0`,
// `0x10`), and a digit a locale renders but the parser does not (`٤` is `4` to
// `Number` and is not an ASCII digit). Each of them reads as a position on screen
// and is not one, which is the whole class.

/**
 * What one typed rewind target says.
 *
 * Three arms rather than `number | undefined`, because an EMPTY field and a field
 * holding something that is not a position are two different sentences to a person
 * looking at the composer: one has not named a position yet, the other named
 * something the run cannot have recorded.
 */
export type RewindPositionReading =
  | { readonly status: "named"; readonly position: number }
  | { readonly status: "unnamed" }
  | { readonly status: "unreadable" };

/** ASCII digits, anchored at both ends: the value is the position, or it is not one. */
const WHOLE_NON_NEGATIVE_INTEGER = /^\d+$/u;

/**
 * Read a typed rewind target.
 *
 * Trims first — surrounding whitespace is a typing artefact and not a claim about
 * the value — and then holds the remainder to the registered grammar in full. The
 * refused value is deliberately never carried out on the reading: a refusal renders
 * it, and it is participant input.
 */
export function parseRewindPosition(typed: string): RewindPositionReading {
  const trimmed = typed.trim();
  if (trimmed.length === 0) {
    return { status: "unnamed" };
  }
  if (!WHOLE_NON_NEGATIVE_INTEGER.test(trimmed)) {
    return { status: "unreadable" };
  }
  const position = Number(trimmed);
  // The upper bound is the registered one rather than a cap this console chose:
  // beyond the safe-integer range the contract's own `.int()` check refuses, and a
  // value that survived the digit grammar can still land there.
  if (!Number.isSafeInteger(position)) {
    return { status: "unreadable" };
  }
  return { status: "named", position };
}
