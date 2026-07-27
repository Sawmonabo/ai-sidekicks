// node:test suite for lib/gh-api.mjs.
// Run via:
//   node --test --experimental-strip-types '.claude/skills/plan-execution/scripts/__tests__/**/*.test.mjs'
//
// The drain behaviours are unit-tested rather than probed against live PRs
// because none of them is reachable from real data: both GraphQL connections
// drain in one page on any PR in this repo, so no live probe ever reaches a
// truncation branch, and a server that stops advancing its own cursor cannot be
// summoned on demand.
//
// The page-flattening half is no longer in that category. `check-suites` is
// object-typed (`{total_count, check_suites}` per page), so codex-gate.mjs now
// drives the object-page path on every run.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeTruncation,
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
  // The cursor must ADVANCE for this to be a long connection rather than a
  // stalled one — the earlier fixture returned a fixed "next" forever, which is
  // the cursor-stall case below and never reached the ceiling at all.
  let pagesServed = 0;
  const endlessPage = () => {
    pagesServed += 1;
    return page([1], { totalCount: 10_000, hasNextPage: true, endCursor: `c${pagesServed}` });
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

test("a complete drain names no truncation reason", () => {
  const { fetchPage } = pagedFetcher([page([1, 2, 3], { totalCount: 3 })]);
  assert.equal(drainConnection(fetchPage).truncationReason, null);
});

test("a non-advancing cursor is truncation even when the node count says otherwise", () => {
  // The reported hole. The server keeps handing back the cursor it was given, so
  // the walk refetches page one to the ceiling. The DUPLICATE nodes then push
  // nodes.length past totalCount, and a count-only test reports a complete drain
  // of a connection that never advanced.
  const stuck = () => page([1, 2], { totalCount: 4, hasNextPage: true, endCursor: "stuck" });
  const result = drainConnection(stuck);
  assert.ok(result.nodes.length >= result.totalCount, "the count test alone would pass here");
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, "cursor-stalled");
  assert.ok(
    result.pages < MAX_CONNECTION_PAGES,
    "the repeat is caught without burning the ceiling",
  );
});

test("a cursor CYCLE is caught, not just an immediate repeat", () => {
  const cycle = ["a", "b", "a", "b"];
  let index = -1;
  const result = drainConnection(() => {
    index += 1;
    return page([index], { totalCount: 100, hasNextPage: true, endCursor: cycle[index % 4] });
  });
  assert.equal(result.truncationReason, "cursor-stalled");
});

test("hitting the page ceiling with pages outstanding is truncation on its own", () => {
  // totalCount is deliberately smaller than what the walk fetches, so the count
  // test cannot be what raises the flag.
  let cursorSeed = 0;
  const result = drainConnection(() => {
    cursorSeed += 1;
    return page([1], { totalCount: 1, hasNextPage: true, endCursor: `c${cursorSeed}` });
  });
  assert.equal(result.pages, MAX_CONNECTION_PAGES);
  assert.ok(result.nodes.length > result.totalCount, "the count test alone would pass here");
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, "pages-pending");
});

test("hasNextPage with no endCursor reports pages-pending, not a shortfall", () => {
  const { fetchPage } = pagedFetcher([
    page([1, 2], { totalCount: 2, hasNextPage: true, endCursor: null }),
  ]);
  const result = drainConnection(fetchPage);
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, "pages-pending");
});

test("a connection with no totalCount is unverifiable, not complete", () => {
  // The old `?? totalCount` default left it at 0, so `nodes.length < 0` was
  // unsatisfiable and every such connection reported a complete drain.
  const result = drainConnection(() => ({ nodes: [1, 2, 3], pageInfo: { hasNextPage: false } }));
  assert.deepEqual(result.nodes, [1, 2, 3]);
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, "no-total-count");
});

test("a totalCount of 0 is a REPORTED total, not a missing one", () => {
  const result = drainConnection(() => ({ totalCount: 0, nodes: [], pageInfo: {} }));
  assert.equal(result.truncated, false);
  assert.equal(result.truncationReason, null);
});

test("an absent connection is still zero-of-zero, not unverifiable", () => {
  // The no-total-count rule must not swallow this case: nothing came back at
  // all, which is the commit with no statusCheckRollup.
  const result = drainConnection(() => null);
  assert.equal(result.truncated, false);
  assert.equal(result.truncationReason, null);
});

test("a short drain is still reported as a shortfall", () => {
  // Precedence check: totalCount IS reported here, so the reason must stay
  // short-drain rather than shifting to one of the new conditions.
  const { fetchPage } = pagedFetcher([page([1, 2], { totalCount: 7 })]);
  assert.equal(drainConnection(fetchPage).truncationReason, "short-drain");
});

// ------------------------------------------------------ describeTruncation

test("each reason renders a phrase that names the actual fault", () => {
  const stalled = describeTruncation({
    truncationReason: "cursor-stalled",
    nodes: [1, 2, 3],
    totalCount: 2,
  });
  assert.match(stalled, /never advanced/);
  assert.doesNotMatch(stalled, /fetched 3 of 2/, "a stall is not a shortfall");

  assert.match(
    describeTruncation({ truncationReason: "pages-pending", nodes: [1], totalCount: 9 }),
    /more pages still outstanding/,
  );

  const noTotal = describeTruncation({
    truncationReason: "no-total-count",
    nodes: [1, 2],
    totalCount: 0,
  });
  assert.match(noTotal, /no totalCount/);
  assert.doesNotMatch(noTotal, /of 0/, "'fetched 2 of 0' is nonsense, not a diagnosis");
});

test("a shortfall renders as the plain count", () => {
  assert.equal(
    describeTruncation({ truncationReason: "short-drain", nodes: [1, 2], totalCount: 7 }),
    "fetched 2 of 7",
  );
});
