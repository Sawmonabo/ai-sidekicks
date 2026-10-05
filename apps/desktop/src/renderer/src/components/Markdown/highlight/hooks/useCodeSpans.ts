// The color spans one code block paints: what the reader already holds at once, else one read,
// which a block that moves on or unmounts abandons.

import { useEffect, useState } from "react";

import type { HighlightLanguage } from "@ai-sidekicks/contracts/highlight";

import { useReadScope } from "#renderer/hooks/useReadScope.js";
import type { CodeSpanReader } from "../code-span-reader.js";

/**
 * The packed spans for this block — `[offset, length, class]` triples over the source,
 * in UTF-16 code units — or `undefined` while it has none to paint.
 */
export function useCodeSpans(
  source: string,
  language: HighlightLanguage,
  reader: CodeSpanReader,
): Uint32Array | undefined {
  const blockKey = `${language}\u0000${source}`;
  const readScope = useReadScope(reader, blockKey);
  // Seeded from what the reader holds at mount so a redrawn block paints on its first frame;
  // held in state so a block the reader later lets go of keeps the colors it is showing.
  const [painted, setPainted] = useState<PaintedSpans | undefined>(() => {
    const held = reader.heldSpans({ language, source });
    return held === undefined ? undefined : { blockKey, spans: held };
  });

  useEffect(() => {
    const held = reader.heldSpans({ language, source });
    if (held !== undefined) {
      setPainted((current) =>
        current?.blockKey === blockKey ? current : { blockKey, spans: held },
      );
      return;
    }
    const round = readScope.openRound();
    void reader.readSpans({ language, source }, round.signal).then((spans) => {
      if (spans === undefined) {
        return;
      }
      round.settle(() => {
        setPainted({ blockKey, spans });
      });
    });
  }, [reader, readScope, blockKey, language, source]);

  return painted?.blockKey === blockKey ? painted.spans : undefined;
}

/**
 * The spans this block paints, and the block they were read for. Kept in the block's own state
 * as well as the reader's: a block larger than the reader's whole budget is never held there,
 * and one the reader lets go of is still on screen.
 */
interface PaintedSpans {
  readonly blockKey: string;
  readonly spans: Uint32Array;
}
