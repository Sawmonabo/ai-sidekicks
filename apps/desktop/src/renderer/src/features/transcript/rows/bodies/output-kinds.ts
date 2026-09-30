// Which renderer an agent's reply or a tool's result takes: its producer's declared media
// type first, then its bytes.

import { carriesAnsiEscapes } from "../ansi/escape-sequences.js";

/**
 * How a body is drawn once its bytes are in hand: `prose` is markdown, `command-output`
 * is ANSI, and `plain-text` interprets nothing.
 *
 * `plain-text` is reached only from a declared media type, never inferred, so a body
 * nobody described is never given a shape from its tool's name.
 */
export const OUTPUT_KINDS = ["prose", "plain-text", "command-output"] as const;

/** One body shape. */
export type OutputKind = (typeof OUTPUT_KINDS)[number];

/** Declared media types rendered as markdown; `text/x-markdown` is an older spelling. */
const MARKDOWN_MEDIA_TYPES: readonly string[] = ["text/markdown", "text/x-markdown"];

/**
 * Which renderer a body takes. A declaration wins: escape bytes in a declared markdown body are
 * residue the caller strips, and an unrecognized declaration (say `application/json`) takes the
 * plain arm. With no declaration, as for every tool result, a body carrying an escape is
 * command output and any other body is prose.
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
 * A media type's type and subtype, lowercased. The wire string arrives as the producer
 * spelled it (`text/markdown; charset=utf-8`, `TEXT/MARKDOWN`); parameters never bear on
 * the renderer, so they are dropped.
 */
function declaredEssence(declaredMediaType: string): string {
  const [essence = ""] = declaredMediaType.split(";");
  return essence.trim().toLowerCase();
}
