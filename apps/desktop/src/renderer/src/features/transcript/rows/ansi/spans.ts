// Maps `anser` runs onto spans that name palette colors, and parses a growing output a part at a
// time. Only `ansiToJson` is used: an HTML string built from tool output would have to be
// injected, which the transcript never does.
// Colors are names (`use_classes: true` reports `ansi-red`), not the tool's RGB values. Blink and
// conceal are not reproduced; 256-color and true-color runs render in the inherited foreground.
// Extended colors carry the tool's own palette and the app has no honest mapping onto its
// twelve-step wheel, so those spans inherit the foreground rather than take a nearest guess.

import Anser from "anser";

import { type PublishedText } from "../../reveal/published-text.js";
import { withoutResidualEscapes } from "./escape-sequences.js";

/**
 * ANSI chunks one command-output body renders before the rest is folded away. `anser` yields
 * one entry per style run, so the cap is on the mapped spans, which become DOM nodes. It is
 * the first render's cap, not a ceiling: `AnsiOutput` offers a control that re-parses the
 * text under a cap admitting every run, because reopening re-parses the same capped sequence.
 */
export const ANSI_SPAN_RENDER_CAP = 4096;

/**
 * One parsed run, derived from `ansiToJson`'s return type: `anser` publishes `export = Anser`,
 * whose namespace half is not reliably in scope through a default import under
 * `verbatimModuleSyntax`.
 */
type AnserJsonEntry = ReturnType<typeof Anser.ansiToJson>[number];

/** The sixteen color names anser reports under `use_classes`, without their `ansi-` prefix. */
export const ANSI_COLOR_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
] as const;

/** One ANSI color name. */
export type AnsiColorName = (typeof ANSI_COLOR_NAMES)[number];

/**
 * The app's own default foreground and background, as channel values a span can paint.
 * Only reverse video uses them, for a channel the stream left unset; `styles/palette.ts` binds
 * them to the tokens the body itself reads. A span the stream did not reverse never carries one.
 */
export const ANSI_DEFAULT_COLORS = ["default-foreground", "default-background"] as const;

/** One app default, as a channel value. */
export type AnsiDefaultColor = (typeof ANSI_DEFAULT_COLORS)[number];

/** Everything one channel can paint: a stream's color, or the app's own default. */
export type AnsiRenderedColor = AnsiColorName | AnsiDefaultColor;

/**
 * The decorations the app reproduces. `blink` and `hidden` are absent on purpose: a tool's
 * bytes must not start an animation or hide text they printed.
 */
export const ANSI_DECORATIONS = ["bold", "dim", "italic", "underline", "strikethrough"] as const;

/** One reproduced decoration. */
export type AnsiDecoration = (typeof ANSI_DECORATIONS)[number];

/** One run of output that shares a style. */
export interface AnsiSpan {
  /** The text, wire-verbatim. Never escaped here: React escapes at render. */
  readonly text: string;
  /** What the stream set this channel to, BEFORE any reverse-video swap. */
  readonly foreground: AnsiColorName | undefined;
  /** What the stream set this channel to, BEFORE any reverse-video swap. */
  readonly background: AnsiColorName | undefined;
  /**
   * Whether the stream asked for reverse video over this run. Kept apart from the channels
   * because a reversed run that set neither color has nothing to swap; only
   * `ansiSpanClassNames` knows the body's default pair.
   */
  readonly reversed: boolean;
  readonly decorations: readonly AnsiDecoration[];
}

/** What one parse produced, and what it had to leave out. */
export interface AnsiSpanSequence {
  readonly spans: readonly AnsiSpan[];
  /**
   * How many further spans the source held past the cap, so a truncated render is not mistaken
   * for a tool that stopped printing. It counts only runs that would have become spans: the
   * empty entries anser emits around a bare escape are skipped, not counted.
   */
  readonly elidedSpanCount: number;
}

/**
 * Parses one command output into styled spans as it grows, reading only the text past what it
 * already parsed. The result is the same as one parse of the whole text: the same spans, classes,
 * text and counts. Up to `spanCap` spans are built; the rest are counted, not built.
 *
 * The parsed part always ends where an `ESC [` begins. `anser` splits its input there, and every
 * run between two of them is one entry, so a cut anywhere else would split one run into two
 * spans, or end inside a sequence. Everything before the last `ESC [` is parsed once, on one
 * `anser` instance that carries the style (colors, decorations) from one part to the next exactly
 * as one whole-text parse carries it. The run from the last `ESC [` to the end can still grow, so
 * it is parsed again on each revision, from a copy of that instance's state.
 */
export class AnsiSpanParser {
  /** The spans of the parsed part, up to the cap. */
  readonly #parsedSpans: AnsiSpan[] = [];
  /** The `anser` instance standing where the parsed part ends, its style state carried. */
  #anser = new Anser();
  #parsedElidedSpanCount = 0;
  #parsed: ParsedText | undefined;
  #spanCap = ANSI_SPAN_RENDER_CAP;

  /**
   * The spans of `text` as it stands. The parsed part is kept while `text` is the handle last read
   * and still begins with it and the `ESC [` after it; a different handle, a rewrite below that or
   * a different cap parses from the start.
   */
  public read(text: PublishedText, spanCap: number = ANSI_SPAN_RENDER_CAP): AnsiSpanSequence {
    if (!this.#continues(text, spanCap)) {
      this.#reset(spanCap);
    }
    const parsedLength = this.#parsed?.length ?? 0;
    const unparsed = text.slice(parsedLength);
    // With no `ESC [` past its first character, the unparsed text is one run and none of it final.
    const runStart = Math.max(0, unparsed.lastIndexOf(CONTROL_SEQUENCE_INTRODUCER));
    if (runStart > 0) {
      this.#parsedElidedSpanCount += appendSpans(
        this.#anser.ansiToJson(unparsed.slice(0, runStart), anserOptions()),
        this.#parsedSpans,
        this.#spanCap,
      );
    }
    this.#parsed = { text, revision: text.revision, length: parsedLength + runStart };

    const spans = [...this.#parsedSpans];
    const lastRunElidedSpanCount = appendSpans(
      copyOf(this.#anser).ansiToJson(unparsed.slice(runStart), anserOptions()),
      spans,
      this.#spanCap,
    );
    return { spans, elidedSpanCount: this.#parsedElidedSpanCount + lastRunElidedSpanCount };
  }

  /** Whether the parsed part still stands for `text` under `spanCap`. */
  #continues(text: PublishedText, spanCap: number): boolean {
    const parsed = this.#parsed;
    return (
      parsed !== undefined &&
      parsed.text === text &&
      spanCap === this.#spanCap &&
      // The `ESC [` the parsed part ends before must stand too: the next part is parsed as
      // starting with it, so a rewrite of those two characters alone still parses from the start.
      text.keepsPrefix(parsed.revision, parsed.length + CONTROL_SEQUENCE_INTRODUCER.length)
    );
  }

  #reset(spanCap: number): void {
    this.#anser = new Anser();
    this.#parsedSpans.length = 0;
    this.#parsedElidedSpanCount = 0;
    this.#parsed = undefined;
    this.#spanCap = spanCap;
  }
}

const COLOR_NAMES_BY_ANSER_CLASS: ReadonlyMap<string, AnsiColorName> = new Map(
  ANSI_COLOR_NAMES.map((name) => [`ansi-${name}`, name] as const),
);

const REPRODUCED_DECORATIONS: ReadonlySet<string> = new Set<string>(ANSI_DECORATIONS);

/** The class name a foreground or background color renders under. */
export function ansiColorClassName(channel: "fg" | "bg", color: AnsiRenderedColor): string {
  return `meridian-ansi__${channel}--${color}`;
}

/** The class name a decoration renders under. */
export function ansiDecorationClassName(decoration: AnsiDecoration): string {
  return `meridian-ansi--${decoration}`;
}

/**
 * Every class one span carries, in a stable order.
 *
 * The reverse-video swap happens here, not in the parse: a stream that reversed without
 * setting both colors (a bare `ESC[7m` sets neither) needs the app's default for the
 * other channel.
 */
export function ansiSpanClassNames(span: AnsiSpan): readonly string[] {
  const foreground = span.reversed ? (span.background ?? "default-background") : span.foreground;
  const background = span.reversed ? (span.foreground ?? "default-foreground") : span.background;

  const names: string[] = [];
  if (foreground !== undefined) {
    names.push(ansiColorClassName("fg", foreground));
  }
  if (background !== undefined) {
    names.push(ansiColorClassName("bg", background));
  }
  for (const decoration of span.decorations) {
    names.push(ansiDecorationClassName(decoration));
  }
  return names;
}

/** Whether a decoration is one the app reproduces; `blink` and `hidden` are not. */
function isReproducedAnsiDecoration(decoration: string): decoration is AnsiDecoration {
  return REPRODUCED_DECORATIONS.has(decoration);
}

/**
 * The colors anser substitutes for an unset channel just before its own reverse swap: white
 * foreground, black background. They are undone, because the app maps `black` and `white`
 * to muted grays, so a substituted pair would paint gray on gray.
 *
 * An explicit `ESC[40m` or `ESC[37m` under reverse is indistinguishable from the substitution
 * and also collapses to the app default; telling them apart would need a second SGR state
 * machine beside the library's.
 */
const ANSER_SUBSTITUTED_FOREGROUND: AnsiColorName = "white";
const ANSER_SUBSTITUTED_BACKGROUND: AnsiColorName = "black";

function toSpan(entry: AnserJsonEntry): AnsiSpan {
  // Anser strips `reverse` from `decorations` and publishes `isInverted`, which its shipped
  // declaration omits, hence the `in` narrowing.
  const isReversed = "isInverted" in entry && entry.isInverted === true;
  if (!isReversed) {
    return {
      text: entry.content,
      foreground: resolveColor(entry.fg),
      background: resolveColor(entry.bg),
      reversed: false,
      decorations: entry.decorations.filter(isReproducedAnsiDecoration),
    };
  }

  // Anser already swapped: its `fg` holds the stream's background and its `bg` the stream's
  // foreground. Undo that so the span reports what the stream said.
  const streamBackground = resolveColor(entry.fg);
  const streamForeground = resolveColor(entry.bg);

  return {
    text: entry.content,
    foreground: streamForeground === ANSER_SUBSTITUTED_FOREGROUND ? undefined : streamForeground,
    background: streamBackground === ANSER_SUBSTITUTED_BACKGROUND ? undefined : streamBackground,
    reversed: true,
    decorations: entry.decorations.filter(isReproducedAnsiDecoration),
  };
}

/**
 * A color name, or `undefined` for one the app does not reproduce. Anser types the class
 * as `string` but sets `null` when no color applies.
 */
function resolveColor(anserClass: string | null | undefined): AnsiColorName | undefined {
  if (anserClass === null || anserClass === undefined) {
    return undefined;
  }
  return COLOR_NAMES_BY_ANSER_CLASS.get(anserClass);
}

/** The handle last read, at the revision it was read at, and how much of it is parsed. */
interface ParsedText {
  readonly text: PublishedText;
  readonly revision: number;
  readonly length: number;
}

/** Where `anser` splits its input: every run of output starts after one of these. */
const CONTROL_SEQUENCE_INTRODUCER = "\u001b[";

/**
 * The options every `anser` call takes, as a new object each time: `anser` writes into the
 * object it is given. `remove_empty` drops the zero-length runs anser emits around a bare escape.
 */
function anserOptions(): { json: true; use_classes: true; remove_empty: true } {
  return { json: true, use_classes: true, remove_empty: true };
}

/**
 * Appends the spans of `entries` to `spans` until it holds `spanCap`, and returns how many more
 * there were. Only runs that would become spans are counted: an empty entry is skipped.
 */
function appendSpans(
  entries: readonly AnserJsonEntry[],
  spans: AnsiSpan[],
  spanCap: number,
): number {
  let elidedSpanCount = 0;
  for (const entry of entries) {
    if (entry.content === "") {
      continue;
    }
    if (spans.length >= spanCap) {
      elidedSpanCount += 1;
      continue;
    }
    const span = toSpan(entry);
    // Anser leaves OSC and two-byte escapes inside a chunk; strip them before they become text.
    spans.push({ ...span, text: withoutResidualEscapes(span.text) });
  }
  return elidedSpanCount;
}

/**
 * A new `anser` instance in the same style state, so parsing the last run leaves the original
 * where the parsed part ends. `anser` keeps that state in the instance's own fields and changes
 * its decorations list in place, so the copy is deep.
 */
function copyOf(anser: Anser): Anser {
  return Object.assign(new Anser(), structuredClone(anser));
}
