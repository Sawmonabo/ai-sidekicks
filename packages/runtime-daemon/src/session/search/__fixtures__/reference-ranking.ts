// The hits an FTS5 index ranks over the same rows, the reference the search index's pages are held
// to, built only inside a test: an in-memory FTS5 table with the tokenizer `unicode61
// remove_diacritics 2`, each row at its index key beside one constant token, so a row's length is
// its token count plus one, as the index counts it. Rows rank by `rank` then key; a session is
// placed by its best row, and a group's name counts toward each member in session id order. A
// query's tags keep the sessions carrying each tag or one nested under it, with the rank unchanged.

import Database from "better-sqlite3";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type {
  SessionSearchCursor,
  SessionSearchRequest,
  SessionSearchResponse,
} from "@ai-sidekicks/contracts/session/methods";
import { foldName } from "@ai-sidekicks/contracts/name-fold";
import type { SearchQuery } from "@ai-sidekicks/search-index";

import { indexRowKindOf } from "../index/columns.js";
import { parseSessionSearchQuery } from "../query.js";
import type { DirectoryRow } from "./seeded-directory.js";

// A token no query of the tests reaches, standing for the owner the index keeps beside the text.
const OWNER_TOKEN = "zzowner";

/** A hit as a page shows it: its session, where it opens, and its line. */
export interface ShownHit {
  readonly sessionId: SessionId;
  readonly cursor: string;
  readonly line: string;
}

// Every hit an FTS5 index ranks for `query` over `rows`, sessions by best hit, hits together.
function referenceHits(rows: readonly DirectoryRow[], query: SearchQuery): ShownHit[] {
  const reference = new Database(":memory:");
  try {
    reference.exec(
      `CREATE VIRTUAL TABLE reference
         USING fts5(text, owner, tokenize = 'unicode61 remove_diacritics 2')`,
    );
    const insert = reference.prepare("INSERT INTO reference (rowid, text, owner) VALUES (?, ?, ?)");
    for (const row of rows) {
      insert.run(row.key, row.text, OWNER_TOKEN);
    }
    const rankedKeys = reference
      .prepare<
        [string],
        number
      >("SELECT rowid FROM reference WHERE reference MATCH ? ORDER BY rank, rowid")
      .pluck()
      .all(matchExpressionOf(query));
    const rowsByKey = new Map(rows.map((row) => [row.key, row]));
    const hitsBySession = new Map<SessionId, ShownHit[]>();
    for (const key of rankedKeys) {
      const row = rowsByKey.get(key)!;
      for (const sessionId of row.sessionIds) {
        const hits = hitsBySession.get(sessionId) ?? [];
        hits.push({ sessionId, cursor: row.cursor, line: row.text });
        hitsBySession.set(sessionId, hits);
      }
    }
    return [...hitsBySession.values()].flat();
  } finally {
    reference.close();
  }
}

// The sessions carrying every one of `tagFolds`' tags, or one nested under it.
function sessionsTagged(
  rows: readonly DirectoryRow[],
  tagFolds: readonly string[],
): Set<SessionId> {
  const carrying = tagFolds.map((tagFold) => {
    const sessionIds = new Set<SessionId>();
    for (const row of rows) {
      const fold = foldName(row.text);
      if (
        indexRowKindOf(row.key) === "tag" &&
        (fold === tagFold || fold.startsWith(`${tagFold}/`))
      ) {
        row.sessionIds.forEach((sessionId) => sessionIds.add(sessionId));
      }
    }
    return sessionIds;
  });
  const [first = new Set<SessionId>(), ...others] = carrying;
  return new Set([...first].filter((sessionId) => others.every((other) => other.has(sessionId))));
}

// The seeded directory's query classes: one common word, two words, a word still being typed, a
// folded accent, a tool call's arguments, a finished word in group names and titles, and words
// within a tag, nested tags included, written in any case, with a word still being typed, and
// within two tags.
const REFERENCE_QUERIES = [
  "deploy",
  "billing stripe",
  "re",
  "cafe",
  "git commit",
  "notes ",
  "tag:billing deploy",
  "tag:BILLING re",
  "tag:deploy git commit",
  "tag:billing tag:infra worker",
];
// Small pages, so every query pages many times.
const REFERENCE_PAGE_LIMIT = 3;

/** Each reference query's hits across every page `search` answers, by query. */
export function hitsByQuery(
  search: (request: SessionSearchRequest) => SessionSearchResponse,
): Record<string, ShownHit[]> {
  return Object.fromEntries(
    REFERENCE_QUERIES.map((query) => [
      query,
      readEveryHit(search, { query, limit: REFERENCE_PAGE_LIMIT }),
    ]),
  );
}

/** Each reference query's hits as an FTS5 index ranks `rows`, by query. */
export function referenceHitsByQuery(rows: readonly DirectoryRow[]): Record<string, ShownHit[]> {
  return Object.fromEntries(
    REFERENCE_QUERIES.map((query) => {
      const { searchQuery, tagFolds } = parseSessionSearchQuery(query);
      if (searchQuery === undefined) {
        throw new Error(`The reference query "${query}" names no word.`);
      }
      const hits = referenceHits(rows, searchQuery);
      if (tagFolds.length === 0) {
        return [query, hits];
      }
      const tagged = sessionsTagged(rows, tagFolds);
      return [query, hits.filter((hit) => tagged.has(hit.sessionId))];
    }),
  );
}

/** Every hit of every page of `request`, in page order, each page continued from the last. */
export function readEveryHit(
  search: (request: SessionSearchRequest) => SessionSearchResponse,
  request: SessionSearchRequest,
): ShownHit[] {
  const hits: ShownHit[] = [];
  let afterCursor: SessionSearchCursor | undefined;
  // A search that never reaches its last page fails rather than running on.
  for (let pageCount = 0; pageCount < 1_000; pageCount += 1) {
    const page = search(afterCursor === undefined ? request : { ...request, afterCursor });
    for (const group of page.groups) {
      for (const hit of group.hits) {
        hits.push({ sessionId: group.sessionId, cursor: hit.cursor, line: hit.line });
      }
    }
    if (!page.hasMore) {
      return hits;
    }
    afterCursor = page.nextCursor;
  }
  throw new Error("The search did not reach its last page in 1,000 pages.");
}

// Each word a quoted phrase, the last a prefix while it is typed.
function matchExpressionOf(query: SearchQuery): string {
  return query.words
    .map((word, place) => {
      const phrase = `"${word.replaceAll('"', '""')}"`;
      return place === query.words.length - 1 && query.lastWordIsPrefix ? `${phrase}*` : phrase;
    })
    .join(" ");
}
