// The transcript's diff card: one block per changed file, each file's rows in the flow with its own
// cut and footer (`InlineDiffBlock`), and no wrapper or header around the set. Past as many blocks
// as two screens of the flow hold, the rest of the files fold into one footer. A compared pair the
// row names is drawn the same way; a unified patch names neither state, so they come from the row
// (`contributions/inline-cards.ts`) and only the unread copy says them.

import "./InlineDiffCard.css";

import { useMemo, useState } from "react";

import { Nothing } from "#renderer/components/Nothing/Nothing.js";
import { formatCount } from "#renderer/lib/wire/figures.js";
import type { DiffInlineCardProps } from "#renderer/registries/inline-cards/registry.js";
import { useDiffBlockOverhead } from "../hooks/useDiffBlockOverhead.js";
import { useDiffRowHeightPx } from "../hooks/useDiffRowHeightPx.js";
import { useVisibleFlowHeight } from "../hooks/useVisibleFlowHeight.js";
import { type DiffModel } from "../model.js";
// Type-only: `patch-parse.ts` calls the diff library, and this card is registered eagerly, so
// a value import would put the parser on the initial import graph.
import type { ComparedStates } from "../patch-parse.js";
import { diffFlowDrawnFileCount, diffFlowRowsOf } from "../rows/flow.js";
import { InlineDiffBlock } from "./InlineDiffBlock.js";

/** What the diff card is drawn from: the row's registry props and, once read, the diff. */
export interface InlineDiffCardProps {
  readonly card: DiffInlineCardProps;
  /** The diff to render; absent until a fetch produces one. */
  readonly diff?: DiffModel;
}

/** A transcript row's diff card: each file's rows in the flow, the rest folded past two screens. */
export function InlineDiffCard(props: InlineDiffCardProps): React.JSX.Element {
  const [cardElement, setCardElement] = useState<HTMLDivElement | null>(null);
  const flowHeightPx = useVisibleFlowHeight(cardElement);

  return (
    <div className="meridian-diff-card" ref={setCardElement}>
      {props.diff === undefined ? (
        <Nothing
          kind="not-checked"
          placement="block"
          title="This diff has not been read."
          detail={unreadDiffDetail(comparedStatesOf(props.card))}
        />
      ) : flowHeightPx === undefined ? null : (
        <InlineDiffBlocks diff={props.diff} flowHeightPx={flowHeightPx} cardElement={cardElement} />
      )}
    </div>
  );
}

/**
 * One block per changed file, keyed by position so two files of one path each keep their own, up
 * to as many as two screens of the flow hold; the files past them fold into one footer.
 */
function InlineDiffBlocks(props: {
  readonly diff: DiffModel;
  readonly flowHeightPx: number;
  readonly cardElement: HTMLElement | null;
}): React.JSX.Element {
  const { diff, flowHeightPx } = props;
  const fileRows = useMemo(() => diff.files.map((file) => diffFlowRowsOf(diff, file)), [diff]);
  const rowHeightPx = useDiffRowHeightPx();
  // Until the first block's footer is laid out, a block's overhead is reckoned as one row; it is
  // read before the first paint, so the count a person sees is the measured one.
  const blockOverheadPx =
    useDiffBlockOverhead(props.cardElement, diff.files.length > 0) ?? rowHeightPx;
  const drawnFileCount = diffFlowDrawnFileCount(
    fileRows,
    flowHeightPx,
    blockOverheadPx,
    rowHeightPx,
  );
  const foldedFileCount = diff.files.length - drawnFileCount;

  return (
    <>
      {diff.files.slice(0, drawnFileCount).map((file, fileIndex) => {
        const flowRows = fileRows[fileIndex];
        return flowRows === undefined ? null : (
          <InlineDiffBlock
            key={fileIndex}
            file={file}
            flowRows={flowRows}
            flowHeightPx={flowHeightPx}
            rowHeightPx={rowHeightPx}
          />
        );
      })}
      {foldedFileCount === 0 ? null : (
        <div className="meridian-diff-card__fold">
          <span>{`${formatCount(foldedFileCount)} more ${foldedFileCount === 1 ? "file" : "files"} changed`}</span>
          <span className="meridian-diff-block__separator" aria-hidden="true">
            ·
          </span>
          <span>{`${formatCount(diff.files.length)} total`}</span>
        </div>
      )}
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
