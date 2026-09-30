// The color spans one code block paints, asked of the daemon once and kept.
//
// The daemon colors code and the block paints what it is handed. The block asks with
// `highlight.read` the first time it is drawn, and keeps the answer in a cache shared
// by every code block, so a block drawn again — scrolled back to, remounted, the same
// snippet quoted twice — paints its colors at once and asks nothing.
//
// A READ THAT IS REFUSED LEAVES THE BLOCK PLAIN. The source is already on screen in
// the code face, so a refusal changes nothing a reader sees; the block's colors are
// simply not there. A read nobody is waiting for any more is refused the same way and
// ends the same way.

import { useEffect, useState } from "react";

import type { HighlightLanguage } from "@ai-sidekicks/contracts";

import { useReadScope } from "@renderer/hooks/useReadScope.js";
import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { CODE_SPAN_CACHE_BYTE_CAP } from "../../../../cards/card-caps.js";
import { ByteBoundedCache } from "../../parse/byte-bounded-cache.js";

/**
 * The packed spans for this block — `[offset, length, class]` triples over the source,
 * in UTF-16 code units — or `undefined` while it has none to paint.
 */
export function useCodeSpans(source: string, language: HighlightLanguage): Uint32Array | undefined {
  const bridge = usePlatformBridge();
  const blockKey = `${language}\u0000${source}`;
  const readScope = useReadScope(bridge, blockKey);
  // Seeded from the cache once, at mount, so a block drawn again paints its colors on
  // its first frame, and held in state after that, so a block the cache later lets go
  // of keeps the colors it is showing.
  const [painted, setPainted] = useState<PaintedSpans | undefined>(() => {
    const cached = codeSpanCache.get(blockKey);
    return cached === undefined ? undefined : { blockKey, spans: cached };
  });

  useEffect(() => {
    const cached = codeSpanCache.get(blockKey);
    if (cached !== undefined) {
      setPainted((current) =>
        current?.blockKey === blockKey ? current : { blockKey, spans: cached },
      );
      return;
    }
    const round = readScope.openRound();
    void callDaemon(bridge, "highlight.read", { language, source }, { signal: round.signal }).then(
      (reply) => {
        if (reply.status === "refused") {
          return;
        }
        const spans = Uint32Array.from(reply.value.spans);
        codeSpanCache.set(blockKey, spans);
        round.settle(() => {
          setPainted({ blockKey, spans });
        });
      },
    );
  }, [bridge, readScope, blockKey, language, source]);

  return painted?.blockKey === blockKey ? painted.spans : undefined;
}

/**
 * The spans this block paints, and the block they were read for. Kept in the block's
 * own state as well as the cache: a block larger than the whole cache is never held
 * there, and one the cache evicts is still on screen.
 */
interface PaintedSpans {
  readonly blockKey: string;
  readonly spans: Uint32Array;
}

/**
 * Every code block's spans, keyed by language and source, charged the source and the
 * packed spans it holds.
 */
const codeSpanCache: ByteBoundedCache<Uint32Array> = new ByteBoundedCache<Uint32Array>(
  CODE_SPAN_CACHE_BYTE_CAP,
  (spans) => spans.byteLength,
);
