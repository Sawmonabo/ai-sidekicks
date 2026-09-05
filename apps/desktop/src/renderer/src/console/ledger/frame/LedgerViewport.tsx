// The ledger viewport — the virtualized feed, the reading anchor's pill, and the
// slot every row body is mounted through.
//
// This component RENDERS. Every decision it draws was made in a class:
// `viewport-controller.ts` wires the scroll chokepoint, the reading anchor, the row
// window, and the window cap together and publishes one snapshot; this file turns
// that snapshot into elements and does nothing else. No measurement, no
// subscription, no offset arithmetic lives here — and no BINDING is minted here
// either: the caller owns the one binding this ledger has and hands it down, so the
// rail, the find walk, and the rows on screen are all reading the same virtualizer.
//
// THREE THINGS THE MARKUP HAS TO GET RIGHT:
//
//   • **One scroll container.** The surface below is the only scrollable box in the
//     ledger. A second one anywhere inside it would give the chokepoint a rival
//     `scrollTop` it does not own, and the reading anchor is an offset INSIDE this
//     box.
//   • **A sizer, and rows placed inside it.** The sizer carries the whole log's
//     height so the scrollbar is honest; each mounted row is absolutely positioned
//     and translated to its own offset, so only the rows near the fold exist in the
//     document. Both the sizer's height and each row's transform are written by the
//     virtualizer DIRECTLY, under `directDomUpdates` — which is why neither appears
//     in the style objects below and why writing one here would fight it.
//   • **`role="feed"`, and rows that ARE articles, declared here.** The log grows at
//     one end while a person reads the other, which is exactly what a feed is. The
//     role's required-children relationship is satisfied by the row box BELOW, not
//     by whatever a row body happens to draw: the body arrives through a seat a
//     different family fills, so resting a WCAG-required structural relationship on
//     it would be fail-OPEN — the feed would stay valid only for as long as that
//     family kept rendering an `<article>`, and would break silently the day it
//     stopped. The element that declares `role="feed"` owns the guarantee.
//
//     The sizer between them is `role="presentation"`: it is pure geometry whose
//     height the virtualizer writes, it names nothing, and left in the tree it
//     stands between the feed and the rows it is supposed to own.
//
// `Spec-023 §The four bars`, Elegance: "Attention is steered by luminance and the
// two-hue rule, never by motion." A lane taking catch-up rate is marked with a class the
// stylesheet answers in luminance; nothing here animates, and nothing pulses.

import { Nothing } from "../../primitives/index.js";
import { LedgerErrorSlot, type LedgerErrorEntry } from "./ErrorSlot.js";
import { LedgerRowMount, type LedgerRowRenderer } from "./LedgerRowMount.js";
import { LedgerTailAffordance } from "./LedgerTailAffordance.js";
import { LedgerWindowNotices } from "./LedgerWindowNotices.js";
import { type LedgerViewportBinding } from "./viewport-binding.js";

/**
 * What a ledger is a log OF — the one thing an empty window's sentence turns on.
 *
 * DECLARED HERE BECAUSE THIS IS THE LOWEST CONSUMER, and every surface above
 * derives from this union rather than re-spelling the two words: the feed's
 * absences say the same thing about the same two subjects, and two unions would
 * drift the day a third scope exists.
 */
export type LedgerScope = "session" | "channel";

/**
 * What an empty window says, per scope.
 *
 * "Nothing has happened in this session yet" over a CHANNEL pane is false about the
 * session and says so with the session's own name: the pane is a log of one channel
 * and the session it belongs to may be busy. Total over the scope by `satisfies`,
 * the `LedgerWindowAbsences.tsx` shape, so a third scope is a compile error here rather
 * than a pane that borrows one of these two sentences.
 */
const EMPTY_LEDGER_WORDS = {
  session: {
    title: "Nothing has happened in this session yet.",
    detail: "Entries appear here as people and agents work.",
  },
  channel: {
    title: "Nothing has happened in this channel yet.",
    detail: "Entries appear here as people and agents work in it.",
  },
} as const satisfies Readonly<Record<LedgerScope, { title: string; detail: string }>>;

export interface LedgerViewportProps {
  /**
   * The caller's binding — the one this ledger has.
   *
   * TAKEN rather than minted. `useLedgerViewport` builds a controller, a scroll
   * chokepoint, a reading anchor, and a virtualizer, and a viewport that minted its
   * own would give the surrounding surface a SECOND set: the rail would report a
   * following state nobody is scrolling, and `jumpToRow` would scroll a virtualizer
   * with no element under it. One binding per ledger is the whole invariant, and
   * requiring it as a prop is what makes a second one unrepresentable rather than
   * merely discouraged.
   */
  readonly binding: LedgerViewportBinding;
  /** STABLE across renders, or the memoized rows below re-render with it. */
  readonly renderRow: LedgerRowRenderer;
  /** Names the feed for a screen reader walking the window. */
  readonly feedLabel: string;
  /**
   * What this ledger is a log of. REQUIRED, so a caller decides rather than
   * inherits: the empty sentence below is a claim about a subject, and defaulting
   * it to the session is how a channel pane came to say the session was empty.
   */
  readonly scope: LedgerScope;
  /** A turn is mid-flight — the same value the caller reconciled the binding with. */
  readonly hasActiveTurn?: boolean;
  readonly errorEntries?: readonly LedgerErrorEntry[];
}

const NO_ERROR_ENTRIES: readonly LedgerErrorEntry[] = [];

export function LedgerViewport(props: LedgerViewportProps): React.JSX.Element {
  const { binding } = props;
  const { snapshot } = binding;

  return (
    <div className="meridian-ledger-viewport">
      <LedgerErrorSlot entries={props.errorEntries ?? NO_ERROR_ENTRIES} />
      <div
        className="meridian-ledger-viewport__surface"
        ref={binding.attachSurface}
        // The feed role is claimed only while there is something to be a feed OF,
        // and the articles it owns are `LedgerRowMount`'s half of the same claim.
        // `feed` REQUIRES owned articles, so an empty one is not a quieter feed but
        // an invalid one — and a role whose contract the element is breaking is
        // worse for a screen-reader user than the plain scroll container this
        // honestly is until the first row lands. The label and the busy state go
        // with it: both describe the feed, and neither has a subject without it.
        {...(snapshot.rows.length === 0
          ? {}
          : {
              role: "feed",
              "aria-label": props.feedLabel,
              "aria-busy": props.hasActiveTurn ?? false,
            })}
        // Focusable so the log is reachable and scrollable from the keyboard: a
        // scroll container with no focusable child is unreachable by Tab, and the
        // reading anchor is a promise made to somebody who can get here.
        tabIndex={0}
      >
        <div
          className="meridian-ledger-viewport__sizer"
          ref={binding.attachSizer}
          role="presentation"
        >
          {binding.virtualItems.map((virtualItem) => {
            const row = snapshot.rows[virtualItem.index];
            return row === undefined ? null : (
              <LedgerRowMount
                key={virtualItem.key}
                rowIndex={virtualItem.index}
                row={row}
                totalRowCount={snapshot.rows.length}
                renderRow={props.renderRow}
                attachRow={binding.attachRow}
              />
            );
          })}
        </div>
        {snapshot.rows.length === 0 ? (
          <Nothing
            kind="empty"
            placement="surface"
            title={EMPTY_LEDGER_WORDS[props.scope].title}
            detail={EMPTY_LEDGER_WORDS[props.scope].detail}
          />
        ) : null}
        <LedgerWindowNotices binding={binding} />
      </div>
      <LedgerTailAffordance snapshot={snapshot} onJumpToTail={binding.jumpToTail} />
    </div>
  );
}
