// The code blocks' color spans, read from the daemon with `highlight.read` once and kept in a
// cache shared by every code block in the window, so a block drawn again paints at once and asks
// nothing. A refused read leaves the block plain, since the source is already on screen, and goes
// to the window's diagnostic capture.

import type {
  CodeSpanReader,
  CodeSpanRequest,
} from "#renderer/components/Markdown/highlight/code-span-reader.js";
import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import type { Clock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { codeSpanCacheByteCap } from "./code-span-cache-cap.js";

/** A window's code-span reader: one daemon read per block, kept in the window's one cache. */
export class DaemonCodeSpanReader implements CodeSpanReader {
  readonly #bridge: PlatformBridge;
  readonly #clock: Clock;
  readonly #cache: ByteBoundedCache<Uint32Array>;

  public constructor(bridge: PlatformBridge, clock: Clock) {
    this.#bridge = bridge;
    this.#clock = clock;
    this.#cache = codeSpanCaches.cacheFor(bridge);
  }

  public heldSpans(request: CodeSpanRequest): Uint32Array | undefined {
    return this.#cache.get(blockKeyOf(request));
  }

  public async readSpans(
    request: CodeSpanRequest,
    signal: AbortSignal,
  ): Promise<Uint32Array | undefined> {
    const reply = await callDaemon(
      this.#bridge,
      "highlight.read",
      { language: request.language, source: request.source },
      { signal },
    );
    if (reply.status === "refused") {
      // A read abandoned by its block has nobody left to answer; any other refusal is kept.
      if (!signal.aborted) {
        windowDiagnosticCapture.record({
          at: diagnosticStampAt(this.#clock),
          severity: "warning",
          source: "services/highlight",
          kind: "highlight-read-refused",
          detail: `${reply.refusal.code}: ${reply.refusal.detail}`,
        });
      }
      return undefined;
    }
    const spans = Uint32Array.from(reply.value.spans);
    this.#cache.set(blockKeyOf(request), spans);
    return spans;
  }
}

/** One block's cache key: its language and its source, which NUL never appears between. */
function blockKeyOf(request: CodeSpanRequest): string {
  return `${request.language}\u0000${request.source}`;
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
