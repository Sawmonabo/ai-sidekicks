// Maps `anser` runs onto spans that name palette colors, and parses a growing output a part at a
// time. Only `ansiToJson` is used: an HTML string built from tool output would have to be
// injected, which the transcript never does.
// Colors are names (`use_classes: true` reports `ansi-red`), not the tool's RGB values. Blink and
// conceal are not reproduced. A 256-color or true-color run takes the name whose color in the
// program's own palette sits nearest it in OKLab, so each scheme's token for that name draws it.

import Anser from "anser";

import { srgbToOklab, type OklabColor } from "#shared/color.js";
import { type PublishedText } from "../../reveal/published-text.js";
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

/**
 * Parses one command output into styled spans as it grows, reading only the text past what it
 * already parsed. The result is the same as one parse of the whole text: the same spans, classes
 * and text.
 *
 * The parsed part always ends where an `ESC [` begins. `anser` splits its input there, and every
 * run between two of them is one entry, so a cut anywhere else would split one run into two
 * spans, or end inside a sequence. Everything before the last `ESC [` is parsed once, on one
 * `anser` instance that carries the style (colors, decorations) from one part to the next exactly
 * as one whole-text parse carries it. The run from the last `ESC [` to the end can still grow, so
 * it is parsed again on each revision, from a copy of that instance's state.
 */
export class AnsiSpanParser {
  /** The spans of the parsed part. */
  readonly #parsedSpans: AnsiSpan[] = [];
  /** The `anser` instance standing where the parsed part ends, its style state carried. */
  #anser = new Anser();
  #parsed: ParsedText | undefined;

  /**
   * The spans of `text` as it stands. The parsed part is kept while `text` is the handle last read
   * and still begins with it and the `ESC [` after it; a different handle or a rewrite below that
   * parses from the start.
   */
  public read(text: PublishedText): readonly AnsiSpan[] {
    if (!this.#continues(text)) {
      this.#reset();
    }
    const parsedLength = this.#parsed?.length ?? 0;
    const unparsed = text.slice(parsedLength);
    // With no `ESC [` past its first character, the unparsed text is one run and none of it final.
    const runStart = Math.max(0, unparsed.lastIndexOf(CONTROL_SEQUENCE_INTRODUCER));
    if (runStart > 0) {
      appendSpans(
        this.#anser.ansiToJson(unparsed.slice(0, runStart), anserOptions()),
        this.#parsedSpans,
      );
    }
    this.#parsed = { text, revision: text.revision, length: parsedLength + runStart };

    const spans = [...this.#parsedSpans];
    appendSpans(copyOf(this.#anser).ansiToJson(unparsed.slice(runStart), anserOptions()), spans);
    return spans;
  }

  /** Whether the parsed part still stands for `text`. */
  #continues(text: PublishedText): boolean {
    const parsed = this.#parsed;
    return (
      parsed !== undefined &&
      parsed.text === text &&
      // The `ESC [` the parsed part ends before must stand too: the next part is parsed as
      // starting with it, so a rewrite of those two characters alone still parses from the start.
      text.keepsPrefix(parsed.revision, parsed.length + CONTROL_SEQUENCE_INTRODUCER.length)
    );
  }

  #reset(): void {
    this.#anser = new Anser();
    this.#parsedSpans.length = 0;
    this.#parsed = undefined;
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
      foreground: resolveColor(entry.fg, entry.fg_truecolor),
      background: resolveColor(entry.bg, entry.bg_truecolor),
      reversed: false,
      decorations: entry.decorations.filter(isReproducedAnsiDecoration),
    };
  }

  // Anser already swapped: its `fg` holds the stream's background and its `bg` the stream's
  // foreground. Undo that so the span reports what the stream said.
  const streamBackground = resolveColor(entry.fg, entry.fg_truecolor);
  const streamForeground = resolveColor(entry.bg, entry.bg_truecolor);

  return {
    text: entry.content,
    foreground: streamForeground === ANSER_SUBSTITUTED_FOREGROUND ? undefined : streamForeground,
    background: streamBackground === ANSER_SUBSTITUTED_BACKGROUND ? undefined : streamBackground,
    reversed: true,
    decorations: entry.decorations.filter(isReproducedAnsiDecoration),
  };
}

/**
 * The color name a channel draws in: its own for one of the sixteen, the nearest one for a palette
 * index past them or a true color (`trueColor`, anser's `r, g, b`), and `undefined` for none.
 * Anser types both as `string` but sets `null` when no color applies.
 */
function resolveColor(
  anserClass: string | null | undefined,
  trueColor: string | null | undefined,
): AnsiColorName | undefined {
  if (anserClass === null || anserClass === undefined) {
    return undefined;
  }
  if (anserClass === ANSER_TRUE_COLOR_CLASS) {
    return trueColor === null || trueColor === undefined
      ? undefined
      : nearestColorName(oklabOf(trueColor));
  }
  if (anserClass.startsWith(ANSER_PALETTE_CLASS_PREFIX)) {
    const paletteColor = XTERM_PALETTE[Number(anserClass.slice(ANSER_PALETTE_CLASS_PREFIX.length))];
    return paletteColor === undefined ? undefined : nearestColorName(oklabOf(paletteColor));
  }
  return COLOR_NAMES_BY_ANSER_CLASS.get(anserClass);
}

/** The class anser reports for a true color, whose value it carries beside the class. */
const ANSER_TRUE_COLOR_CLASS = "ansi-truecolor";

/** The class prefix anser reports for a 256-color index from 16 on, before the index. */
const ANSER_PALETTE_CLASS_PREFIX = "ansi-palette-";

/**
 * The 256-color palette as anser defines it, one `r, g, b` per index: the sixteen names' own
 * colors first, then the 6x6x6 cube and the gray ramp.
 */
const XTERM_PALETTE: readonly string[] = readXtermPalette();

/** Each of the sixteen names with its palette color in OKLab, in palette order. */
const COLOR_NAME_POINTS: readonly { readonly name: AnsiColorName; readonly color: OklabColor }[] =
  ANSI_COLOR_NAMES.map((name, index) => ({ name, color: oklabOf(XTERM_PALETTE[index] ?? "") }));

function readXtermPalette(): readonly string[] {
  const anser = new Anser();
  anser.setupPalette();
  // `setupPalette` fills `PALETTE_COLORS`, which anser's shipped declaration omits.
  const palette: unknown = "PALETTE_COLORS" in anser ? anser.PALETTE_COLORS : undefined;
  if (!Array.isArray(palette) || palette.length !== 256) {
    throw new Error("anser no longer builds its 256-color palette in PALETTE_COLORS");
  }
  return palette.map(String);
}

/** Anser's `r, g, b` (each 0-255) in OKLab. */
function oklabOf(channels: string): OklabColor {
  const [red = 0, green = 0, blue = 0] = channels
    .split(",")
    .map((channel) => Number(channel) / 255);
  return srgbToOklab({ red, green, blue });
}

/**
 * The name whose palette color sits nearest `color`. Anser gives white and bright white the same
 * value, and the later name wins a tie, so pure white draws as bright white.
 */
function nearestColorName(color: OklabColor): AnsiColorName {
  let nearest: AnsiColorName = "white";
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const point of COLOR_NAME_POINTS) {
    const distance = Math.hypot(
      point.color.lightness - color.lightness,
      point.color.greenRed - color.greenRed,
      point.color.blueYellow - color.blueYellow,
    );
    if (distance <= nearestDistance) {
      nearest = point.name;
      nearestDistance = distance;
    }
  }
  return nearest;
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

/** Appends the spans of `entries` to `spans`, skipping the empty entries. */
function appendSpans(entries: readonly AnserJsonEntry[], spans: AnsiSpan[]): void {
  for (const entry of entries) {
    if (entry.content === "") {
      continue;
    }
    const span = toSpan(entry);
    // Anser leaves OSC and two-byte escapes inside a chunk; strip them before they become text.
    spans.push({ ...span, text: withoutResidualEscapes(span.text) });
  }
}

/**
 * A new `anser` instance in the same style state, so parsing the last run leaves the original
 * where the parsed part ends. `anser` keeps that state in the instance's own fields and changes
 * its decorations list in place, so the copy is deep.
 */
function copyOf(anser: Anser): Anser {
  return Object.assign(new Anser(), structuredClone(anser));
}
