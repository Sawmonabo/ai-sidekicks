import { useMemo } from "react";

import { type MarkdownRenderContext } from "#renderer/components/Markdown/MarkdownNodes.js";
import { type MarkdownTableOffer } from "#renderer/components/Markdown/table-offer.js";
import { useCodeSpanReader } from "#renderer/services/highlight/hooks/useCodeSpanReader.js";
import { renderBlockCopy } from "../BlockCopy.js";

/** The two contexts a body's blocks are drawn in. */
export interface MarkdownRenderContexts {
  /** A settled block's: it is final, so math typesets and code is highlighted. */
  readonly settled: MarkdownRenderContext;
  /** The tail's: final only once the body is. */
  readonly volatile: MarkdownRenderContext;
}

/**
 * One body's render contexts, the same objects while the body's identifiers, completeness, copy
 * offer and table drawing hold, so a frame that changed none of them re-renders no settled block.
 */
export function useMarkdownRenderContexts(
  definedFootnoteIdentifiers: ReadonlySet<string>,
  isComplete: boolean,
  offersBlockCopy: boolean,
  renderTable: ((offer: MarkdownTableOffer) => React.ReactNode) | undefined,
): MarkdownRenderContexts {
  const codeSpanReader = useCodeSpanReader();
  const renderCopy = offersBlockCopy ? renderBlockCopy : undefined;
  const settled = useMemo<MarkdownRenderContext>(
    () => ({
      isSettled: true,
      definedFootnoteIdentifiers,
      codeSpanReader,
      renderCopy,
      renderTable,
    }),
    [definedFootnoteIdentifiers, codeSpanReader, renderCopy, renderTable],
  );
  const volatile = useMemo<MarkdownRenderContext>(
    () => ({
      isSettled: isComplete,
      definedFootnoteIdentifiers,
      codeSpanReader,
      renderCopy,
      renderTable,
    }),
    [isComplete, definedFootnoteIdentifiers, codeSpanReader, renderCopy, renderTable],
  );
  return useMemo(() => ({ settled, volatile }), [settled, volatile]);
}
