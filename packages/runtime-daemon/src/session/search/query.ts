// Turns the text a person typed into a full-text match expression and the tags it names. Every
// word is quoted as a phrase, so a typed `-`, `*`, `:`, `AND`, `OR` or `NOT` stays text and never
// becomes an index operator; the last word matches as a prefix while it is still being typed.

import { foldName } from "@ai-sidekicks/contracts/name-fold";

/** What a search box query asks for: words for the full-text index, and tags a session carries. */
export interface ParsedSearchQuery {
  /** The match expression over the words, `undefined` when the query names none. */
  readonly matchExpression: string | undefined;
  /** Each `tag:<tag>` term's case fold; a session must carry each tag or one nested under it. */
  readonly tagFolds: readonly string[];
}

const TAG_TERM_PREFIX = "tag:";
// A word with no letter or digit holds no token, and an empty phrase is an index syntax error.
const TOKEN_CHARACTER = /[\p{L}\p{N}]/u;

/** Parses a `Search all sessions` query: `tag:<tag>` terms are tags, every other term a word. */
export function parseSessionSearchQuery(query: string): ParsedSearchQuery {
  const words: string[] = [];
  const tagFolds: string[] = [];
  for (const term of splitTerms(query)) {
    const tag = term.toLowerCase().startsWith(TAG_TERM_PREFIX)
      ? term.slice(TAG_TERM_PREFIX.length).replace(/\/+$/u, "")
      : undefined;
    if (tag === undefined) {
      words.push(term);
    } else if (tag.length > 0) {
      tagFolds.push(foldName(tag));
    }
  }
  return { matchExpression: buildMatchExpression(words, query), tagFolds };
}

/** The match expression for a find box query inside one session, where every term is a word. */
export function matchExpressionOf(query: string): string | undefined {
  return buildMatchExpression(splitTerms(query), query);
}

function splitTerms(query: string): string[] {
  return query.split(/\s+/u).filter((term) => term.length > 0);
}

function buildMatchExpression(words: readonly string[], query: string): string | undefined {
  const phrases = words.filter((word) => TOKEN_CHARACTER.test(word));
  if (phrases.length === 0) {
    return undefined;
  }
  // A query that ends in a space has finished its last word.
  const isLastWordTyping = !/\s$/u.test(query) && phrases.at(-1) === words.at(-1);
  const terms = phrases.map((word, index) => {
    const phrase = `"${word.replaceAll('"', '""')}"`;
    return isLastWordTyping && index === phrases.length - 1 ? `${phrase}*` : phrase;
  });
  // Words match the text column alone, never a session's key.
  return `text : (${terms.join(" ")})`;
}
