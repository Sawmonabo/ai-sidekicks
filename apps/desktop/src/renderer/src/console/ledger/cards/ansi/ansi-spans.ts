// ANSI command output, as spans — the mapper, with no HTML string anywhere on the path.
//
// `Spec-023 §Console Libraries`' ANSI row is ADOPT-with-constraints: "`anser`
// (`ansiToJson` only, own span mapper, never an HTML-string path)". This module is the
// own span mapper, and the constraint is the whole reason it exists — `ansiToHtml`
// would hand the console a markup string to inject, which is the one thing the ledger
// never does with content a tool produced.
//
// THE COLOURS ARE NAMES, NOT VALUES. The parse runs with `use_classes: true`, so anser
// reports `ansi-red` rather than `rgb(187, 0, 0)` — a NAME the console resolves through
// its own palette, exactly as the code highlighter resolves token families. A tool that
// prints red gets the console's red, which is legible on both schemes and is the same
// red every other failure in the surface uses. Resolved triples would put a stranger's
// palette inside a console whose two-hue rule is the reason its surfaces read at all.
//
// WHAT IS DELIBERATELY NOT REPRODUCED, and why each is a decision rather than a gap:
//
//   • **Blink.** `Spec-023 §Console Design (Meridian)`'s motion rule admits opacity and
//     2-4 px translation and nothing else; a blinking span is neither, and a console
//     that let a tool's bytes start an animation would have handed the surface's motion
//     budget to a subprocess.
//   • **Conceal.** A console that hid bytes a tool printed would be misreporting what
//     ran. The text renders; nothing about it is hidden.
//   • **256-colour and true-colour.** `ansi-palette-N` and `ansi-truecolor` carry values
//     from the tool's own palette, and the console has no honest mapping onto its
//     twelve-step wheel. Such a span renders in the inherited foreground — the same
//     answer an unrecognized enum member gets everywhere else in this console, and never
//     a nearest-neighbour guess.
//
// Reverse video IS reproduced, by swapping the two channels at render. It is a relation
// between the two colours a span paints, so honouring it needs no palette the console
// lacks — only the console's OWN default pair for whichever channel the stream left
// unset, which is what `ANSI_DEFAULT_COLORS` names and `tokens/palette.ts` resolves.

import Anser from "anser";

import { ANSI_SPAN_RENDER_CAP } from "../card-bounds.js";
import { withoutResidualEscapes } from "./escape-sequences.js";

/**
 * One parsed run, as the library reports it.
 *
 * Derived from the function's own return type rather than reached through the
 * package's declaration namespace: `anser` publishes `export = Anser`, a class and
 * namespace merged, and the namespace half is not reliably in scope through a default
 * import under `verbatimModuleSyntax`. Deriving it means the alias cannot drift from
 * what `ansiToJson` actually returns.
 */
type AnserJsonEntry = ReturnType<typeof Anser.ansiToJson>[number];

/**
 * The sixteen colour names anser reports under `use_classes`, without their
 * `ansi-` prefix. Closed, and closed against the library's own table.
 */
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

/** One ANSI colour name. Derived from the enumeration, never restated. */
export type AnsiColorName = (typeof ANSI_COLOR_NAMES)[number];

/**
 * The console's own two defaults, as channel values a span can paint.
 *
 * They exist for exactly one caller: reverse video. A stream that reverses without having
 * set both colours is reversing against the terminal's defaults, so honouring it needs a
 * name for "the colour this body paints when the stream says nothing" on each channel.
 * These are those names, and `tokens/palette.ts` binds them, as aliases, to the same
 * two tokens the body itself reads — so the swap resolves to what the reader is
 * actually looking at rather than to a second opinion about it.
 *
 * A span the stream did not reverse never carries one: an unset channel inherits, which
 * is a weaker claim than painting a token and is the right one to make.
 */
export const ANSI_DEFAULT_COLORS = ["default-foreground", "default-background"] as const;

/** One console default, as a channel value. Derived from the enumeration. */
export type AnsiDefaultColor = (typeof ANSI_DEFAULT_COLORS)[number];

/** Everything one channel can paint: a stream's colour, or the console's own default. */
export type AnsiRenderedColor = AnsiColorName | AnsiDefaultColor;

/**
 * The decorations the console reproduces. Closed, and SMALLER than anser's own set
 * for the reasons in this file's header — `blink` and `hidden` are absent by
 * decision and their absence is asserted by a test, so a later widening is a
 * deliberate act rather than a merge.
 */
export const ANSI_DECORATIONS = ["bold", "dim", "italic", "underline", "strikethrough"] as const;

/** One reproduced decoration. Derived from the enumeration, never restated. */
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
   * Whether the stream asked for reverse video over this run.
   *
   * Carried rather than folded into the two channels above, because the fold is lossy
   * exactly where it matters: a reversed run that set neither colour has nothing to
   * swap, and only the console — which knows what its own body paints — can say what
   * the two ends of that swap are. `ansiSpanClassNames` is where it knows.
   */
  readonly reversed: boolean;
  readonly decorations: readonly AnsiDecoration[];
}

/** What one parse produced, and what it had to leave out. */
export interface AnsiSpanSequence {
  readonly spans: readonly AnsiSpan[];
  /**
   * How many further spans the source held past the cap this parse ran under.
   *
   * Reported rather than dropped silently: a truncated render that says nothing is
   * indistinguishable from a tool that stopped printing, and `Nothing` exists so the
   * card can say which one this is.
   *
   * IT COUNTS RUNS THAT WOULD HAVE BECOME SPANS, and only those. The parse skips the
   * empty-content entries anser emits around a bare escape sequence, so a figure taken
   * as `entries.length - spans.length` charges the reader for runs that were never
   * withheld — it would say a hundred further runs are not shown when the tail holds
   * ten and ninety escape boundaries.
   */
  readonly elidedSpanCount: number;
}

const COLOR_NAMES_BY_ANSER_CLASS: ReadonlyMap<string, AnsiColorName> = new Map(
  ANSI_COLOR_NAMES.map((name) => [`ansi-${name}`, name] as const),
);

const REPRODUCED_DECORATIONS: ReadonlySet<string> = new Set<string>(ANSI_DECORATIONS);

/**
 * Parse ANSI text into styled spans, up to a cap.
 *
 * `remove_empty` drops the zero-length runs anser emits around a bare escape sequence,
 * which would otherwise render as empty elements the accessibility tree still walks.
 *
 * THE CAP IS A PARAMETER rather than a constant this module reads, because the fold it
 * produces is recoverable: a caller that has been asked for the rest re-parses the same
 * source under a cap that admits it. `ANSI_SPAN_RENDER_CAP` is the default, so a caller
 * that has not been asked spends exactly what it spent before.
 *
 * The loop runs to the end of the entries once the cap is reached rather than returning
 * there: the remainder still has to be COUNTED, and it is counted over the same skip the
 * admitted half was built through. Walking an array anser has already materialised is
 * the cheap half of this function.
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
    // The residue anser left inside the chunk, removed before it can become a text
    // node. `escape-sequences.ts` states why it happens after the parse and not before.
    spans.push({ ...span, text: withoutResidualEscapes(span.text) });
  }

  return { spans, elidedSpanCount };
}

/**
 * Whether a decoration is one the console reproduces.
 *
 * Exported because the negative half of the rule — that `blink` and `hidden` are not
 * reproduced — is the part worth asserting, and a test that reimplemented the check
 * would be asserting itself.
 */
export function isReproducedAnsiDecoration(decoration: string): decoration is AnsiDecoration {
  return REPRODUCED_DECORATIONS.has(decoration);
}

/** The class name a foreground or background colour renders under. */
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
 * THE REVERSE-VIDEO SWAP HAPPENS HERE, and not in the parse, because a swap needs both
 * ends and a stream that reversed without setting both colours supplied only one of them
 * — or neither, which `ESC[7m` on its own is and which is the common case. The missing
 * end is the console's own default for the OTHER channel, a fact that lives with the
 * class names and the tokens rather than with the parser.
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
 * The two colour names anser substitutes for a channel the stream left unset, just
 * before it performs its own reverse swap: white for the foreground, black for the
 * background, its reading of a conventional terminal's defaults.
 *
 * They are undone rather than rendered. The console binds `black` and `white` to two
 * points on its READING scale, so a run that reached the surface carrying anser's pair
 * would paint muted grey on faint grey — a substitution that is invisible in this
 * console and reversed in none.
 *
 * UNDOING THEM IS AMBIGUOUS AT EXACTLY TWO INPUTS, and the ambiguity is accepted rather
 * than hidden: an explicit `ESC[40m` under reverse is indistinguishable from a
 * substituted background, and an explicit `ESC[37m` from a substituted foreground. Both
 * collapse onto the console's default for that channel, which is what the terminal the
 * stream was written for would have shown, since there black IS the default background
 * and white IS the default foreground. Telling them apart would mean running the SGR
 * state machine a second time beside the library that already runs it.
 */
const ANSER_SUBSTITUTED_FOREGROUND: AnsiColorName = "white";
const ANSER_SUBSTITUTED_BACKGROUND: AnsiColorName = "black";

function toSpan(entry: AnserJsonEntry): AnsiSpan {
  // Anser strips `reverse` from `decorations` and publishes the state as `isInverted`
  // instead, so reading the decoration list for it finds nothing, always. The member is
  // absent from the shipped declaration, so it is reached through an `in` narrowing —
  // no cast — and the test "reads reverse video from the flag anser actually publishes"
  // fails the moment the pinned library stops setting it.
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

  // Anser has already swapped, so its `fg` holds what the stream set as the background
  // and its `bg` what the stream set as the foreground. Both are undone here so the span
  // reports what the STREAM said; `ansiSpanClassNames` re-applies the swap where the
  // console's own defaults are known.
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
 * A colour name, or `undefined` for one the console does not reproduce.
 *
 * The typed member is `string`, and anser sets it to `null` when no colour applies —
 * so the guard is a real narrowing rather than a formality.
 */
function resolveColor(anserClass: string | null | undefined): AnsiColorName | undefined {
  if (anserClass === null || anserClass === undefined) {
    return undefined;
  }
  return COLOR_NAMES_BY_ANSER_CLASS.get(anserClass);
}
