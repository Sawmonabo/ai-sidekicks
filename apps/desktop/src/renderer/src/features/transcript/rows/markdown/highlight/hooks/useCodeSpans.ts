// The color spans one code block paints, read from the daemon with `highlight.read` once and kept
// in a cache shared by every code block, so a block drawn again paints at once and asks nothing.
// A refused read leaves the block plain, since the source is already on screen, and goes to the
// window's diagnostic capture.

import { useEffect, useState } from "react";

import type { HighlightLanguage } from "@ai-sidekicks/contracts";

import { useReadScope } from "@renderer/hooks/useReadScope.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "@renderer/lib/diagnostic-capture/diagnostic-capture.js";
import { callDaemon } from "@renderer/services/daemon/daemon-reply.js";
import { useClock } from "@renderer/services/platform/hooks/useClock.js";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { codeSpanCacheByteCap } from "../code-span-cache-cap.js";
import { ByteBoundedCache } from "../../parse/byte-bounded-cache.js";

/**
 * The packed spans for this block — `[offset, length, class]` triples over the source,
 * in UTF-16 code units — or `undefined` while it has none to paint.
 */
export function useCodeSpans(source: string, language: HighlightLanguage): Uint32Array | undefined {
  const bridge = usePlatformBridge();
  const clock = useClock();
  const blockKey = `${language}\u0000${source}`;
  const readScope = useReadScope(bridge, blockKey);
  const codeSpanCache = codeSpanCaches.cacheFor(bridge);
  // Seeded from the cache at mount so a redrawn block paints on its first frame; held in state
  // so a block the cache later evicts keeps the colors it is showing.
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
          // A read abandoned by its block has nobody left to answer; any other refusal is kept.
          if (!round.signal.aborted) {
            windowDiagnosticCapture.record({
              at: diagnosticStampAt(clock),
              severity: "warning",
              source: "features/transcript",
              kind: "highlight-read-refused",
              detail: `${reply.refusal.code}: ${reply.refusal.detail}`,
            });
          }
          return;
        }
        const spans = Uint32Array.from(reply.value.spans);
        codeSpanCache.set(blockKey, spans);
        round.settle(() => {
          setPainted({ blockKey, spans });
        });
      },
    );
  }, [bridge, clock, codeSpanCache, readScope, blockKey, language, source]);

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
 * Every code block's spans, keyed by language and source and charged their bytes: one cache per
 * bridge, sized from the physical memory it reports, so a window's blocks share one budget.
 * Held weakly by bridge, so a lookup is a memo a render may repeat or abandon.
 */
class CodeSpanCaches {
  readonly #cachesByBridge = new WeakMap<PlatformBridge, ByteBoundedCache<Uint32Array>>();

  public cacheFor(bridge: PlatformBridge): ByteBoundedCache<Uint32Array> {
    let cache = this.#cachesByBridge.get(bridge);
    if (cache === undefined) {
      cache = new ByteBoundedCache<Uint32Array>(
        codeSpanCacheByteCap(bridge.app.physicalMemoryBytes),
        (spans) => spans.byteLength,
      );
      this.#cachesByBridge.set(bridge, cache);
    }
    return cache;
  }
}

const codeSpanCaches = new CodeSpanCaches();
