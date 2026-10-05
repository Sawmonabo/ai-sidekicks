// The daemon's one colorer: shiki's core with its JavaScript regex engine, grammars loaded the
// first time a language is asked for, and a span cache keyed on what the source holds.
//
// Spans are kept packed. A source's spans are one `Uint32Array` of `[offset, length, class]`
// triples, adjacent spans of one class merged and plain text left out, which holds a source's
// colors in well under a byte per source byte where one object per token holds several. The
// cache is bounded by those bytes (1/2048 of physical memory) and keyed by the language and a
// digest of the source, so the same code asked for twice is colored once and the cache never
// holds the source itself.
//
// The event loop is never held for a whole file. Tokenizing costs about 2 ms a kilobyte, so a
// large file colored in one call would stall every other request the daemon serves. The source
// is tokenized in slices of `TOKENIZE_SLICE_LENGTH` characters cut at line ends, each slice
// resuming the grammar state where the last stopped and yielding to the event loop before the
// next.
//
// The grammar table is a closed map of loaders keyed by the contract's language set, so a
// request can never make the daemon load a module it names.
import { createHash } from "node:crypto";
import { totalmem } from "node:os";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type { HighlightLanguage } from "@ai-sidekicks/contracts/highlight";
import { LRUCache } from "lru-cache";
import type { GrammarState, HighlighterCore, LanguageRegistration, ThemedToken } from "shiki/types";

import { buildCodeTheme, CODE_THEME_NAME, spanClassIndexOf } from "./code-theme.js";

type GrammarLoader = () => Promise<{ readonly default: LanguageRegistration[] }>;

const GRAMMAR_LOADERS: Readonly<Record<HighlightLanguage, GrammarLoader>> = {
  bash: () => import("shiki/langs/bash.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

/**
 * Characters tokenized between yields. Measured on TypeScript, a slice this long holds the
 * event loop at most about 20 ms once the grammar is warm; a slice four times longer held it
 * up to 45 ms.
 */
const TOKENIZE_SLICE_LENGTH = 1024;

/**
 * Lines longer than this are left plain rather than tokenized; a minified line is the case it
 * exists for. A length bounds a line's work instead of a
 * clock because shiki's default cuts a line off after 500 ms, so a busy machine would color the
 * same source differently and the cache would keep the half-colored copy.
 */
const TOKENIZE_MAX_LINE_LENGTH = 20_000;

/** Numbers per packed span: offset, length, class. */
const SPAN_WIDTH = 3;

/** The span cache's default budget: 1/2048 of the machine's physical memory. */
function defaultSpanCacheByteBudget(): number {
  return Math.floor(totalmem() / 2048);
}

/** What the span cache's fetch method tokenizes on a miss. */
interface SpanCacheFetchContext {
  readonly source: string;
  readonly language: HighlightLanguage;
}

/** Construction options for `CodeHighlighter`. */
export interface CodeHighlighterOptions {
  /** Bytes of packed spans the cache may hold. Defaults to 1/2048 of physical memory. */
  readonly spanCacheByteBudget?: number;
}

/** Colors code and keeps what it colored. One per daemon. */
export class CodeHighlighter {
  #highlighter: Promise<HighlighterCore> | undefined;
  readonly #loadedLanguages = new Map<HighlightLanguage, Promise<void>>();
  readonly #spanCache: LRUCache<string, Uint32Array, SpanCacheFetchContext>;

  constructor(options: CodeHighlighterOptions = {}) {
    this.#spanCache = new LRUCache<string, Uint32Array, SpanCacheFetchContext>({
      maxSize: options.spanCacheByteBudget ?? defaultSpanCacheByteBudget(),
      // A source with no colored text packs to no spans but still costs its entry, so an empty
      // list is charged one byte.
      sizeCalculation: (spans) => Math.max(spans.byteLength, 1),
      fetchMethod: (_key, _stale, { context }) => this.#tokenize(context.source, context.language),
    });
  }

  /**
   * The packed spans of `source` as `language`: `[offset, length, class]` triples in source
   * order, offsets and lengths in UTF-16 code units. Two reads of the same code share one
   * tokenization, whether the first has finished or is still running.
   */
  async readSpans(source: string, language: HighlightLanguage): Promise<Uint32Array> {
    const cacheKey = `${language}:${createHash("sha256").update(source).digest("base64url")}`;
    return this.#spanCache.forceFetch(cacheKey, { context: { source, language } });
  }

  async #tokenize(source: string, language: HighlightLanguage): Promise<Uint32Array> {
    const highlighter = await this.#resolveHighlighter();
    await this.#ensureLanguage(highlighter, language);
    const packedSpans: number[] = [];
    let grammarState: GrammarState | undefined;
    let sliceStart = 0;
    while (sliceStart < source.length) {
      const sliceEnd = endOfSlice(source, sliceStart);
      const sliceResult = highlighter.codeToTokens(source.slice(sliceStart, sliceEnd), {
        lang: language,
        theme: CODE_THEME_NAME,
        tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
        tokenizeTimeLimit: 0,
        ...(grammarState === undefined ? {} : { grammarState }),
      });
      appendPackedSpans(packedSpans, sliceResult.tokens, sliceStart);
      grammarState = sliceResult.grammarState;
      sliceStart = sliceEnd;
      if (sliceStart < source.length) {
        await yieldToEventLoop();
      }
    }
    return Uint32Array.from(packedSpans);
  }

  #resolveHighlighter(): Promise<HighlighterCore> {
    if (this.#highlighter === undefined) {
      const creating = createHighlighter();
      // A core that failed to start is dropped so the next read retries; the failure still
      // reaches the read waiting on it.
      creating.catch(() => {
        this.#highlighter = undefined;
      });
      this.#highlighter = creating;
    }
    return this.#highlighter;
  }

  #ensureLanguage(highlighter: HighlighterCore, language: HighlightLanguage): Promise<void> {
    let loading = this.#loadedLanguages.get(language);
    if (loading === undefined) {
      loading = GRAMMAR_LOADERS[language]().then((grammar) =>
        highlighter.loadLanguage(grammar.default),
      );
      // A grammar that failed to load is dropped, so the next read tries again.
      loading.catch(() => {
        this.#loadedLanguages.delete(language);
      });
      this.#loadedLanguages.set(language, loading);
    }
    return loading;
  }
}

async function createHighlighter(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ]);
  return createHighlighterCore({
    themes: [buildCodeTheme()],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
}

/**
 * Where the slice starting at `sliceStart` ends: just past the first line end at or after
 * `TOKENIZE_SLICE_LENGTH` characters, or the end of the source.
 */
function endOfSlice(source: string, sliceStart: number): number {
  const lineEnd = source.indexOf("\n", sliceStart + TOKENIZE_SLICE_LENGTH);
  return lineEnd === -1 ? source.length : lineEnd + 1;
}

/**
 * Appends a slice's colored tokens as packed spans, offsets moved from the slice to the whole
 * source. A span that starts where the last one ended, in the same class, extends it.
 */
function appendPackedSpans(
  packedSpans: number[],
  tokenLines: readonly (readonly ThemedToken[])[],
  sliceStart: number,
): void {
  for (const line of tokenLines) {
    for (const token of line) {
      const spanClass = spanClassIndexOf(token.color);
      if (spanClass === undefined || token.content.length === 0) {
        continue;
      }
      const offset = sliceStart + token.offset;
      const lastLengthIndex = packedSpans.length - SPAN_WIDTH + 1;
      const lastOffset = packedSpans[lastLengthIndex - 1];
      const lastLength = packedSpans[lastLengthIndex];
      if (
        lastOffset !== undefined &&
        lastLength !== undefined &&
        packedSpans[lastLengthIndex + 1] === spanClass &&
        lastOffset + lastLength === offset
      ) {
        packedSpans[lastLengthIndex] = lastLength + token.content.length;
      } else {
        packedSpans.push(offset, token.content.length, spanClass);
      }
    }
  }
}
