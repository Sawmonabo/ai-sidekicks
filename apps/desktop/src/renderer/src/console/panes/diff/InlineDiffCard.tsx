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
// WHAT THE SEAT HANDS OVER, AND WHAT IT CANNOT. `DiffInlineCardProps` carries a
// `runId`, the `diffArtifactId` the registered diff result names itself by, and the
// `artifactManifestId` that diff minted — and no diff, because there is no wire to
// fetch one with: `gitflow.diffArtifactCreate` is a `Plan-023 §Console growth slate`
// row and the growth port registers no operation for it. So the registered body
// renders the honest absence, and the `diff` prop is the seam the fetch lands on
// the day the wire exists. Nothing here fabricates a method name to call.

import { useId, useRef, useState } from "react";

import { Glyph, Nothing } from "../../primitives/index.js";
import { registerInlineCardBody, type DiffInlineCardProps } from "../../seats/index.js";
import { INLINE_DIFF_CARD_HEIGHT_CAP_PX } from "./diff-bounds.js";
import { DiffRenderer } from "./DiffRenderer.js";
import { useDiffViewControls } from "./DiffToolbar.js";
import { type ConsoleDiffModel } from "./diff-model.js";
import { useDiffModelViewState } from "./diff-view-state.js";

/** Who owns this body, for the seat registry's owner-scoped duplicate policy. */
const INLINE_DIFF_CARD_OWNER = "repos";

/** Glyph edge length in the card's chrome, matching the primitives' inline size. */
const INLINE_DIFF_CARD_GLYPH_SIZE = 12;

export interface InlineDiffCardProps {
  readonly card: DiffInlineCardProps;
  /** The diff to render. Absent until a wire produces one — see the header. */
  readonly diff?: ConsoleDiffModel;
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
  const [isCapped, setIsCapped] = useState(true);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const endSentinelRef = useRef<HTMLSpanElement | null>(null);

  return (
    <section className="meridian-diff-card" aria-labelledby={headingId}>
      <header className="meridian-diff-card__header">
        <h4 className="meridian-diff-card__heading" id={headingId}>
          <Glyph name="diff" size={INLINE_DIFF_CARD_GLYPH_SIZE} />
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
              detail="The diff is named on the turn that produced it, and the read that fetches its lines is not registered on the bridge yet."
            />
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
 * owns.
 */
export function registerInlineDiffCardBody(): void {
  registerInlineCardBody("diff", {
    owner: INLINE_DIFF_CARD_OWNER,
    render: (cardProps) => <InlineDiffCard card={cardProps} />,
  });
}
