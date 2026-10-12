// The colorer's tokenizing thread: shiki's core on its Oniguruma engine, each grammar loaded the
// first time its language is asked for. A request's source is tokenized one line at a time with
// the grammar state carried, each line marked in shared memory as it starts and ends, so the main
// thread can tell which line it is on without a message per line. Spans are packed as
// `[offset, length, class]` triples, adjacent spans of one class merged and plain text left out,
// and the buffer is handed back, not copied.
//
// The grammar table is a closed map of loaders keyed by the contract's language set, so a request
// can never make the thread load a module it names.
//
// A grammar that embeds another, as Markdown embeds a fenced block's language or its front matter's
// YAML, colors the embedded text only when that grammar is loaded. So before a source is
// tokenized, every colorable grammar its own text opens is loaded, and the same source gives the
// same spans whatever the thread colored before.

import { parentPort, workerData } from "node:worker_threads";

import { HIGHLIGHT_LANGUAGES, type HighlightLanguage } from "@ai-sidekicks/contracts/highlight";
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

/** One language's grammar module and the TextMate scope another grammar embeds it by. */
interface Grammar {
  readonly scopeName: string;
  readonly load: () => Promise<{ readonly default: LanguageRegistration[] }>;
}

/** One rule of a TextMate grammar. */
type GrammarRule = LanguageRegistration["patterns"][number];

/** A rule of a loaded grammar that opens another colorable grammar's text. */
interface EmbeddingRule {
  /** The rule's opening pattern, tested against one line. */
  readonly opening: RegExp;
  /** Whether the rule opens only at the source's start, as front matter does. */
  readonly isAtStartOnly: boolean;
  readonly language: HighlightLanguage;
}

const GRAMMARS: Readonly<Record<HighlightLanguage, Grammar>> = {
  bash: { scopeName: "source.shell", load: () => import("shiki/langs/bash.mjs") },
  css: { scopeName: "source.css", load: () => import("shiki/langs/css.mjs") },
  diff: { scopeName: "source.diff", load: () => import("shiki/langs/diff.mjs") },
  go: { scopeName: "source.go", load: () => import("shiki/langs/go.mjs") },
  html: { scopeName: "text.html.basic", load: () => import("shiki/langs/html.mjs") },
  javascript: { scopeName: "source.js", load: () => import("shiki/langs/javascript.mjs") },
  json: { scopeName: "source.json", load: () => import("shiki/langs/json.mjs") },
  jsx: { scopeName: "source.js.jsx", load: () => import("shiki/langs/jsx.mjs") },
  markdown: { scopeName: "text.html.markdown", load: () => import("shiki/langs/markdown.mjs") },
  python: { scopeName: "source.python", load: () => import("shiki/langs/python.mjs") },
  rust: { scopeName: "source.rust", load: () => import("shiki/langs/rust.mjs") },
  sql: { scopeName: "source.sql", load: () => import("shiki/langs/sql.mjs") },
  tsx: { scopeName: "source.tsx", load: () => import("shiki/langs/tsx.mjs") },
  typescript: { scopeName: "source.ts", load: () => import("shiki/langs/typescript.mjs") },
  yaml: { scopeName: "source.yaml", load: () => import("shiki/langs/yaml.mjs") },
};

const LANGUAGE_BY_SCOPE_NAME: ReadonlyMap<string, HighlightLanguage> = new Map(
  HIGHLIGHT_LANGUAGES.map((language) => [GRAMMARS[language].scopeName, language]),
);

/**
 * Block-quote and list markers before a line's own text. A fence inside a quote or a list item
 * opens after them, so a line is tested with them removed as well as whole.
 */
const CONTAINER_MARKERS = /^(?:[ \t]*(?:>|[-+*]|\d{1,9}[.)])[ \t]?)+/u;

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
const embeddingRulesByLoadedLanguage = new Map<HighlightLanguage, readonly EmbeddingRule[]>();

port.on("message", (request: TokenizeRequest) => {
  void answer(request);
});

async function answer(request: TokenizeRequest): Promise<void> {
  try {
    // Only Markdown embeds other colorable grammars, and its rules are tested on every line of the
    // source, so one pass finds what a block nested in another block needs too.
    const embeddingRules = await loadGrammar(request.language);
    for (const language of findEmbeddedLanguages(request.source, embeddingRules)) {
      await loadGrammar(language);
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

/**
 * Loads a language's grammar once and answers the rules by which it embeds other colorable
 * grammars. Throws when the module no longer holds the scope the table names, since another
 * grammar could no longer embed it.
 */
async function loadGrammar(language: HighlightLanguage): Promise<readonly EmbeddingRule[]> {
  const loaded = embeddingRulesByLoadedLanguage.get(language);
  if (loaded !== undefined) {
    return loaded;
  }
  const { scopeName, load } = GRAMMARS[language];
  const registrations = (await load()).default;
  const ownGrammar = registrations.find((registration) => registration.scopeName === scopeName);
  if (ownGrammar === undefined) {
    throw new Error(`The ${language} grammar module holds no grammar with the scope ${scopeName}`);
  }
  await highlighter.loadLanguage(registrations);
  const embeddingRules = readEmbeddingRules(ownGrammar);
  embeddingRulesByLoadedLanguage.set(language, embeddingRules);
  return embeddingRules;
}

/**
 * The rules of a grammar's repository that open a colorable grammar's text: a begin pattern whose
 * first inner rule includes that grammar, as each of Markdown's fences and its front matter do.
 * Oniguruma's `\G` and `\A` anchors become a line start, the second kept to the source's start.
 */
function readEmbeddingRules(grammar: LanguageRegistration): EmbeddingRule[] {
  // The type requires a repository, but a grammar with no named rules, as diff's, ships none.
  const repository: Readonly<Record<string, GrammarRule>> | undefined = grammar.repository;
  return Object.values(repository ?? {}).flatMap((rule) => {
    const includedScopeName = rule.patterns?.[0]?.patterns?.[0]?.include;
    const language =
      includedScopeName === undefined ? undefined : LANGUAGE_BY_SCOPE_NAME.get(includedScopeName);
    // A grammar file writes each pattern as a string; only a grammar built in code holds a RegExp.
    if (typeof rule.begin !== "string" || language === undefined) {
      return [];
    }
    const isAtStartOnly = rule.begin.startsWith("\\A");
    // No `u` flag: the grammar's patterns are written for Oniguruma, where a bare `}` is a literal.
    const opening = new RegExp(rule.begin.replace("(^|\\G)", "(^)").replace(/^\\A/u, "^"));
    return [{ opening, isAtStartOnly, language }];
  });
}

/** Every language whose embedding rule opens on a line of the source. */
function findEmbeddedLanguages(
  source: string,
  embeddingRules: readonly EmbeddingRule[],
): Set<HighlightLanguage> {
  const languages = new Set<HighlightLanguage>();
  if (embeddingRules.length === 0) {
    return languages;
  }
  source.split("\n").forEach((line, lineIndex) => {
    const lineInContainer = line.replace(CONTAINER_MARKERS, "");
    for (const { opening, isAtStartOnly, language } of embeddingRules) {
      if (
        (lineIndex === 0 || !isAtStartOnly) &&
        (opening.test(line) || opening.test(lineInContainer))
      ) {
        languages.add(language);
      }
    }
  });
  return languages;
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
