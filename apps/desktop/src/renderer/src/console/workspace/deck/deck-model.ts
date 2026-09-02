// What a deck is made of: the pane shape, the state shape, and the arithmetic that
// keeps a row of panes summing to a whole deck.
//
// Split out of `deck-layout.ts` because that file was doing three jobs — these
// shapes, the persisted grammar, and the live store — and the three have different
// readers. This one is the vocabulary layer of the deck: it holds no state, touches
// no React, and every function in it is pure, so the width arithmetic can be
// checked without constructing a layout at all.
//
// The dependency runs one way and only one way: `deck-model` → `deck-snapshot` →
// `deck-layout`. Nothing here imports either of the other two.

import type { ConsoleEntityRef } from "../../store/index.js";
import type { PaneKind } from "../seats/index.js";
import type { DeckDensity } from "./density.js";

/**
 * Pane widths are carried as permille of the deck, summing to this.
 *
 * Integers rather than fractions because the value is persisted, and a float that
 * round-trips through JSON reintroduces the accumulation error the normalisation
 * step exists to remove. Permille rather than percent so a five-pane deck divides
 * evenly.
 */
export const DECK_TOTAL_PERMILLE = 1000;

/**
 * The pane kinds that are never written to a snapshot.
 *
 * `Spec-023 §Console Design (Meridian)` §4.2: a `browser` pane "is ephemeral: it is
 * never written to the layout snapshot". Declared as a set rather than tested with
 * `kind === "browser"` at three sites, so a second ephemeral kind is one edit.
 */
export const EPHEMERAL_PANE_KINDS: readonly PaneKind[] = ["browser"];

/** One pane in the deck. Immutable; every mutation produces a new one. */
export interface DeckPane {
  /** Stable across a layout restore — the identity `ConsolePaneContext` carries. */
  readonly paneId: string;
  readonly kind: PaneKind;
  /** The entity this pane is a view of, or `undefined` for a session-scoped pane. */
  readonly entity: ConsoleEntityRef | undefined;
  /** This pane's share of the deck, in permille. */
  readonly sizePermille: number;
  /** True for a pane that is never persisted and cascades closed with its source. */
  readonly isEphemeral: boolean;
  /** The pane this one opened beside, when it opened beside one. */
  readonly sourcePaneId: string | undefined;
}

/** What React renders from. A fresh object per mutation, so `Object.is` decides. */
export interface DeckLayoutState {
  readonly panes: readonly DeckPane[];
  readonly focusedPaneId: string | undefined;
  readonly density: DeckDensity;
  /** Monotonic, so a test can count transitions rather than infer them. */
  readonly revision: number;
}

/** Which pane, over which entity — the address `open` resolves. */
export interface DeckPaneAddress {
  readonly kind: PaneKind;
  readonly entity: ConsoleEntityRef | undefined;
  /** Open beside this pane rather than at the end. The `browser` pane's rule. */
  readonly sourcePaneId?: string;
}

/**
 * Whether an open pane is already the pane an address asks for.
 *
 * Kind PLUS entity, because the same run legitimately appears in a `runs` pane and
 * an `inspector`, and collapsing them onto one pane would make the second open
 * silently steal the first.
 */
export function addressesMatch(pane: DeckPane, address: DeckPaneAddress): boolean {
  return (
    pane.kind === address.kind &&
    pane.entity?.kind === address.entity?.kind &&
    pane.entity?.id === address.entity?.id
  );
}

/** Move one pane from `from` to `to`. Returns the input unchanged on a bad index. */
export function reorder(panes: readonly DeckPane[], from: number, to: number): readonly DeckPane[] {
  const next = [...panes];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) {
    return panes;
  }
  next.splice(to, 0, moved);
  return next;
}

/** Give every pane an equal share. What opening and closing leave behind. */
export function distributeEvenly(panes: readonly DeckPane[]): readonly DeckPane[] {
  if (panes.length === 0) {
    return panes;
  }
  const share = Math.floor(DECK_TOTAL_PERMILLE / panes.length);
  return panes.map((pane, position) => ({
    ...pane,
    // The remainder goes to the first pane rather than being spread, so the sum is
    // exact and the arithmetic is one line a reader can check.
    sizePermille: position === 0 ? DECK_TOTAL_PERMILLE - share * (panes.length - 1) : share,
  }));
}

/**
 * Permille per percent — the whole of the translation between the deck's grammar
 * and `react-resizable-panels`' one.
 *
 * The library speaks percentages of the group as floats (0..100); the persisted
 * grammar speaks integer permille, and stays integer permille, because a float that
 * round-trips through JSON reintroduces exactly the accumulation error `normalise`
 * exists to remove. So the conversion is a factor of ten and lives here, beside the
 * total it is derived from, rather than being written out at each of the three call
 * sites that need it.
 */
export const PERMILLE_PER_PERCENT: number = DECK_TOTAL_PERMILLE / 100;

/** A layout as the panels library states it: panel id to percentage of the group. */
export type PaneSizePercentages = Readonly<Record<string, number>>;

/** The store's widths, as the percentages the panel group takes as its default. */
export function toPaneSizePercentages(panes: readonly DeckPane[]): PaneSizePercentages {
  const percentages: Record<string, number> = {};
  for (const pane of panes) {
    percentages[pane.paneId] = pane.sizePermille / PERMILLE_PER_PERCENT;
  }
  return percentages;
}

/**
 * Adopt a layout the panel group settled on, held above the deck's own floor.
 *
 * THE FLOOR IS APPLIED HERE AND NOT LEFT TO THE LIBRARY. The panels library clamps
 * its own drag against each panel's `minSize`, and the deck hands it the same
 * number, so in practice the two agree. They are still two clamps: the library's
 * runs over measured pixels in the DOM, and this one runs over the value that gets
 * persisted. A width below the floor reaching the store would be written to disk and
 * restored on the next launch, at which point no drag is happening for the library's
 * clamp to run in. So the store clamps what it keeps.
 *
 * A pane the layout does not name keeps the width it had — the group reports only
 * the panels it currently holds, and a pane mid-mount is legitimately absent.
 *
 * The floor is capped at an equal share, because a floor that cannot be met by
 * every pane at once has no solution and silently discarding it would leave the
 * deck summing to something other than a whole.
 */
export function applyPaneSizePercentages(
  panes: readonly DeckPane[],
  percentages: PaneSizePercentages,
  minimumPermille: number,
): readonly DeckPane[] {
  const floor = Math.max(
    0,
    Math.min(minimumPermille, Math.floor(DECK_TOTAL_PERMILLE / panes.length)),
  );
  return settleToTotal(
    panes.map((pane) => {
      const percentage = percentages[pane.paneId];
      if (percentage === undefined) {
        return pane;
      }
      return {
        ...pane,
        sizePermille: Math.max(floor, Math.round(percentage * PERMILLE_PER_PERCENT)),
      };
    }),
    floor,
  );
}

/**
 * Make a clamped row sum to the whole deck again, without breaking the floor.
 *
 * `normalise` cannot do this job: it rescales every pane by one ratio, which pulls
 * a pane that was just raised to the floor straight back under it. So the drift is
 * taken from the panes that have room for it, widest headroom first, and a shortfall
 * is given to the widest pane. Bounded by construction — one pass over a sorted
 * copy, and the floor's own cap guarantees the headroom exists.
 */
function settleToTotal(panes: readonly DeckPane[], floor: number): readonly DeckPane[] {
  const sizes = panes.map((pane) => pane.sizePermille);
  let drift = sizes.reduce((sum, size) => sum + size, 0) - DECK_TOTAL_PERMILLE;
  const byHeadroom = sizes
    .map((size, position) => ({ position, size }))
    .sort((left, right) => right.size - left.size);

  for (const candidate of byHeadroom) {
    if (drift === 0) {
      break;
    }
    const current = sizes[candidate.position] ?? 0;
    // Widening has no ceiling; narrowing stops at the floor.
    const adjustment = drift > 0 ? -Math.min(drift, current - floor) : -drift;
    sizes[candidate.position] = current + adjustment;
    drift += adjustment;
  }

  return panes.map((pane, position) => ({
    ...pane,
    sizePermille: sizes[position] ?? pane.sizePermille,
  }));
}

/** Whether two width sets are the same, so a no-op write-back commits nothing. */
export function sizesAreEqual(left: readonly DeckPane[], right: readonly DeckPane[]): boolean {
  return (
    left.length === right.length &&
    left.every((pane, position) => pane.sizePermille === right[position]?.sizePermille)
  );
}

/**
 * The narrowest a rescaled pane may become. One permille, so a pane on disk with a
 * width of nearly nothing still comes back as a pane rather than as a zero-width
 * column the panel group has no way to grab.
 */
const MINIMUM_NORMALISED_PERMILLE = 1;

/**
 * Rescale restored sizes so they sum to the total, whatever was on disk.
 *
 * ROUNDING ALONE DOES NOT SUM. Each pane's share is rounded independently, so three
 * equal saved widths become `333 + 333 + 333 = 999` and the panel group is handed an
 * incomplete layout — and these widths come from the explicitly untrusted persisted
 * snapshot, so the case is reached rather than theoretical. The remainder is
 * therefore settled after rounding, by the same pass `applyPaneSizePercentages`
 * uses: the drift goes to the WIDEST pane first, narrowing stops at the floor, and a
 * tie keeps the panes' own order because the sort is stable. Deterministic, so one
 * snapshot restores to one arrangement every time.
 *
 * Reusing `settleToTotal` rather than adding a second remainder rule is the point:
 * two rules for one job drift, and the sum is exactly the property that would stop
 * holding when they did.
 */
export function normalise(panes: readonly DeckPane[]): readonly DeckPane[] {
  const total = panes.reduce((sum, pane) => sum + pane.sizePermille, 0);
  if (panes.length === 0 || total <= 0) {
    return distributeEvenly(panes);
  }
  return settleToTotal(
    panes.map((pane) => ({
      ...pane,
      sizePermille: Math.max(
        MINIMUM_NORMALISED_PERMILLE,
        Math.round((pane.sizePermille / total) * DECK_TOTAL_PERMILLE),
      ),
    })),
    MINIMUM_NORMALISED_PERMILLE,
  );
}

/**
 * The highest `pane-<n>` ordinal among restored panes.
 *
 * Read rather than reset, so a pane opened after a restore cannot be minted with an
 * id a restored pane already holds — which would make `close` remove two panes and
 * `focus` land on whichever the array reached first.
 */
export function highestOrdinal(panes: readonly DeckPane[]): number {
  let highest = 0;
  for (const pane of panes) {
    const ordinal = Number.parseInt(pane.paneId.replace(/^pane-/, ""), 10);
    if (Number.isFinite(ordinal) && ordinal > highest) {
      highest = ordinal;
    }
  }
  return highest;
}
