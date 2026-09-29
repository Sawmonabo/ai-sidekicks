// The console's own shiki theme, and the token kinds it collapses to.
//
// The highlighter takes own theme JSON built from Meridian tokens, never the preset
// bundles, and a byte-bounded token cache. THIS MODULE ADDS THE PROPERTY THAT MAKES THAT
// CACHE WORK: the cache is theme-independent and content-addressed, token kinds are
// collapsed inside the theme rather than by a pass after it, and a test cross-checks
// the kinds against the theme CSS.
//
// HOW BOTH ARE TRUE AT ONCE. A shiki theme maps TextMate scopes to a foreground color,
// and a highlighter returns tokens carrying that color. If the color were a hex value
// the cache would hold LIGHT-scheme tokens, and a scheme switch would have to discard
// every entry — a theme-dependent cache wearing a content-addressed name.
//
// So this theme's foregrounds are not colors. Each is a CSS custom-property reference
// naming the token's KIND — `var(--meridian-code-keyword)` — so the collapse to
// kinds happens inside the theme rather than in a pass after it, a cached token is
// identical in both schemes, and the actual colors live in `tokens/palette.ts` where
// the rest of the Meridian palette does, emitted into the generated token sheet by
// `tokens/generate-css.ts` and measured against the code block's own ground by
// `tokens/contrast.test.ts`. Shiki's own `createCssVariablesTheme` is the same
// technique, and this is that technique with our own token-kind vocabulary rather than its
// variable names.
//
// THE TOKEN KINDS ARE A CLOSED SET, and review cross-checks that every
// member has a declaration in that generated sheet. That is the cross-check above: a
// kind added here without a color there renders as the sheet's fallback and reads as
// plain text, which is a silent failure a type cannot catch.

import type { ThemeRegistrationRaw } from "shiki/types";

/**
 * Every kind a highlighted token can belong to. Closed.
 *
 * Nine, and the grouping is deliberately coarser than a syntax theme's: the transcript is a
 * work log, and a code block inside it competes with the prose around it for a reader's
 * attention. Nine kinds are enough to make structure legible — what is a name, what
 * is a literal, what is an aside — and few enough that the block does not become the
 * loudest thing on the screen, which the console's whole color budget is spent avoiding
 * elsewhere.
 */
export const CODE_TOKEN_KINDS = [
  "plain",
  "keyword",
  "name",
  "string",
  "number",
  "comment",
  "type",
  "operator",
  "invalid",
] as const;

/** One token kind. Derived from the enumeration, never restated. */
export type CodeTokenKind = (typeof CODE_TOKEN_KINDS)[number];

/** The custom property a token kind's color is declared under, in one place. */
export function codeTokenVariableName(tokenKind: CodeTokenKind): string {
  return `--meridian-code-${tokenKind}`;
}

/** The value a theme foreground carries for a token kind — a reference, never a color. */
export function codeTokenColorReference(tokenKind: CodeTokenKind): string {
  return `var(${codeTokenVariableName(tokenKind)})`;
}

/**
 * Which TextMate scopes each token kind claims.
 *
 * Total over `CodeTokenKind` minus `plain`, which is the theme's own foreground and
 * therefore claims no scope: a token no rule matched IS plain, and giving it a rule
 * would be a second way to say the same thing.
 */
const SCOPES_BY_TOKEN_KIND: Readonly<Record<Exclude<CodeTokenKind, "plain">, readonly string[]>> = {
  keyword: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control"],
  name: ["entity.name.function", "support.function", "variable.function", "entity.name.tag"],
  string: ["string", "string.quoted", "constant.character.escape", "meta.embedded.string"],
  number: ["constant.numeric", "constant.language", "constant.other"],
  comment: ["comment", "punctuation.definition.comment"],
  type: ["entity.name.type", "entity.name.class", "support.type", "support.class"],
  operator: ["keyword.operator", "punctuation", "meta.brace", "punctuation.separator"],
  invalid: ["invalid", "invalid.illegal"],
};

/**
 * The theme, built fresh per call.
 *
 * A function rather than a module-level object because a highlighter takes ownership of
 * the theme it is given and normalizes it in place; two highlighters sharing one object
 * would be two owners of one mutable value, which is the module-scope singleton
 * `apps/desktop/AGENTS.md` rejects and which here would also be a real aliasing bug.
 */
export function buildCodeTheme(): ThemeRegistrationRaw {
  return {
    name: "meridian",
    // `type` is shiki's light/dark hint for its own color replacements. The theme is
    // neither: it carries no colors to replace, and the sheet answers the scheme.
    type: "dark",
    colors: { "editor.foreground": codeTokenColorReference("plain") },
    fg: codeTokenColorReference("plain"),
    bg: "transparent",
    settings: Object.entries(SCOPES_BY_TOKEN_KIND).map(([tokenKind, scopes]) => ({
      scope: [...scopes],
      settings: { foreground: codeTokenColorReference(tokenKind as CodeTokenKind) },
    })),
  };
}
