// The transcript's diff card. Without a compared pair it shows the capped `DiffRenderer`, open
// by default, with collapse, expand-in-place and jump-to-end always rendered so a cap never
// ends in a fade with nowhere to go. With both compared states it shows `DiffChangeSet`. A
// unified patch names neither state, so they come from the row (`contributions/inline-cards.ts`).

import "./InlineDiffCard.css";

import { useId, useRef, useState } from "react";

import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import type { DiffInlineCardProps } from "#renderer/registries/inline-cards/registry.js";
import { INLINE_DIFF_CARD_HEIGHT_CAP_PX } from "../caps.js";
import { DiffChangeSet } from "./DiffChangeSet.js";
import { DiffRenderer } from "./DiffRenderer.js";
import { useDiffViewControls } from "../hooks/useDiffViewControls.js";
import { type DiffModel } from "../model.js";
import { useDiffModelViewState } from "../hooks/useDiffModelViewState.js";
// Type-only: `patch-parse.ts` calls the diff library, and this card is registered eagerly, so
// a value import would put the parser on the initial import graph.
import type { ComparedStates } from "../patch-parse.js";

/** What the diff card is drawn from: the row's registry props and, once read, the diff. */
export interface InlineDiffCardProps {
  readonly card: DiffInlineCardProps;
  /** The diff to render; absent until a fetch produces one. */
  readonly diff?: DiffModel;
}

/** A transcript row's diff card: a capped glance, or the full change set when states are named. */
export function InlineDiffCard(props: InlineDiffCardProps): React.JSX.Element {
  const headingId = useId();
  const viewControls = useDiffViewControls();
  // Gap expansion is the model's, so it comes from the hook the pane reads. The card narrows
  // to no file, so only the expansion half is used.
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
        {/* Wire-verbatim, and the diff rather than the run: the run is the row's own subject.
            The manifest id is not shown; it is provenance of the same object, which the
            artifact views read. */}
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
              placement="block"
              title="This diff has not been read."
              detail={unreadDiffDetail(comparedStates)}
            />
          ) : comparedStates !== undefined ? (
            // The row named what was compared, so draw the pane's own body: the states are shown
            // once and the changed files are reachable.
            <DiffChangeSet diff={props.diff} />
          ) : (
            <>
              <DiffRenderer
                model={props.diff}
                viewMode={viewControls.viewMode}
                expansion={expansion}
                onExpandGap={expandGapAt}
                {...(isCapped ? { heightCapPx: INLINE_DIFF_CARD_HEIGHT_CAP_PX } : {})}
                label={`Diff, ${props.diff.baseRef} to ${props.diff.headRef}`}
              />
              {/* Always rendered, capped or not: a footer that appeared only while capped
                  would move the card's bottom edge on use. */}
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
                {/* A focus move, not a scroll write: focusing the sentinel brings it into
                    view, and the transcript's scroll chokepoint owns `scrollTop`. A fragment
                    link would rewrite the location hash, which the console routes on. */}
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
 * The comparison the row named, or `undefined` unless it named both states: half a comparison
 * names no diff, so a base with no head answers the same as no base.
 */
function comparedStatesOf(card: DiffInlineCardProps): ComparedStates | undefined {
  const { baseRef, headRef } = card;
  if (baseRef === undefined || headRef === undefined) {
    return undefined;
  }
  return { baseRef, headRef };
}

/** What the empty state says about a comparison the row named but nothing has read. */
function unreadDiffDetail(comparedStates: ComparedStates | undefined): string {
  if (comparedStates === undefined) {
    return "The diff is named on the turn that produced it, and its lines have not been read.";
  }
  return (
    `This turn compared ${comparedStates.baseRef} to ` +
    `${comparedStates.headRef}, and the lines of that comparison ` +
    "have not been read."
  );
}
