// The console's own shiki theme, and the token families it collapses to.
//
// `Spec-023 §Console Libraries`, syntax-highlighting row: "own theme JSON from Meridian
// tokens … never the preset bundles", with a "byte-bounded token cache". THIS MODULE
// ADDS THE PROPERTY THAT MAKES THAT CACHE WORK, because no committed document states
// it: the cache is theme-independent and content-addressed, token families are
// collapsed inside the theme rather than by a pass after it, and a test cross-checks
// the families against the theme CSS.
//
// HOW BOTH ARE TRUE AT ONCE. A shiki theme maps TextMate scopes to a foreground colour,
// and a highlighter returns tokens carrying that colour. If the colour were a hex value
// the cache would hold LIGHT-scheme tokens, and a scheme switch would have to discard
// every entry — a theme-dependent cache wearing a content-addressed name.
//
// So this theme's foregrounds are not colours. Each is a CSS custom-property reference
// naming the token's FAMILY — `var(--meridian-code-keyword)` — so the collapse to
// families happens inside the theme rather than in a pass after it, a cached token is
// identical in both schemes, and the actual colours live in `ledger/ledger.css` where
// the rest of the Meridian palette does. Shiki's own `createCssVariablesTheme` is the
// same technique, and this is that technique with our own family vocabulary rather than
// its variable names.
//
// THE FAMILIES ARE A CLOSED SET, and the architecture tier cross-checks that every
// member has a declaration in the family stylesheet. That is the cross-check above:
// a family added here without a colour there renders as the sheet's fallback and reads
// as plain text, which is a silent failure a type cannot catch.

import type { ThemeRegistrationRaw } from "shiki/types";

/**
 * Every family a highlighted token can belong to. Closed.
 *
 * Nine, and the grouping is deliberately coarser than a syntax theme's: the ledger is a
 * work log, and a code block inside it competes with the prose around it for a reader's
 * attention. Nine families are enough to make structure legible — what is a name, what
 * is a literal, what is an aside — and few enough that the block does not become the
 * loudest thing on the screen, which `Spec-023 §Console Design (Meridian)` rule 3 spends
 * the console's whole colour budget avoiding elsewhere.
 */
export const CODE_TOKEN_FAMILIES = [
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

/** One token family. Derived from the enumeration, never restated. */
export type CodeTokenFamily = (typeof CODE_TOKEN_FAMILIES)[number];

/**
 * The families whose colour is one of the console's own text tokens.
 *
 * They need no per-scheme declaration of their own, because the token they defer to
 * already swaps with the scheme. Listed rather than derived because deferring is a
 * DESIGN decision about a family, and stating the exception here makes the other
 * half a complement: a family added to the enumeration is coloured until somebody
 * says otherwise, so it arrives owing a declaration under both schemes rather than
 * silently rendering its light value on a dark ground.
 */
const NEUTRAL_CODE_TOKEN_FAMILIES = ["plain", "comment", "operator", "invalid"] as const;

/**
 * The families that carry a colour of their own, as the complement of the neutral set.
 *
 * The partition is what makes the stylesheet cross-check quantify over the DECLARED
 * enumeration rather than over a list a second file wrote out by hand — which is the
 * shape that stops covering a sixth coloured family the day one is added.
 */
export const COLOURED_CODE_TOKEN_FAMILIES: readonly CodeTokenFamily[] = CODE_TOKEN_FAMILIES.filter(
  (family): family is CodeTokenFamily =>
    !(NEUTRAL_CODE_TOKEN_FAMILIES as readonly string[]).includes(family),
);

/** The custom property a family's colour is declared under, in one place. */
export function codeTokenVariableName(family: CodeTokenFamily): string {
  return `--meridian-code-${family}`;
}

/** The value a theme foreground carries for a family — a reference, never a colour. */
export function codeTokenColorReference(family: CodeTokenFamily): string {
  return `var(${codeTokenVariableName(family)})`;
}

/**
 * Which TextMate scopes each family claims.
 *
 * Total over `CodeTokenFamily` minus `plain`, which is the theme's own foreground and
 * therefore claims no scope: a token no rule matched IS plain, and giving it a rule
 * would be a second way to say the same thing.
 */
const SCOPES_BY_FAMILY: Readonly<Record<Exclude<CodeTokenFamily, "plain">, readonly string[]>> = {
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
 * the theme it is given and normalises it in place; two highlighters sharing one object
 * would be two owners of one mutable value, which is the module-scope singleton
 * `apps/desktop/AGENTS.md` rejects and which here would also be a real aliasing bug.
 */
export function meridianCodeTheme(): ThemeRegistrationRaw {
  return {
    name: "meridian",
    // `type` is shiki's light/dark hint for its own colour replacements. The theme is
    // neither: it carries no colours to replace, and the sheet answers the scheme.
    type: "dark",
    colors: { "editor.foreground": codeTokenColorReference("plain") },
    fg: codeTokenColorReference("plain"),
    bg: "transparent",
    settings: Object.entries(SCOPES_BY_FAMILY).map(([family, scopes]) => ({
      scope: [...scopes],
      settings: { foreground: codeTokenColorReference(family as CodeTokenFamily) },
    })),
  };
}
