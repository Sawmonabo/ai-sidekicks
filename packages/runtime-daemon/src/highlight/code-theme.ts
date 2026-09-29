// The colorer's theme: which TextMate scopes paint as which span class.
//
// A shiki theme maps scopes to a foreground, and the highlighter hands each
// token the foreground its scopes resolve to. Here a foreground is not a color
// but the name of a span class, so the class falls out of the theme's own scope
// resolution and the colors stay with the surface that paints them. A token
// that resolves to the theme's own foreground is plain and carries no span.
import { HIGHLIGHT_SPAN_CLASSES, type HighlightSpanClass } from "@ai-sidekicks/contracts";
import type { ThemeRegistrationRaw } from "shiki/types";

/** The name the highlighter knows this theme by. */
export const CODE_THEME_NAME = "span-classes";

/** The foreground of text no class claims. */
const PLAIN_FOREGROUND = "plain";

/**
 * Which scopes each span class claims. Types and classes read as names. The
 * quotes around a string and the marks that open a comment paint with what
 * they enclose.
 */
const SCOPES_BY_SPAN_CLASS: Readonly<Record<HighlightSpanClass, readonly string[]>> = {
  keyword: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control"],
  name: [
    "entity.name.function",
    "support.function",
    "variable.function",
    "entity.name.tag",
    "entity.name.type",
    "entity.name.class",
    "support.type",
    "support.class",
  ],
  string: [
    "string",
    "string.quoted",
    "punctuation.definition.string",
    "constant.character.escape",
    "meta.embedded.string",
  ],
  number: ["constant.numeric", "constant.language", "constant.other"],
  comment: ["comment", "punctuation.definition.comment"],
};

/**
 * Scopes a broader class rule would otherwise claim that stay plain: an
 * operator is not a keyword, and punctuation and braces read as the text
 * around them.
 */
const PLAIN_SCOPES: readonly string[] = ["keyword.operator", "punctuation", "meta.brace"];

/**
 * The theme, built fresh per highlighter: a highlighter normalizes the theme it
 * is given in place.
 */
export function buildCodeTheme(): ThemeRegistrationRaw {
  return {
    name: CODE_THEME_NAME,
    type: "dark",
    fg: PLAIN_FOREGROUND,
    bg: "transparent",
    settings: [
      { scope: [...PLAIN_SCOPES], settings: { foreground: PLAIN_FOREGROUND } },
      ...HIGHLIGHT_SPAN_CLASSES.map((spanClass) => ({
        scope: [...SCOPES_BY_SPAN_CLASS[spanClass]],
        settings: { foreground: spanClass },
      })),
    ],
  };
}

const SPAN_CLASS_INDEX_BY_FOREGROUND: ReadonlyMap<string, number> = new Map(
  HIGHLIGHT_SPAN_CLASSES.map((spanClass, index) => [spanClass, index]),
);

/** The wire index of the class a token's foreground names, or `undefined` for plain text. */
export function spanClassIndexOf(foreground: string | undefined): number | undefined {
  return foreground === undefined ? undefined : SPAN_CLASS_INDEX_BY_FOREGROUND.get(foreground);
}
