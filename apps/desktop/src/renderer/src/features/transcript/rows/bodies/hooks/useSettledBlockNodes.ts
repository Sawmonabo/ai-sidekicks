import type { RootContent } from "mdast";
import { useMemo } from "react";

import { parseSettledBlock } from "#renderer/components/Markdown/parse.js";

/**
 * A settled block's nodes, parsed when the block is drawn and held only while it is: an unmounted
 * block keeps no tree beyond what the parse cache keeps.
 */
export function useSettledBlockNodes(
  source: string,
  definitionPreamble: string,
): readonly RootContent[] {
  return useMemo(
    () => parseSettledBlock(source, definitionPreamble).children,
    [source, definitionPreamble],
  );
}
