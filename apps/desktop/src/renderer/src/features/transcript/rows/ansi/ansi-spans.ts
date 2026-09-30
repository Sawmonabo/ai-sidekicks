// Maps `anser` runs onto spans that name palette colors. Only `ansiToJson` is used: an HTML string
// built from tool output would have to be injected, which the transcript never does.
// Colors are names (`use_classes: true` reports `ansi-red`), not the tool's RGB values. Blink and
// conceal are not reproduced; 256-color and true-color runs render in the inherited foreground.
// Extended colors carry the tool's own palette and the console has no honest mapping onto its
// twelve-step wheel, so those spans inherit the foreground rather than take a nearest guess.

import Anser from "anser";

import { withoutResidualEscapes } from "./escape-sequences.js";

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
 * The console's own default foreground and background, as channel values a span can paint.
 * Only reverse video uses them, for a channel the stream left unset; `styles/palette.ts` binds
 * them to the tokens the body itself reads. A span the stream did not reverse never carries one.
 */
export const ANSI_DEFAULT_COLORS = ["default-foreground", "default-background"] as const;

/** One console default, as a channel value. */
export type AnsiDefaultColor = (typeof ANSI_DEFAULT_COLORS)[number];

/** Everything one channel can paint: a stream's color, or the console's own default. */
export type AnsiRenderedColor = AnsiColorName | AnsiDefaultColor;

/**
 * The decorations the console reproduces. `blink` and `hidden` are absent on purpose: a tool's
 * bytes must not start an animation or hide text they printed, and a test asserts it.
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

const COLOR_NAMES_BY_ANSER_CLASS: ReadonlyMap<string, AnsiColorName> = new Map(
  ANSI_COLOR_NAMES.map((name) => [`ansi-${name}`, name] as const),
);

const REPRODUCED_DECORATIONS: ReadonlySet<string> = new Set<string>(ANSI_DECORATIONS);

/**
 * Parses ANSI text into styled spans, up to `spanCap`; the remainder is counted, not built.
 *
 * `remove_empty` drops the zero-length runs anser emits around a bare escape sequence. The cap
 * is a parameter so a caller can re-parse the same source under a wider one.
 */
export function parseAnsiSpans(
  source: string,
  spanCap: number = ANSI_SPAN_RENDER_CAP,
): AnsiSpanSequence {
  const entries = Anser.ansiToJson(source, { json: true, use_classes: true, remove_empty: true });
  const spans: AnsiSpan[] = [];
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

  return { spans, elidedSpanCount };
}

/**
 * Whether a decoration is one the console reproduces. Exported so a test can assert that
 * `blink` and `hidden` are not.
 */
export function isReproducedAnsiDecoration(decoration: string): decoration is AnsiDecoration {
  return REPRODUCED_DECORATIONS.has(decoration);
}

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
 * setting both colors (a bare `ESC[7m` sets neither) needs the console's default for the
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

/**
 * The colors anser substitutes for an unset channel just before its own reverse swap: white
 * foreground, black background. They are undone, because the console maps `black` and `white`
 * to muted grays, so a substituted pair would paint gray on gray.
 *
 * An explicit `ESC[40m` or `ESC[37m` under reverse is indistinguishable from the substitution
 * and also collapses to the console default; telling them apart would need a second SGR state
 * machine beside the library's.
 */
const ANSER_SUBSTITUTED_FOREGROUND: AnsiColorName = "white";
const ANSER_SUBSTITUTED_BACKGROUND: AnsiColorName = "black";

function toSpan(entry: AnserJsonEntry): AnsiSpan {
  // Anser strips `reverse` from `decorations` and publishes `isInverted`, which its shipped
  // declaration omits, hence the `in` narrowing. A test fails if the pinned library stops.
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
 * A color name, or `undefined` for one the console does not reproduce. Anser types the class
 * as `string` but sets `null` when no color applies.
 */
function resolveColor(anserClass: string | null | undefined): AnsiColorName | undefined {
  if (anserClass === null || anserClass === undefined) {
    return undefined;
  }
  return COLOR_NAMES_BY_ANSER_CLASS.get(anserClass);
}
import { ANSI_SPAN_RENDER_CAP } from "../../cards/card-caps.js";
