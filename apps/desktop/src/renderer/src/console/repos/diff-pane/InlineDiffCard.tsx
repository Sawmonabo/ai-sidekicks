// The diff card a ledger row carries, and the seat registration that fills it.
//
// `Spec-023 §Meridian, the design language` rule 7 puts diff cards in the timeline at
// "a height cap and then offer 'show all'", and THIS CARD'S OWN RULE says exactly how
// that behaves: an inline timeline card uses the same
// renderer at a height cap, expanded to that cap by default with collapse
// retained, plus expand-in-place and jump-to-end. No capped diff ends in a fade
// with nowhere to go.
//
// Each clause of that rule is a decision this file makes and could have made
// wrongly:
//
//   • THE SAME RENDERER. `DiffRenderer`, not a lighter one. A card that rendered
//     its own rows would drift from the pane in exactly the details a diff is
//     read for.
//   • EXPANDED BY DEFAULT, COLLAPSE RETAINED. A card that opened collapsed would
//     make every diff in a session cost a click before it says anything, and the
//     turn it belongs to would read as having produced nothing.
//   • EXPAND-IN-PLACE AND JUMP-TO-END. Both, because they answer different
//     questions — "show me the rest here" and "take me past it" — and a card with
//     only the first strands a reader at the bottom of a five-thousand-line diff
//     inside a conversation.
//   • NO FADE WITH NOWHERE TO GO. The cap always ships with the controls that
//     leave it, in the same footer, always rendered.
//
// TWO FAMILIES MEET AT THE SEAT AND NEITHER IMPORTS THE OTHER. The ledger
// (T-023p-1C-2) renders the seat; this family owns the body. The registration
// below is the whole contact surface.
//
// WHAT THE SEAT HANDS OVER, AND THE TWO DENSITIES IT SELECTS BETWEEN.
// `DiffInlineCardProps` carries a `runId`, the `diffArtifactId` the registered diff
// result names itself by, the `artifactManifestId` that diff minted, and — where the
// row knows them — the pair of COMPARED STATES a diff was taken between. A unified
// patch names neither of those states, so they can only arrive from the row, which is
// why they are the seat's members and never a base and a head this card invented.
//
// THE PAIR IS WHAT SELECTS THE DENSITY, and the four clauses above are the rule for
// the arm where it is absent. A row that names no comparison identifies a diff by its
// artifact id alone, so what the card can honestly show is a GLANCE at its rows: the
// capped renderer, one control, and the two escape hatches. A row that names both
// states has said what the turn compared, and the honest rendering of a named
// comparison is the CHANGE SET — `DiffChangeSet`, the same body the pane renders, so
// the compared states are drawn and the changed files are reachable rather than being
// facts the card holds and does not show.
//
// AND THE PAIR IS READ WHERE THERE IS NO MODEL TOO. `diff` stays the seam a fetch
// lands on, and until one lands the absence says what was compared instead of only
// that nothing was read — a row that knows the two states has already answered half
// the question, and withholding that half would be the card reporting less than it
// holds.

import { useId, useRef, useState } from "react";

import { GLYPH_SIZE_ROW } from "../../tokens/index.js";
import { Glyph, Nothing } from "../../primitives/index.js";
import type { InlineCardSeatRegistry, DiffInlineCardProps } from "../../seats/index.js";
import { INLINE_DIFF_CARD_HEIGHT_CAP_PX } from "../../core/index.js";
import { DiffChangeSet } from "./DiffChangeSet.js";
import { DiffRenderer } from "./DiffRenderer.js";
import { useDiffViewControls } from "./DiffToolbar.js";
import { type ConsoleDiffModel } from "./diff-model.js";
import { useDiffModelViewState } from "./diff-view-state.js";
// TYPE-ONLY, AND THAT IS LOAD-BEARING RATHER THAN TIDY. `patch-parse.ts` is where the
// adopted diff library is called, and this card is registered eagerly — a value import
// of that module would put the parser on the initial import graph for every session,
// including the ones that open no diff at all. A type import is erased, so the shape
// the compared states travel in has one home and the graph does not move.
import type { ComparedStates } from "./patch-parse.js";

/** Who owns this body, for the seat registry's owner-scoped duplicate policy. */
const INLINE_DIFF_CARD_OWNER = "repos";

export interface InlineDiffCardProps {
  readonly card: DiffInlineCardProps;
  /** The diff to render. Absent until a wire produces one — see the header. */
  readonly diff?: ConsoleDiffModel;
}

/**
 * The comparison the row named, or `undefined` where it named neither.
 *
 * BOTH OR NOTHING, checked here rather than at each reader: half a comparison names no
 * diff at all, so a base with no head is the same answer as no base — and a reader that
 * tested one member would draw a subject bar with a blank on one side of it.
 */
function comparedStatesOf(card: DiffInlineCardProps): ComparedStates | undefined {
  const { baseRef, headRef } = card;
  if (baseRef === undefined || headRef === undefined) {
    return undefined;
  }
  return { baseRef, headRef };
}

/** What the absence says about a comparison the row named but nothing has read. */
function unreadDiffDetail(comparedStates: ComparedStates | undefined): string {
  if (comparedStates === undefined) {
    return "The diff is named on the turn that produced it, and its lines have not been read.";
  }
  return `This turn compared ${comparedStates.baseRef} to ${comparedStates.headRef}, and the lines of that comparison have not been read.`;
}

export function InlineDiffCard(props: InlineDiffCardProps): React.JSX.Element {
  const headingId = useId();
  // Marks OFF by default here and ON in the pane — `DiffToolbar.tsx`'s density rule.
  // A card is a glance; provenance marks earn their measure in a reading.
  const viewControls = useDiffViewControls({ showAttributionMarks: false });
  // The gap expansion is the MODEL's, and this card is reused for whichever diff
  // its ledger row carries, so it comes from the same hook the pane reads —
  // keyed by the prop reference, dropped when that moves. The card narrows to no
  // file, so it reads only the expansion half.
  const { expansion, expandGapAt } = useDiffModelViewState(props.diff);
  const comparedStates = comparedStatesOf(props.card);
  const [isCapped, setIsCapped] = useState(true);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const endSentinelRef = useRef<HTMLSpanElement | null>(null);

  return (
    <section className="meridian-diff-card" aria-labelledby={headingId}>
      <header className="meridian-diff-card__header">
        <h4 className="meridian-diff-card__heading" id={headingId}>
          <Glyph name="diff" size={GLYPH_SIZE_ROW} />
          Diff
        </h4>
        {/* Wire-verbatim, and the diff rather than the run: the run is the row's own
            subject and repeating it here would say nothing the ledger has not already
            said one line above. The manifest id is not rendered beside it — it is the
            provenance and retention of the same object, which is a reading the
            artifact surfaces do, not a second name for what this card shows. */}
        <span className="meridian-diff-card__change-set" title={props.card.diffArtifactId}>
          {props.card.diffArtifactId}
        </span>
        <button
          type="button"
          className="meridian-diff-card__control"
          aria-expanded={!isCollapsed}
          onClick={() => {
            setIsCollapsed((previous) => !previous);
          }}
        >
          {isCollapsed ? "Show diff" : "Collapse"}
        </button>
      </header>
      {isCollapsed ? null : (
        <div className="meridian-diff-card__body">
          {props.diff === undefined ? (
            <Nothing
              kind="not-checked"
              placement="surface"
              title="This diff has not been read."
              detail={unreadDiffDetail(comparedStates)}
            />
          ) : comparedStates !== undefined ? (
            // THE CHANGE SET, because the row named what was compared. The same body
            // the pane renders, so the compared states are drawn once and the changed
            // files are reachable — see the header for why the seat's pair is what
            // selects this arm.
            <DiffChangeSet diff={props.diff} />
          ) : (
            <>
              <DiffRenderer
                model={props.diff}
                viewMode={viewControls.viewMode}
                showAttributionMarks={viewControls.showAttributionMarks}
                wrapLongLines={viewControls.wrapLongLines}
                showWhitespaceChanges={viewControls.showWhitespaceChanges}
                expansion={expansion}
                onExpandGap={expandGapAt}
                {...(isCapped ? { heightCapPx: INLINE_DIFF_CARD_HEIGHT_CAP_PX } : {})}
                label={`Diff, ${props.diff.baseRef} to ${props.diff.headRef}`}
              />
              {/* Always rendered, capped or not — the cap's escape hatches are
                  what keep it from being a fade with nowhere to go, and a footer
                  that appeared only while capped would move the card's bottom
                  edge every time somebody used it. */}
              <div className="meridian-diff-card__footer">
                <button
                  type="button"
                  className="meridian-diff-card__control"
                  aria-pressed={!isCapped}
                  onClick={() => {
                    setIsCapped((previous) => !previous);
                  }}
                >
                  {isCapped ? "Expand in place" : "Restore height"}
                </button>
                {/* `DiffToolbar.tsx`'s density rule ends "one toggle away in both",
                    so the card carries the ONE control whose default it differs from
                    the pane on — not the pane's whole toolbar, which is four
                    controls of chrome inside a conversation. */}
                <button
                  type="button"
                  className="meridian-diff-card__control"
                  aria-pressed={viewControls.showAttributionMarks}
                  onClick={viewControls.toggleAttributionMarks}
                >
                  Attribution marks
                </button>
                {/* A FOCUS MOVE, NOT A SCROLL WRITE. Jump-to-end means "take me
                    past this card to the rest of the conversation", and focusing
                    the sentinel below does exactly that — the browser brings a
                    focused element into view, the caret lands where reading
                    resumes, and no code writes `scrollTop`, which the ledger's
                    own scroll chokepoint owns. A link to a fragment would
                    additionally rewrite the location hash, which this console
                    routes on. */}
                <button
                  type="button"
                  className="meridian-diff-card__control"
                  onClick={() => {
                    endSentinelRef.current?.focus();
                  }}
                >
                  Jump to end
                </button>
              </div>
              <span
                ref={endSentinelRef}
                tabIndex={-1}
                className="meridian-diff-card__end"
                aria-label="End of diff"
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Fill the ledger's `diff` card seat.
 *
 * Called from the repos family's own door rather than at this module's scope: a
 * registration that ran on import would fire from whichever module the bundler
 * reached first, and the family barrel is the one place that knows every body it
 * owns — and now the one place holding the board to write it into, which is why the
 * board arrives as an argument rather than being reached for here.
 */
export function registerInlineDiffCardBody(seats: InlineCardSeatRegistry): void {
  seats.register("diff", {
    owner: INLINE_DIFF_CARD_OWNER,
    render: (cardProps) => <InlineDiffCard card={cardProps} />,
  });
}
