import type { RootContent } from "mdast";
import { useMemo, useState } from "react";

import { VolatileTailParser } from "../../markdown/parse/volatile-tail.js";

/**
 * The volatile tail's nodes, from a parser that survives the frame, so a frame that only appends
 * to the tail's last text or open fence costs its append.
 */
export function useVolatileTailNodes(
  source: string,
  definitionPreamble: string,
): readonly RootContent[] {
  const [parser] = useState(() => new VolatileTailParser());
  return useMemo(
    () => parser.parse(source, definitionPreamble).children,
    [parser, source, definitionPreamble],
  );
}
