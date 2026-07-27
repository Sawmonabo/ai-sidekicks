// node:test suite for lib/gh-api.mjs.
// Run via:
//   node --test --experimental-strip-types '.claude/skills/plan-execution/scripts/__tests__/**/*.test.mjs'
//
// Both behaviours here are unit-tested rather than probed against live PRs
// because neither is reachable from real data: every endpoint codex-gate.mjs
// paginates is array-typed (so the object-page shape never arrives), and both
// GraphQL connections drain in one page on any PR in this repo (so the
// truncation path never runs either).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  drainConnection,
  flattenSlurpedPages,
  parseGhJson,
  MAX_CONNECTION_PAGES,
} from "../lib/gh-api.mjs";

// ------------------------------------------------------------- parseGhJson

test("a single top-level array parses unchanged", () => {
  assert.deepEqual(parseGhJson('[{"id":1},{"id":2}]'), [{ id: 1 }, { id: 2 }]);
});

test("a single top-level object parses unchanged and is NOT wrapped", () => {
  assert.deepEqual(parseGhJson('{"nameWithOwner":"o/r"}'), { nameWithOwner: "o/r" });
});

test("empty and whitespace-only output is null, not a throw", () => {
  assert.equal(parseGhJson(""), null);
  assert.equal(parseGhJson("   \n\t "), null);
  assert.equal(parseGhJson(undefined), null);
});

test("genuinely malformed JSON throws — it is never swallowed", () => {
  assert.throws(() => parseGhJson('{"a":'), SyntaxError);
  assert.throws(() => parseGhJson("not json at all"), SyntaxError);
  assert.throws(() => parseGhJson('[{"id":1}] oops'), SyntaxError);
});

test("a concatenated page stream throws — which is why paginated calls use --slurp", () => {
  // The shape an OBJECT-typed endpoint emits under bare `--paginate`
  // (`search/issues` produces 60 of these joins). Nothing here tries to absorb
  // it: routing every paginated call through `--slurp` is what prevents it, and
  // a call site that forgot should fail loudly rather than parse to a guess.
  assert.throws(
    () => parseGhJson('{"total_count":2,"page":1}{"total_count":2,"page":2}'),
    SyntaxError,
  );
});

// ------------------------------------------------------ flattenSlurpedPages

test("multi-page array output flattens to the concatenated rows", () => {
  // Live shape: `pulls/259/comments?per_page=1 --paginate --slurp` → 9 pages,
  // each a 1-element array (probed 2026-07-27, gh v2.92.0).
  assert.deepEqual(flattenSlurpedPages([[{ id: 1 }], [{ id: 2 }], [{ id: 3 }]]), [
    { id: 1 },
    { id: 2 },
    { id: 3 },
  ]);
});

test("single-page array output needs no special branch", () => {
  // `--slurp` wraps even one page, so the same `.flat()` unwraps it.
  assert.deepEqual(flattenSlurpedPages([[{ id: 1 }]]), [{ id: 1 }]);
});

test("object-typed pages survive as an array of page objects", () => {
  // The shape that defeats a bare JSON.parse. Flattening leaves objects alone,
  // so the caller receives one entry per page instead of a crash.
  assert.deepEqual(
    flattenSlurpedPages([
      { total_count: 2, page: 1 },
      { total_count: 2, page: 2 },
    ]),
    [
      { total_count: 2, page: 1 },
      { total_count: 2, page: 2 },
    ],
  );
});

test("empty pages contribute nothing", () => {
  assert.deepEqual(flattenSlurpedPages([[], [{ id: 1 }], []]), [{ id: 1 }]);
});

test("a slurp of zero pages is an empty row list", () => {
  assert.deepEqual(flattenSlurpedPages([]), []);
});

test("flattening is depth-1: rows that are themselves arrays stay intact", () => {
  // Guards the difference between stripping the page level and stripping one
  // level too many, which would silently merge adjacent rows.
  assert.deepEqual(flattenSlurpedPages([[[1, 2]], [[3]]]), [[1, 2], [3]]);
});

test("absent output is an empty row list, not a throw", () => {
  // `gh` prints nothing for a call with no body; parseGhJson turns that into
  // null, and zero rows is the honest reading of it.
  assert.deepEqual(flattenSlurpedPages(null), []);
  assert.deepEqual(flattenSlurpedPages(undefined), []);
});

test("a payload that is not page-wrapped throws rather than reading as zero rows", () => {
  // Would mean `--slurp` stopped wrapping. Returning [] instead would report an
  // un-acked, thread-free, reaction-free PR — a silent false negative on every
  // ack leg at once.
  assert.throws(() => flattenSlurpedPages({ id: 1 }), TypeError);
  assert.throws(() => flattenSlurpedPages("rows"), TypeError);
});

// --------------------------------------------------------- drainConnection

/** Build a fetchPage stub over fixed pages, recording the cursors it was called with. */
function pagedFetcher(pages) {
  const cursors = [];
  const fetchPage = (cursor) => {
    cursors.push(cursor);
    return pages[cursors.length - 1];
  };
  return { fetchPage, cursors };
}

function page(nodes, { totalCount, hasNextPage = false, endCursor = null }) {
  return { totalCount, nodes, pageInfo: { hasNextPage, endCursor } };
}

test("a single complete page is not truncated", () => {
  const { fetchPage, cursors } = pagedFetcher([page([1, 2, 3], { totalCount: 3 })]);
  const result = drainConnection(fetchPage);
  assert.deepEqual(result.nodes, [1, 2, 3]);
  assert.equal(result.totalCount, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(cursors, [null], "the first page must be requested without a cursor");
});

test("multiple pages drain in order and thread the cursor forward", () => {
  const { fetchPage, cursors } = pagedFetcher([
    page([1, 2], { totalCount: 5, hasNextPage: true, endCursor: "c1" }),
    page([3, 4], { totalCount: 5, hasNextPage: true, endCursor: "c2" }),
    page([5], { totalCount: 5 }),
  ]);
  const result = drainConnection(fetchPage);
  assert.deepEqual(result.nodes, [1, 2, 3, 4, 5]);
  assert.equal(result.truncated, false);
  assert.deepEqual(cursors, [null, "c1", "c2"]);
});

test("hasNextPage with no endCursor stops the walk and reports truncation", () => {
  // The walk cannot advance, so the shortfall against totalCount must fail closed
  // rather than silently returning a partial node set as if it were complete.
  const { fetchPage } = pagedFetcher([
    page([1, 2], { totalCount: 9, hasNextPage: true, endCursor: null }),
  ]);
  const result = drainConnection(fetchPage);
  assert.deepEqual(result.nodes, [1, 2]);
  assert.equal(result.truncated, true);
});

test("a connection longer than the page ceiling reports truncation", () => {
  const endlessPage = (cursor) => {
    void cursor;
    return page([1], { totalCount: 10_000, hasNextPage: true, endCursor: "next" });
  };
  const result = drainConnection(endlessPage);
  assert.equal(result.pages, MAX_CONNECTION_PAGES, "the ceiling must bound the walk");
  assert.equal(result.nodes.length, MAX_CONNECTION_PAGES);
  assert.equal(result.truncated, true);
});

test("totalCount above the fetched count is truncation even when the walk finished", () => {
  // The server counted nodes it did not return. The gate cannot vouch for the
  // difference, so it must not treat the short set as authoritative.
  const { fetchPage } = pagedFetcher([page([1, 2], { totalCount: 7 })]);
  assert.equal(drainConnection(fetchPage).truncated, true);
});

test("an absent connection drains to empty and is NOT truncated", () => {
  // A commit with no status rollup at all: zero of zero. deriveCiStatus turns
  // that into ci=none, which is already non-mergeable — flagging it truncated
  // would report a pagination fault that did not happen.
  const result = drainConnection(() => null);
  assert.deepEqual(result.nodes, []);
  assert.equal(result.totalCount, 0);
  assert.equal(result.truncated, false);
});

test("a page missing its nodes/pageInfo keys does not throw", () => {
  const result = drainConnection(() => ({ totalCount: 0 }));
  assert.deepEqual(result.nodes, []);
  assert.equal(result.truncated, false);
});
