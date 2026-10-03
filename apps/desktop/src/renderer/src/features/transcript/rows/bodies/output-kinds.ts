// Which renderer an agent's reply or a tool's result takes: its producer's declared media
// type first, then its bytes.

import { carriesAnsiEscapes } from "../ansi/escape-sequences.js";

/**
 * How a body is drawn once its bytes are in hand: `prose` is markdown, `command-output`
 * is ANSI, and `plain-text` interprets nothing.
 *
 * A body is never given a shape from its tool's name.
 */
export const OUTPUT_KINDS = ["prose", "plain-text", "command-output"] as const;

/** One body shape. */
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/** Declared media types rendered as markdown; `text/x-markdown` is an older spelling. */
const MARKDOWN_MEDIA_TYPES: readonly string[] = ["text/markdown", "text/x-markdown"];

/**
 * Which renderer a reply takes. A declaration wins: escape bytes in a declared markdown body are
 * residue the caller strips, and an unrecognized declaration (say `application/json`) takes the
 * plain arm. With no declaration, a body carrying an escape is command output and any other body
 * is prose.
 */
export function outputKindOf(body: string, declaredMediaType?: string | undefined): OutputKind {
  if (declaredMediaType !== undefined) {
    return MARKDOWN_MEDIA_TYPES.includes(declaredEssence(declaredMediaType))
      ? "prose"
      : "plain-text";
  }
  return carriesAnsiEscapes(body) ? "command-output" : "prose";
}

/**
 * Which renderer a tool's result takes. Its payload declares no media type, so a body carrying an
 * escape is command output and any other is shown verbatim, never parsed as markdown, so a line
 * like `# build` in a program's output stays the line it printed.
 */
export function toolOutputKindOf(body: string): OutputKind {
  return carriesAnsiEscapes(body) ? "command-output" : "plain-text";
}

/**
 * A media type's type and subtype, lowercased. The wire string arrives as the producer
 * spelled it (`text/markdown; charset=utf-8`, `TEXT/MARKDOWN`); parameters never bear on
 * the renderer, so they are dropped.
 */
function declaredEssence(declaredMediaType: string): string {
  const [essence = ""] = declaredMediaType.split(";");
  return essence.trim().toLowerCase();
}
