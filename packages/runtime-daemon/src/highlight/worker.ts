// The colorer's tokenizing thread: shiki's core on its Oniguruma engine, each grammar loaded the
// first time its language is asked for. A request's source is tokenized one line at a time with
// the grammar state carried, each line marked in shared memory as it starts and ends, so the main
// thread can tell which line it is on without a message per line. Spans are packed as
// `[offset, length, class]` triples, adjacent spans of one class merged and plain text left out,
// and the buffer is handed back, not copied.
//
// The grammar table is a closed map of loaders keyed by the contract's language set, so a request
// can never make the thread load a module it names.

import { parentPort, workerData } from "node:worker_threads";

import type { HighlightLanguage } from "@ai-sidekicks/contracts/highlight";
import type { GrammarState, HighlighterCore, LanguageRegistration, ThemedToken } from "shiki/types";

import { carryError } from "../worker/carried-error.js";
import { buildCodeTheme, CODE_THEME_NAME, spanClassIndexOf } from "./code-theme.js";
import { LineProgress } from "./line-progress.js";
import type {
  LineHookModule,
  TokenizeRequest,
  TokenizerReply,
  TokenizerWorkerData,
} from "./thread.js";

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
 * Characters tokenized between progress reports, each of which restarts the main thread's time
 * limit. A slice ends at a line end, so a long line is one slice: the longest line tokenized,
 * 19,999 characters, took up to 300 ms on a fresh thread.
 */
const TOKENIZE_SLICE_LENGTH = 1024;

/**
 * Lines longer than this are left plain rather than tokenized (VS Code's default for the same
 * limit); a minified line is the case it exists for. A length bounds a line's work instead of a
 * clock because shiki's default cuts a line off after 500 ms, so a busy machine would color the
 * same source differently and the cache would keep the half-colored copy.
 */
const TOKENIZE_MAX_LINE_LENGTH = 20_000;

/** Numbers per packed span: offset, length, class. */
const SPAN_WIDTH = 3;

if (parentPort === null) {
  throw new Error("The colorer's tokenizing thread runs only as a worker thread");
}
const port = parentPort;
const { lineProgressBuffer, lineHookModuleUrl } = workerData as TokenizerWorkerData;
const lineProgress = new LineProgress(lineProgressBuffer);
const beforeLine =
  lineHookModuleUrl === undefined
    ? undefined
    : ((await import(lineHookModuleUrl)) as LineHookModule).beforeLine;
const highlighter = await createHighlighter();
const loadedLanguages = new Set<HighlightLanguage>();

port.on("message", (request: TokenizeRequest) => {
  void answer(request);
});

async function answer(request: TokenizeRequest): Promise<void> {
  try {
    if (!loadedLanguages.has(request.language)) {
      await highlighter.loadLanguage((await GRAMMAR_LOADERS[request.language]()).default);
      loadedLanguages.add(request.language);
    }
    port.postMessage({ type: "grammar-loaded" } satisfies TokenizerReply);
    const spans = tokenize(request);
    // This thread's own heap and the regex engine's WebAssembly memory, which `external` counts.
    const { heapTotal, external } = process.memoryUsage();
    port.postMessage(
      { type: "tokenized", spans, memoryBytes: heapTotal + external } satisfies TokenizerReply,
      [spans.buffer],
    );
  } catch (error) {
    port.postMessage({ type: "failed", error: carryError(error) } satisfies TokenizerReply);
  }
}

async function createHighlighter(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/oniguruma"),
  ]);
  return createHighlighterCore({
    themes: [buildCodeTheme()],
    langs: [],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
}

function tokenize(request: TokenizeRequest): Uint32Array<ArrayBuffer> {
  const { source, language } = request;
  const plainLineOffsets = new Set(request.plainLineOffsets);
  const packedSpans: number[] = [];
  let grammarState: GrammarState | undefined;
  let lineStart = 0;
  let sliceEnd = TOKENIZE_SLICE_LENGTH;
  while (lineStart < source.length) {
    const lineEnd = endOfLine(source, lineStart);
    // A plain line keeps the state of the line before it, as shiki leaves an over-long one.
    if (!plainLineOffsets.has(lineStart)) {
      const line = source.slice(lineStart, lineEnd);
      lineProgress.markLineStarted(lineStart);
      beforeLine?.(line);
      const lineResult = highlighter.codeToTokens(line, {
        lang: language,
        theme: CODE_THEME_NAME,
        tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
        tokenizeTimeLimit: 0,
        ...(grammarState === undefined ? {} : { grammarState }),
      });
      lineProgress.markLineEnded();
      appendPackedSpans(packedSpans, lineResult.tokens, lineStart);
      grammarState = lineResult.grammarState;
    }
    lineStart = lineEnd;
    if (lineStart >= sliceEnd && lineStart < source.length) {
      port.postMessage({ type: "slice-tokenized" } satisfies TokenizerReply);
      sliceEnd = lineStart + TOKENIZE_SLICE_LENGTH;
    }
  }
  return Uint32Array.from(packedSpans);
}

/** Just past the line end at or after `lineStart`, or the end of the source. */
function endOfLine(source: string, lineStart: number): number {
  const lineEnd = source.indexOf("\n", lineStart);
  return lineEnd === -1 ? source.length : lineEnd + 1;
}

/**
 * Appends a line's colored tokens as packed spans, offsets moved from the line to the whole source.
 * A span that starts where the last one ended, in the same class, extends it.
 */
function appendPackedSpans(
  packedSpans: number[],
  tokenLines: readonly (readonly ThemedToken[])[],
  lineStart: number,
): void {
  for (const tokenLine of tokenLines) {
    for (const token of tokenLine) {
      const spanClass = spanClassIndexOf(token.color);
      if (spanClass === undefined || token.content.length === 0) {
        continue;
      }
      const offset = lineStart + token.offset;
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
