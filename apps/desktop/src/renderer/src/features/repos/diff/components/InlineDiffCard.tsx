// The transcript's diff card. Without a compared pair it draws one block per changed file, each
// file's rows in the flow with its own cut and footer (`InlineDiffBlock`). With both compared
// states it shows `DiffChangeSet`. A unified patch names neither state, so they come from the row
// (`contributions/inline-cards.ts`).

import "./InlineDiffCard.css";

import { useId, useState } from "react";

import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import type { DiffInlineCardProps } from "#renderer/registries/inline-cards/registry.js";
import { DiffChangeSet } from "./DiffChangeSet.js";
import { InlineDiffBlock } from "./InlineDiffBlock.js";
import { type DiffModel } from "../model.js";
// Type-only: `patch-parse.ts` calls the diff library, and this card is registered eagerly, so
// a value import would put the parser on the initial import graph.
import type { ComparedStates } from "../patch-parse.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";

/** What the diff card is drawn from: the row's registry props and, once read, the diff. */
export interface InlineDiffCardProps {
  readonly card: DiffInlineCardProps;
  /** The diff to render; absent until a fetch produces one. */
  readonly diff?: DiffModel;
}

/** A transcript row's diff card: each file's rows in the flow, or the change set when states are named. */
export function InlineDiffCard(props: InlineDiffCardProps): React.JSX.Element {
  const headingId = useId();
  const comparedStates = comparedStatesOf(props.card);
  const [isCollapsed, setIsCollapsed] = useState(false);

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
        <HoverLabel text={props.card.diffArtifactId} textRole="visible-text">
          <span className="meridian-diff-card__change-set">{props.card.diffArtifactId}</span>
        </HoverLabel>
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
            <InlineDiffBlocks diff={props.diff} />
          )}
        </div>
      )}
    </section>
  );
}

/** One block per changed file, keyed by position: two files of one path each keep their own. */
function InlineDiffBlocks(props: { readonly diff: DiffModel }): React.JSX.Element {
  return (
    <>
      {props.diff.files.map((file, fileIndex) => (
        <InlineDiffBlock key={fileIndex} diff={props.diff} file={file} />
      ))}
    </>
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
