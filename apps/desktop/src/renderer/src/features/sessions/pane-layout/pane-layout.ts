// What a pane layout is made of: the pane shape, the state shape, and the arithmetic that
// keeps a row of panes summing to a whole pane layout.
//
// Split out of `pane-layout-store.ts` because that file was doing three jobs — these
// shapes, the persisted grammar, and the live store — and the three have different
// readers. This one is the vocabulary layer of the pane layout: it holds no state, touches
// no React, and every function in it is pure, so the width arithmetic can be
// checked without constructing a layout at all.
//
// The dependency runs one way and only one way: `pane-layout` → `pane-layout-snapshot` →
// `pane-layout-store`. Nothing here imports either of the other two.

import type { EntityRef } from "@renderer/lib/entity-kinds.js";
import type { PaneKind } from "@renderer/routing/panes/pane-kinds.js";
import type { PaneLayoutDensity } from "./pane-layout-measures.js";

/**
 * Pane widths are carried as permille of the pane layout, summing to this.
 *
 * Integers rather than fractions because the value is persisted, and a float that
 * round-trips through JSON reintroduces the accumulation error the normalization
 * step exists to remove. Permille rather than percent so a pane layout of five panes divides
 * evenly.
 */
export const PANE_LAYOUT_TOTAL_PERMILLE = 1000;

/** One pane in the pane layout. Immutable; every mutation produces a new one. */
export interface SessionPane {
  /** Stable across a layout restore — the identity `PaneContext` carries. */
  readonly paneId: string;
  readonly kind: PaneKind;
  /** The entity this pane is a view of, or `undefined` for a session-scoped pane. */
  readonly entity: EntityRef | undefined;
  /** This pane's share of the pane layout, in permille. */
  readonly sizePermille: number;
  /** True for a pane that is never persisted and cascades closed with its source. */
  readonly isEphemeral: boolean;
  /** The pane this one opened beside, when it opened beside one. */
  readonly sourcePaneId: string | undefined;
}

/** What React renders from. A fresh object per mutation, so `Object.is` decides. */
export interface PaneLayoutState {
  readonly panes: readonly SessionPane[];
  readonly focusedPaneId: string | undefined;
  readonly density: PaneLayoutDensity;
  /** Monotonic, so a test can count transitions rather than infer them. */
  readonly revision: number;
}

/**
 * The separator between an address key's fields.
 *
 * A control character no pane kind, no entity kind, and no wire-minted id carries.
 * It is not load-bearing for injectivity even so: every field before the last comes
 * from a closed set, and the one free-form field — the entity id — is last, so a key
 * cannot be re-parsed into a different address whatever an id contains.
 */
const ADDRESS_KEY_SEPARATOR = "\u001f";

/**
 * One pane layout address, rendered as a string that equals another exactly when the two
 * name the same thing.
 *
 * Kind PLUS entity, because the same run legitimately appears in a `runs` pane and
 * an `inspector`, and collapsing them onto one pane would make the second open
 * silently steal the first.
 *
 * A KEY rather than only a predicate, because two callers ask two different
 * questions of one rule. {@link addressesMatch} asks "is this the pane I want",
 * which a comparison answers; the snapshot decoder asks "have I already adopted
 * this address", which a comparison answers only in quadratic time and only by
 * re-stating the rule at a second site. Both now derive from this one function, so
 * the restore path and the open path cannot disagree about what "the same address"
 * means.
 *
 * Takes the two members the address is made of rather than either named type, so a
 * `SessionPane` and an opened `PaneAddress` are keyed by the same call.
 */
export function paneAddressKey(address: Pick<SessionPane, "kind" | "entity">): string {
  const { entity } = address;
  return entity === undefined
    ? `${address.kind}${ADDRESS_KEY_SEPARATOR}`
    : `${address.kind}${ADDRESS_KEY_SEPARATOR}${entity.kind}${ADDRESS_KEY_SEPARATOR}${entity.id}`;
}

/**
 * Whether an open pane is already the pane an address asks for.
 *
 * Expressed through {@link paneAddressKey} rather than beside it: two copies of one
 * equality rule drift, and the drift is invisible — the pane layout would go on focusing
 * the right pane while a restore adopted the same one twice.
 */
export function addressesMatch(
  pane: SessionPane,
  address: Pick<SessionPane, "kind" | "entity">,
): boolean {
  return paneAddressKey(pane) === paneAddressKey(address);
}

/** Move one pane from `from` to `to`. Returns the input unchanged on a bad index. */
export function reorder(
  panes: readonly SessionPane[],
  from: number,
  to: number,
): readonly SessionPane[] {
  const next = [...panes];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) {
    return panes;
  }
  next.splice(to, 0, moved);
  return next;
}

/** Give every pane an equal share. What opening and closing leave behind. */
export function distributeEvenly(panes: readonly SessionPane[]): readonly SessionPane[] {
  if (panes.length === 0) {
    return panes;
  }
  const share = Math.floor(PANE_LAYOUT_TOTAL_PERMILLE / panes.length);
  return panes.map((pane, position) => ({
    ...pane,
    // The remainder goes to the first pane rather than being spread, so the sum is
    // exact and the arithmetic is one line a reader can check.
    sizePermille: position === 0 ? PANE_LAYOUT_TOTAL_PERMILLE - share * (panes.length - 1) : share,
  }));
}

/**
 * Permille per percent — the whole of the translation between the pane layout's grammar
 * and `react-resizable-panels`' one.
 *
 * The library speaks percentages of the group as floats (0..100); the persisted
 * grammar speaks integer permille, and stays integer permille, because a float that
 * round-trips through JSON reintroduces exactly the accumulation error `normalize`
 * exists to remove. So the conversion is a factor of ten and lives here, beside the
 * total it is derived from, rather than being written out at each of the three call
 * sites that need it.
 */
export const PERMILLE_PER_PERCENT: number = PANE_LAYOUT_TOTAL_PERMILLE / 100;

/** A layout as the panels library states it: panel id to percentage of the group. */
export type PaneSizePercentages = Readonly<Record<string, number>>;

/** The store's widths, as the percentages the panel group takes as its default. */
export function toPaneSizePercentages(panes: readonly SessionPane[]): PaneSizePercentages {
  const percentages: Record<string, number> = {};
  for (const pane of panes) {
    percentages[pane.paneId] = pane.sizePermille / PERMILLE_PER_PERCENT;
  }
  return percentages;
}

/**
 * Adopt a layout the panel group settled on, held above the pane layout's own floor.
 *
 * THE FLOOR IS APPLIED HERE AND NOT LEFT TO THE LIBRARY. The panels library clamps
 * its own drag against each panel's `minSize`, and the pane layout hands it the same
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
 * pane layout summing to something other than a whole.
 */
export function applyPaneSizePercentages(
  panes: readonly SessionPane[],
  percentages: PaneSizePercentages,
  minimumPermille: number,
): readonly SessionPane[] {
  const floor = Math.max(
    0,
    Math.min(minimumPermille, Math.floor(PANE_LAYOUT_TOTAL_PERMILLE / panes.length)),
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

/** Whether two width sets are the same, so a no-op write-back commits nothing. */
export function sizesAreEqual(
  left: readonly SessionPane[],
  right: readonly SessionPane[],
): boolean {
  return (
    left.length === right.length &&
    left.every((pane, position) => pane.sizePermille === right[position]?.sizePermille)
  );
}

/**
 * Make a clamped row sum to the whole pane layout again, without breaking the floor.
 *
 * `normalize` cannot do this job: it rescales every pane by one ratio, which pulls
 * a pane that was just raised to the floor straight back under it. So the drift is
 * taken from the panes that have room for it, widest headroom first, and a shortfall
 * is given to the widest pane. Bounded by construction — one pass over a sorted
 * copy, and the floor's own cap guarantees the headroom exists.
 */
function settleToTotal(panes: readonly SessionPane[], floor: number): readonly SessionPane[] {
  const sizes = panes.map((pane) => pane.sizePermille);
  let drift = sizes.reduce((sum, size) => sum + size, 0) - PANE_LAYOUT_TOTAL_PERMILLE;
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

/**
 * The narrowest a rescaled pane may become. One permille, so a pane on disk with a
 * width of nearly nothing still comes back as a pane rather than as a zero-width
 * column the panel group has no way to grab.
 */
const MINIMUM_NORMALIZED_PERMILLE = 1;

/**
 * Place arriving panes in front of an arrangement a person already made.
 *
 * {@link distributeEvenly}'s counterpart for the merge path, and the difference is the
 * whole point: equalizing a pane layout that already holds panes destroys the drag the person
 * finished while the record was being read, which is exactly the work
 * `PaneLayoutStore.adoptBeneath` exists to protect.
 *
 * HOW THE REMAINDER IS CARVED WHEN THE LIVE PANES ALREADY FILL THE TOTAL, which they
 * always do — every commit leaves the row summing to {@link PANE_LAYOUT_TOTAL_PERMILLE}, so
 * there is no unclaimed space for an arriving pane to take. Each arriving pane takes the
 * equal share it would have been given had the whole pane layout opened at once, and the live
 * row is rescaled INTO what is left, in proportion to the widths it already carried. So
 * the live panes keep their arrangement — a seventy-thirty pane layout stays seventy-thirty
 * across the space it still holds — while an adopted pane arrives at an ordinary width
 * rather than at whatever a subtraction happened to leave it.
 *
 * The sum is settled by {@link settleToTotal}, the same pass `normalize` and
 * `applyPaneSizePercentages` run, so one rule decides where a rounding remainder goes
 * and the row sums to a whole pane layout on every path.
 */
export function distributeAdoptedBeneath(
  adopted: readonly SessionPane[],
  live: readonly SessionPane[],
): readonly SessionPane[] {
  if (adopted.length === 0) {
    return live;
  }
  if (live.length === 0) {
    return distributeEvenly(adopted);
  }
  const adoptedShare = Math.floor(PANE_LAYOUT_TOTAL_PERMILLE / (adopted.length + live.length));
  const liveBudget = PANE_LAYOUT_TOTAL_PERMILLE - adoptedShare * adopted.length;
  const liveTotal = live.reduce((sum, pane) => sum + pane.sizePermille, 0);
  return settleToTotal(
    [
      ...adopted.map((pane) => ({ ...pane, sizePermille: adoptedShare })),
      ...live.map((pane) => ({
        ...pane,
        sizePermille: Math.max(
          MINIMUM_NORMALIZED_PERMILLE,
          liveTotal <= 0
            ? Math.floor(liveBudget / live.length)
            : Math.round((pane.sizePermille / liveTotal) * liveBudget),
        ),
      })),
    ],
    MINIMUM_NORMALIZED_PERMILLE,
  );
}

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
export function normalize(panes: readonly SessionPane[]): readonly SessionPane[] {
  const total = panes.reduce((sum, pane) => sum + pane.sizePermille, 0);
  if (panes.length === 0 || total <= 0) {
    return distributeEvenly(panes);
  }
  return settleToTotal(
    panes.map((pane) => ({
      ...pane,
      sizePermille: Math.max(
        MINIMUM_NORMALIZED_PERMILLE,
        Math.round((pane.sizePermille / total) * PANE_LAYOUT_TOTAL_PERMILLE),
      ),
    })),
    MINIMUM_NORMALIZED_PERMILLE,
  );
}

/**
 * The highest `pane-<n>` ordinal among restored panes.
 *
 * Read rather than reset, so a pane opened after a restore cannot be minted with an
 * id a restored pane already holds — which would make `close` remove two panes and
 * `focus` land on whichever the array reached first.
 */
export function highestOrdinal(panes: readonly SessionPane[]): number {
  let highest = 0;
  for (const pane of panes) {
    const ordinal = Number.parseInt(pane.paneId.replace(/^pane-/, ""), 10);
    if (Number.isFinite(ordinal) && ordinal > highest) {
      highest = ordinal;
    }
  }
  return highest;
}

/**
 * Place an arriving pane by halving ONE pane's share, leaving every other alone.
 *
 * THE SPLIT ACT'S WIDTH RULE, and the whole difference between splitting a pane and
 * opening one. {@link distributeEvenly} re-divides the pane layout, which is right for a pane
 * that arrives at the end and wrong for one arriving INSIDE an arrangement a person
 * made: splitting the third of four panes would resize the other three, and somebody
 * who asked for a companion to one pane would get a pane layout they had to rebuild.
 *
 * So the arriving pane takes half the source's share and the source keeps the rest,
 * remainder included — an odd share leaves the pane that was already there the wider
 * of the two. The sum is preserved by construction rather than by a settling pass:
 * one pane's number is divided and the two halves add back to it.
 *
 * A pane too narrow to halve cannot be split — a zero-width column is one the panel
 * group has no way to grab — so this answers `undefined` and the caller applies its
 * own fallback rather than being handed a silently equalized row.
 */
export function carveSplitFrom(
  panes: readonly SessionPane[],
  sourcePosition: number,
  arriving: SessionPane,
): readonly SessionPane[] | undefined {
  const source = panes[sourcePosition];
  if (source === undefined) {
    return undefined;
  }
  const arrivingShare = Math.floor(source.sizePermille / 2);
  if (arrivingShare < MINIMUM_NORMALIZED_PERMILLE) {
    return undefined;
  }
  const split = [...panes];
  split.splice(
    sourcePosition,
    1,
    { ...source, sizePermille: source.sizePermille - arrivingShare },
    { ...arriving, sizePermille: arrivingShare },
  );
  return split;
}
