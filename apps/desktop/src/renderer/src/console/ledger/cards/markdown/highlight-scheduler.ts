// The highlight scheduler — where a block is tokenised, and where the answer is kept.
//
// Three decisions, each of them a `Spec-023 §Console Libraries` constraint:
//
//   • **Above about 4 kB of source, the work leaves the main thread.** Below it, a
//     block costs a few milliseconds and a worker round trip would cost more than it
//     saved. `CODE_WORKER_THRESHOLD_BYTES` is the line, and `core/constants.ts` — the
//     one module a bound is declared in — is where its rationale lives.
//   • **The cache is content-addressed and bounded in bytes.** Keyed by language and
//     source, so the same block re-rendered — a scroll back, a re-mount, the same snippet
//     quoted twice — is free, and theme-independent because the tokens carry family
//     references rather than colours.
//   • **A block past `CODE_HIGHLIGHT_SOURCE_BYTE_CAP` is not highlighted at all.** The
//     worker keeps a huge block off the frame; it does not make it cheap, and the tokens
//     it produces would evict the whole cache to hold one paste.
//
// WHAT A CALLER SEES. `cachedTokens` answers synchronously from the cache, so a render
// never awaits; `requestTokens` is the asynchronous side a component's effect drives.
// That split is what keeps the component a render — the alternative, a `use()` on a
// promise built in the body, would build a new promise on every pass.
//
// WHEN THERE IS NO WORKER — a `Worker` the host does not provide, a constructor that
// throws, or a thread that died after construction — a block above the threshold
// renders PLAIN rather than falling back to the main thread. Falling back would be the
// honest-looking choice and the wrong one: the budget is not "highlight if you can", it
// is "never spend a frame on this", and a console that quietly broke that rule on hosts
// without workers would break it exactly where nobody was measuring.

import { ByteBoundedCache, measureUtf8ByteLength } from "./byte-bounded-cache.js";
import type { CodeTokenLine, HighlightableLanguage } from "./code-tokenizer.js";
import type { HighlightRequestMessage, HighlightResponseMessage } from "./highlight-protocol.js";

/** Why a block carries no tokens. Closed — a nameless absence is one a card cannot explain. */
export const HIGHLIGHT_DECLINE_REASONS = [
  "language-unsupported",
  "source-too-large",
  "worker-unavailable",
  "tokenize-failed",
] as const;

/** One decline reason. Derived from the enumeration, never restated. */
export type HighlightDeclineReason = (typeof HIGHLIGHT_DECLINE_REASONS)[number];

/** What a highlight attempt produced. */
export type HighlightOutcome =
  | { readonly status: "highlighted"; readonly lines: readonly CodeTokenLine[] }
  | { readonly status: "declined"; readonly reason: HighlightDeclineReason };

export class CodeHighlightScheduler {
  readonly #tokenCache: ByteBoundedCache<readonly CodeTokenLine[]>;
  readonly #pendingByRequestId = new Map<
    number,
    (lines: readonly CodeTokenLine[] | undefined) => void
  >();

  #worker: Worker | undefined;
  #workerUnavailable = false;
  #nextRequestId = 0;

  public constructor(byteCap: number = CODE_TOKEN_CACHE_BYTE_CAP) {
    this.#tokenCache = new ByteBoundedCache<readonly CodeTokenLine[]>(byteCap);
  }

  /** The tokens already held for this block, or `undefined`. Never starts work. */
  public cachedTokens(
    source: string,
    language: HighlightableLanguage,
  ): readonly CodeTokenLine[] | undefined {
    return this.#tokenCache.get(cacheKey(source, language));
  }

  /**
   * Tokenise a block, or say why not.
   *
   * The cache is consulted first even here, so a component whose effect re-runs after a
   * re-mount does not re-tokenise what it already has.
   */
  public async requestTokens(
    source: string,
    language: HighlightableLanguage,
  ): Promise<HighlightOutcome> {
    const key = cacheKey(source, language);
    const cached = this.#tokenCache.get(key);
    if (cached !== undefined) {
      return { status: "highlighted", lines: cached };
    }
    const sourceByteLength = measureUtf8ByteLength(source);
    if (sourceByteLength > CODE_HIGHLIGHT_SOURCE_BYTE_CAP) {
      return { status: "declined", reason: "source-too-large" };
    }
    const lines =
      sourceByteLength > CODE_WORKER_THRESHOLD_BYTES
        ? await this.#tokenizeOffThread(source, language)
        : await this.#tokenizeInline(source, language);
    if (lines === undefined) {
      return {
        status: "declined",
        reason:
          this.#workerUnavailable && sourceByteLength > CODE_WORKER_THRESHOLD_BYTES
            ? "worker-unavailable"
            : "tokenize-failed",
      };
    }
    this.#tokenCache.set(key, lines);
    return { status: "highlighted", lines };
  }

  /** What the cache is holding. For the budget test, and for nothing else. */
  public cacheStats(): ReturnType<ByteBoundedCache<readonly CodeTokenLine[]>["stats"]> {
    return this.#tokenCache.stats();
  }

  /** Terminal. Releases the worker and rejects nothing — pending callers settle plain. */
  public dispose(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#settleEveryPendingRequestPlain();
  }

  /**
   * Answer everything the worker was holding with no tokens.
   *
   * Hoisted on the second use (`apps/desktop/AGENTS.md`): disposal and a worker that
   * died mid-flight are the same obligation seen twice — every registered settle is
   * called exactly once and the map is emptied, so no caller is left awaiting a thread
   * that is gone and no settle is retained after it has answered.
   */
  #settleEveryPendingRequestPlain(): void {
    for (const settle of this.#pendingByRequestId.values()) {
      settle(undefined);
    }
    this.#pendingByRequestId.clear();
  }

  /**
   * Small blocks, in the calling thread.
   *
   * The import is dynamic so a session with no fenced code never loads shiki at all —
   * the same reason `code-tokenizer.ts` reaches for the core dynamically.
   */
  async #tokenizeInline(
    source: string,
    language: HighlightableLanguage,
  ): Promise<readonly CodeTokenLine[] | undefined> {
    const { tokenizeCode } = await import("./code-tokenizer.js");
    return tokenizeCode(source, language);
  }

  async #tokenizeOffThread(
    source: string,
    language: HighlightableLanguage,
  ): Promise<readonly CodeTokenLine[] | undefined> {
    const worker = this.#resolveWorker();
    if (worker === undefined) {
      return undefined;
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    const answered = new Promise<readonly CodeTokenLine[] | undefined>((settle) => {
      this.#pendingByRequestId.set(requestId, settle);
    });
    const request: HighlightRequestMessage = { requestId, source, language };
    worker.postMessage(request);
    return answered;
  }

  /**
   * The realm's worker, constructed on first use.
   *
   * A construction that throws is recorded rather than retried: a host with no module
   * workers will not grow them, and retrying per block would pay the failure over and
   * over on exactly the pages with the most code in them. A worker that DIED is not
   * replaced either, and for the same reason one level along: a thread that failed at
   * construction-plus-one will fail again, and a respawn loop is a worse failure than
   * an honest decline the card can name.
   *
   * THE UNAVAILABLE FLAG IS READ FIRST, before the held instance. That ordering is the
   * whole of "no request reaches a dead worker": it makes the property local to this
   * function instead of distributed across every path that might one day fail to clear
   * `#worker` beside setting the flag.
   */
  #resolveWorker(): Worker | undefined {
    if (this.#workerUnavailable || typeof Worker === "undefined") {
      this.#workerUnavailable = true;
      return undefined;
    }
    if (this.#worker !== undefined) {
      return this.#worker;
    }
    try {
      // The specifier names the SOURCE file rather than carrying this subtree's `.js`
      // import convention: `new URL` is resolved by the bundler's worker plugin against
      // the file on disk, not by TypeScript's module resolution, and a `.js` that no
      // file answers is emitted verbatim and fails at runtime.
      const worker = new Worker(new URL("./highlight-worker.ts", import.meta.url), {
        type: "module",
        name: "meridian-highlight",
      });
      worker.addEventListener("message", (event: MessageEvent<HighlightResponseMessage>) => {
        const settle = this.#pendingByRequestId.get(event.data.requestId);
        this.#pendingByRequestId.delete(event.data.requestId);
        settle?.(event.data.lines);
      });
      worker.addEventListener("error", () => {
        // A worker that failed after construction settles everything it was holding —
        // otherwise those callers wait forever for a thread that is gone — AND is let
        // go of, in the same act. Marking the realm unavailable while still holding the
        // instance would leave a dead thread reachable, and a later block would register
        // a settle nothing can ever call; terminating it and clearing the field is what
        // makes "the scheduler holds no worker it cannot use" true rather than intended.
        this.#workerUnavailable = true;
        worker.terminate();
        this.#worker = undefined;
        this.#settleEveryPendingRequestPlain();
      });
      this.#worker = worker;
      return worker;
    } catch {
      this.#workerUnavailable = true;
      return undefined;
    }
  }
}

/**
 * The cache key: language and source, in one place.
 *
 * The language is part of it because the same text tokenises differently under two
 * grammars, and a key that dropped it would serve a JSON block's tokens for a YAML one.
 */
function cacheKey(source: string, language: HighlightableLanguage): string {
  return `${language}\u0000${source}`;
}

/** The renderer's scheduler. One per realm, on `code-tokenizer.ts`' terms. */
export const consoleCodeHighlightScheduler: CodeHighlightScheduler = new CodeHighlightScheduler();
import {
  CODE_HIGHLIGHT_SOURCE_BYTE_CAP,
  CODE_TOKEN_CACHE_BYTE_CAP,
  CODE_WORKER_THRESHOLD_BYTES,
} from "../../../core/index.js";
