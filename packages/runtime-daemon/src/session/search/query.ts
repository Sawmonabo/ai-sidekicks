// Turns the text a person typed into the words the search index looks for and the tags it names.
// Every word goes to the index as typed, which tokenizes and folds it into a phrase, so a typed
// `-`, `*`, `:`, `AND`, `OR` or `NOT` stays text; the last word matches as a prefix while it is
// still being typed.

import { foldName } from "@ai-sidekicks/contracts/name-fold";
import type { SearchQuery } from "@ai-sidekicks/search-index";

/** What a search box query asks for: words for the index, and tags a session carries. */
export interface ParsedSearchQuery {
  /** The words the index looks for, `undefined` when the query names none. */
  readonly searchQuery: SearchQuery | undefined;
  /** Each `tag:<tag>` term's case fold; a session must carry each tag or one nested under it. */
  readonly tagFolds: readonly string[];
}

const TAG_TERM_PREFIX = "tag:";
// A word with no letter or digit holds no token, so it looks for nothing.
const TOKEN_CHARACTER = /[\p{L}\p{N}]/u;

/** Parses a `Search all sessions` query: `tag:<tag>` terms are tags, every other term a word. */
export function parseSessionSearchQuery(query: string): ParsedSearchQuery {
  const terms = splitTerms(query);
  const words: string[] = [];
  const tagFolds: string[] = [];
  for (const term of terms) {
    const tag = term.toLowerCase().startsWith(TAG_TERM_PREFIX)
      ? term.slice(TAG_TERM_PREFIX.length).replace(/\/+$/u, "")
      : undefined;
    if (tag === undefined) {
      words.push(term);
    } else if (tag.length > 0) {
      tagFolds.push(foldName(tag));
    }
  }
  return { searchQuery: searchQueryOfWords(words, terms, query), tagFolds };
}

/** The words of a find box query inside one session, where every term is a word. */
export function parseFindQuery(query: string): SearchQuery | undefined {
  const terms = splitTerms(query);
  return searchQueryOfWords(terms, terms, query);
}

function splitTerms(query: string): string[] {
  return query.split(/\s+/u).filter((term) => term.length > 0);
}

// The query's words that hold a token, from `wordTerms` among every one of its `terms`.
function searchQueryOfWords(
  wordTerms: readonly string[],
  terms: readonly string[],
  query: string,
): SearchQuery | undefined {
  const words = wordTerms.filter((term) => TOKEN_CHARACTER.test(term));
  if (words.length === 0) {
    return undefined;
  }
  // A query that ends in a space has finished its last word, and so has one whose last term is a
  // tag or holds no token.
  const lastWordIsPrefix = !/\s$/u.test(query) && words.at(-1) === terms.at(-1);
  return { words, lastWordIsPrefix };
}
