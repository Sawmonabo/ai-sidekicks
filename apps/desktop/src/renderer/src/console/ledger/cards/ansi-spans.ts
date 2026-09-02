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
// Reverse video IS reproduced, by swapping the two class names: it is a relation between
// the span's own two colours, so honouring it needs no palette the console lacks.

import Anser from "anser";

import { ANSI_SPAN_RENDER_CAP } from "./card-bounds.js";

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
  readonly foreground: AnsiColorName | undefined;
  readonly background: AnsiColorName | undefined;
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
    spans.push(toSpan(entry));
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
export function ansiColorClassName(channel: "fg" | "bg", color: AnsiColorName): string {
  return `meridian-ansi__${channel}--${color}`;
}

/** The class name a decoration renders under. */
export function ansiDecorationClassName(decoration: AnsiDecoration): string {
  return `meridian-ansi--${decoration}`;
}

/** Every class one span carries, in a stable order. */
export function ansiSpanClassNames(span: AnsiSpan): readonly string[] {
  const names: string[] = [];
  if (span.foreground !== undefined) {
    names.push(ansiColorClassName("fg", span.foreground));
  }
  if (span.background !== undefined) {
    names.push(ansiColorClassName("bg", span.background));
  }
  for (const decoration of span.decorations) {
    names.push(ansiDecorationClassName(decoration));
  }
  return names;
}

function toSpan(entry: AnserJsonEntry): AnsiSpan {
  const foreground = resolveColor(entry.fg);
  const background = resolveColor(entry.bg);
  // Reverse video is a relation between this span's own two colours, so the swap is
  // the whole of honouring it — and an unset side stays unset rather than becoming
  // some default the console would then have to choose.
  const isReversed = entry.decorations.includes("reverse");

  return {
    text: entry.content,
    foreground: isReversed ? background : foreground,
    background: isReversed ? foreground : background,
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
