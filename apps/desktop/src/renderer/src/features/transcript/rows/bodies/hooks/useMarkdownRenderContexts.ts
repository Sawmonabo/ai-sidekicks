import { useMemo } from "react";

import { type MarkdownRenderContext } from "#renderer/components/Markdown/MarkdownNodes.js";
import { useCodeSpanReader } from "#renderer/services/highlight/hooks/useCodeSpanReader.js";
import { renderCodeBlockCopy } from "../CodeBlockCopy.js";

/** The two contexts a body's blocks are drawn in. */
export interface MarkdownRenderContexts {
  /** A settled block's: it is final, so math typesets and code is highlighted. */
  readonly settled: MarkdownRenderContext;
  /** The tail's: final only once the body is. */
  readonly volatile: MarkdownRenderContext;
}

/**
 * One body's render contexts, the same objects while the body's identifiers, completeness and
 * copy offer hold, so a frame that changed none of them re-renders no settled block.
 */
export function useMarkdownRenderContexts(
  definedFootnoteIdentifiers: ReadonlySet<string>,
  isComplete: boolean,
  offersCodeCopy: boolean,
): MarkdownRenderContexts {
  const codeSpanReader = useCodeSpanReader();
  const renderCodeCopy = offersCodeCopy ? renderCodeBlockCopy : undefined;
  const settled = useMemo<MarkdownRenderContext>(
    () => ({ isSettled: true, definedFootnoteIdentifiers, codeSpanReader, renderCodeCopy }),
    [definedFootnoteIdentifiers, codeSpanReader, renderCodeCopy],
  );
  const volatile = useMemo<MarkdownRenderContext>(
    () => ({ isSettled: isComplete, definedFootnoteIdentifiers, codeSpanReader, renderCodeCopy }),
    [isComplete, definedFootnoteIdentifiers, codeSpanReader, renderCodeCopy],
  );
  return useMemo(() => ({ settled, volatile }), [settled, volatile]);
}
