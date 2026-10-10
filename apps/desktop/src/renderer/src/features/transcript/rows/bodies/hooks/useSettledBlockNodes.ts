import type { RootContent } from "mdast";
import { useMemo } from "react";

import { parseSettledBlock } from "#renderer/components/Markdown/parse.js";
import { type SettledMarkdownBlock } from "../../markdown/body-blocks.js";

/**
 * A settled block's nodes, parsed when the block is drawn and held only while it is: an unmounted
 * block keeps no tree beyond what the parse cache keeps. The block's text is cut for the parse and
 * let go, so a drawn block keeps no text of its own.
 */
export function useSettledBlockNodes(
  block: SettledMarkdownBlock,
  readBlockSource: (block: SettledMarkdownBlock) => string,
  definitionPreamble: string,
): readonly RootContent[] {
  return useMemo(
    () => parseSettledBlock(readBlockSource(block), definitionPreamble).children,
    [block, readBlockSource, definitionPreamble],
  );
}
