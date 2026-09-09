// Which mark a keypress walks the rail to.
//
// ITS OWN MODULE BECAUSE IT IS A RESOLUTION, NOT A CONTROL. `ProvenanceRail.tsx` owns
// the strip, the pointer, and the ARIA; what a key MEANS on that strip is a pure
// question over the tick list and the model, and answering it inside a `useCallback`
// mixed the two — the component could not be read without holding a key table in
// mind, and the table could not be exercised without a mount.
//
// THE SPLIT IS ALSO WHAT KEEPS THE CONTROL UNDER THE FILE-SIZE RULE once the strip
// grew its drag gesture. It is a real seam and not a size dodge: the walk decides,
// the component applies, and the two have no shared state.

import { type ProvenanceRailModel, type RailTick } from "./rail-model.js";
import { RAIL_TICK_KINDS, type RailTickKind } from "./rail-ticks.js";

/**
 * The walk origin when nothing is selected.
 *
 * A sentinel rather than `undefined` so the two arrow walks read one comparison
 * each: wire sequences start at zero, so a value below zero is before every mark
 * the rail can hold and after none of them.
 */
const BEFORE_EVERY_TICK = -1;

/**
 * The physical digit-row keys the kind walk binds.
 *
 * `Numpad1`–`Numpad9` are deliberately absent: with NumLock off those codes still
 * report while `key` reads `"End"` / `"Home"`, so binding them would hijack numpad
 * navigation away from the walk the arrows and the ends already offer.
 */
const KIND_WALK_DIGIT_CODE = /^Digit([1-9])$/;

/** The three members of a keypress the walk reads, and no more. */
export interface RailKeyboardWalkInput {
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
}

/**
 * What the rail does with one keypress.
 *
 * `claimed` and `tick` are separate answers because they differ in the case that
 * matters: a walk that found no further mark still CLAIMED the key — the caller
 * must consume it rather than let the page scroll — and moved nowhere. Folding the
 * two into `tick | undefined` made an unhandled key and an exhausted walk
 * indistinguishable, and the caller then either swallowed every key or scrolled the
 * page at the end of the rail.
 */
export interface RailKeyboardWalk {
  readonly claimed: boolean;
  readonly tick: RailTick | undefined;
}

/** The answer for a key this rail does not bind. */
const UNCLAIMED: RailKeyboardWalk = { claimed: false, tick: undefined };

/**
 * Resolve one keypress against the marks on screen.
 *
 * @param from - The RESOLVED selection's sequence, or `undefined` when nothing is
 *   selected. Resolved rather than recorded: a sequence whose mark the model has
 *   dropped is not a place on this rail, and walking from one skips every mark that
 *   is on it, or finds nothing and moves nowhere.
 */
export function railKeyboardWalk(
  input: RailKeyboardWalkInput,
  ticks: readonly RailTick[],
  model: ProvenanceRailModel,
  from: number | undefined,
): RailKeyboardWalk {
  const origin = from ?? BEFORE_EVERY_TICK;
  const walkKind = kindWalkedBy(input.code);
  if (walkKind !== undefined) {
    // Shift plus a digit walks one KIND — the previous tick of it, the digit alone
    // the next — while the plain arrows walk every tick, because that is what a
    // person reaches for first. The digit is read off the PHYSICAL key, for the
    // reason `kindWalkedBy` states.
    return {
      claimed: true,
      tick: model.tickOfKind(walkKind, origin, input.shiftKey ? "previous" : "next"),
    };
  }
  switch (input.key) {
    case "ArrowDown":
      return { claimed: true, tick: ticks.find((tick) => tick.sequence > origin) };
    case "ArrowUp":
      // From no selection, Up reaches the rail's last mark — the mirror of Down
      // reaching its first — which is what the unconditional arm is.
      return {
        claimed: true,
        tick: [...ticks]
          .reverse()
          .find((tick) => origin === BEFORE_EVERY_TICK || tick.sequence < origin),
      };
    case "Home":
      return { claimed: true, tick: ticks[0] };
    case "End":
      return { claimed: true, tick: ticks[ticks.length - 1] };
    default:
      return UNCLAIMED;
  }
}

/**
 * Which tick kind a keypress walks.
 *
 * Read from the event's `code` — the physical key — and never from its `key`,
 * because the previous-kind walk is Shift plus a digit and a shifted digit row
 * reports punctuation: Shift+1 is `"!"` on a US layout, and even unshifted the
 * digit row reports `"&"` on AZERTY. There is no `key` fallback, on purpose: it
 * would re-admit the `{ key: "1", shiftKey: true }` combination no browser
 * produces and leave the negative control unable to discriminate.
 *
 * Digits 1 through 9 name the first nine kinds in declaration order. The mapping
 * is derived from `RAIL_TICK_KINDS` rather than written out, so a kind added to
 * that tuple is walkable without a second table being edited.
 */
function kindWalkedBy(code: string): RailTickKind | undefined {
  const digit = KIND_WALK_DIGIT_CODE.exec(code)?.[1];
  if (digit === undefined) {
    return undefined;
  }
  return RAIL_TICK_KINDS[Number(digit) - 1];
}
