/**
 * Response handling for the `gh` CLI: stdout parsing, `--paginate --slurp` page
 * flattening, and GraphQL connection drain.
 *
 * Split out from codex-gate.mjs because the branches that matter cannot be
 * reached from live GitHub data, so a probe against a real PR executes none of
 * them and still reports success:
 *   - the object-typed page shape, which no endpoint this gate calls returns;
 *   - the truncation path, which only opens past a connection's page ceiling.
 * Isolating them makes both directly constructible.
 */

/** Hard ceiling on pages per connection, so a cursor that stops advancing cannot spin forever. */
export const MAX_CONNECTION_PAGES = 20;

/**
 * Parse `gh` stdout.
 *
 * Empty output is `null` rather than a throw — `gh` prints nothing for a call
 * that legitimately returns no body, and every caller already reads a nullish
 * result as "no rows". Everything else goes to `JSON.parse` unchanged, so a
 * genuine malformation surfaces its own error instead of being absorbed by a
 * fallback that guesses at the intended shape.
 *
 * @param {string | null | undefined} raw
 * @returns {unknown} `null` for empty output, otherwise the parsed document.
 * @throws {SyntaxError} on malformed JSON.
 */
export function parseGhJson(raw) {
  const text = (raw ?? "").trim();
  if (text === "") return null;
  return JSON.parse(text);
}

/**
 * Collapse a `gh api --paginate --slurp` response into one row list.
 *
 * `--slurp` is gh's own answer to multi-page output, and it ALWAYS wraps — one
 * element per page, for both endpoint shapes. Verified 2026-07-27 against gh
 * v2.92.0:
 *   - array endpoint, 9 pages  → `[[c],[c],…]`      → 9 comment objects
 *   - array endpoint, 1 page   → `[[r]]`            → 1 review object
 *   - object endpoint, 3 pages → `[{p1},{p2},{p3}]` → 3 page objects
 * One `.flat()` is therefore correct for all three, and the single-page case
 * needs no special branch.
 *
 * The object-typed shape is live, not hypothetical. `check-suites` returns
 * `{total_count, check_suites}` per page, so the ack-anchor fetch in
 * codex-gate.mjs drives this path on every run; the other three paginated call
 * sites are array endpoints, where plain `--paginate` would already have merged
 * the pages into one valid array. Object pages are what defeats a bare
 * `JSON.parse` — `search/issues --paginate` emits 60 back-to-back `}{` joins and
 * fails to parse at position 9620 — so routing every paginated call through here
 * is what lets an object-typed endpoint be added without a crash.
 *
 * Depth-1 by design: it strips the page level and nothing else, so an endpoint
 * whose rows are themselves arrays keeps its rows intact.
 *
 * @param {unknown} slurped Parsed `--slurp` output.
 * @returns {Array<unknown>} Rows for an array endpoint; page objects otherwise.
 * @throws {TypeError} when the payload is not page-wrapped, which would mean
 *   `--slurp` had stopped behaving as documented. Failing loudly beats returning
 *   a shape every caller would silently read as zero rows.
 */
export function flattenSlurpedPages(slurped) {
  if (slurped === null || slurped === undefined) return [];
  if (!Array.isArray(slurped)) {
    throw new TypeError(
      `gh --paginate --slurp must return an array of pages, got ${typeof slurped}`,
    );
  }
  return slurped.flat();
}

/**
 * @typedef {"cursor-stalled"|"pages-pending"|"no-total-count"|"short-drain"} TruncationReason
 */

/**
 * Drain a GraphQL connection to completion.
 *
 * `truncated` means the node list cannot be vouched for. FOUR independent
 * conditions raise it, and three are invisible to a node count — the previous
 * version compared `nodes.length < totalCount` and nothing else, while its own
 * docblock claimed it detected "a cursor stopped advancing". It did not:
 *
 *   - `cursor-stalled` — the server returned an `endCursor` the walk had already
 *     requested. Unhandled, that refetches one page until the ceiling, and the
 *     DUPLICATE nodes push `nodes.length` past `totalCount` — so the count test
 *     reported a complete drain of a connection that never got past page one.
 *   - `pages-pending` — the walk stopped while the server still said
 *     `hasNextPage`: the page ceiling was reached, or `endCursor` was absent.
 *     Only the node count guarded this before.
 *   - `no-total-count` — a connection arrived with no numeric `totalCount`. The
 *     old `?? totalCount` default left it at 0, making `nodes.length < 0`
 *     unsatisfiable, so EVERY such connection reported complete. A total the
 *     server never sent is unverifiable, not verified.
 *   - `short-drain` — the walk finished, but the server counted more nodes than
 *     it returned.
 *
 * A stalled walk is caught one page late, because the repeat only becomes
 * visible once the server has answered with it. Those duplicate rows stay in
 * `nodes`: a truncated drain's node list is a floor that may contain repeats,
 * never a total. Callers refuse to merge on `truncated` rather than counting it.
 *
 * A connection absent ENTIRELY — `fetchPage` returning nullish on the first call
 * — is zero-of-zero rather than truncated. That is a commit with no
 * `statusCheckRollup` at all, which `deriveCiStatus` already reports as `none`,
 * itself non-mergeable. The review-thread equivalent cannot reach here: a
 * GraphQL error makes `gh` exit non-zero (probed 2026-07-27 against a
 * nonexistent PR number — exit 1, NOT_FOUND alongside the null), so the fetch
 * throws instead of returning a silent empty.
 *
 * @param {(cursor: string | null) => ({totalCount?: number, nodes?: Array<object>, pageInfo?: {hasNextPage?: boolean, endCursor?: string | null}} | null | undefined)} fetchPage
 * @returns {{nodes: Array<object>, totalCount: number, truncated: boolean, truncationReason: TruncationReason | null, pages: number}}
 */
export function drainConnection(fetchPage) {
  const nodes = [];
  const requestedCursors = new Set();
  let totalCount = 0;
  let totalCountReported = false;
  let connectionsSeen = 0;
  let cursor = null;
  let pages = 0;
  let cursorStalled = false;
  let pagesPending = false;

  while (pages < MAX_CONNECTION_PAGES) {
    const connection = fetchPage(cursor);
    pages += 1;
    if (!connection) break;
    connectionsSeen += 1;

    if (typeof connection.totalCount === "number") {
      totalCount = connection.totalCount;
      totalCountReported = true;
    }
    nodes.push(...(connection.nodes ?? []));

    const pageInfo = connection.pageInfo ?? {};
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor) {
      pagesPending = true;
      break;
    }
    if (requestedCursors.has(pageInfo.endCursor)) {
      cursorStalled = true;
      break;
    }
    requestedCursors.add(pageInfo.endCursor);
    cursor = pageInfo.endCursor;
    // The loop is about to exit on its ceiling with the server still offering
    // more, which the node count only catches when totalCount happens to exceed
    // what was fetched.
    if (pages >= MAX_CONNECTION_PAGES) pagesPending = true;
  }

  // Ordered by diagnostic specificity, so a stalled cursor is never described as
  // a mere shortfall.
  const truncationReason = cursorStalled
    ? "cursor-stalled"
    : pagesPending
      ? "pages-pending"
      : connectionsSeen > 0 && !totalCountReported
        ? "no-total-count"
        : nodes.length < totalCount
          ? "short-drain"
          : null;

  return { nodes, totalCount, truncated: truncationReason !== null, truncationReason, pages };
}

/**
 * Render a drain's truncation reason as the phrase the gate prints.
 *
 * Lives beside the reasons rather than in the gate so the wording is
 * unit-testable and cannot drift from them. Each phrase names the fault that
 * actually occurred: "fetched 40 of 9" would report a shortfall that never
 * happened on a stalled cursor, and "fetched 12 of 0" is nonsense when the
 * server sent no total at all. A gate that blocks a merge has to be able to say
 * why.
 *
 * @param {{truncationReason: TruncationReason | null, nodes: Array<unknown>, totalCount: number}} drain
 * @returns {string}
 */
export function describeTruncation(drain) {
  const fetched = drain.nodes?.length ?? 0;
  switch (drain.truncationReason) {
    case "cursor-stalled":
      return `the server kept handing back a cursor the walk had already used, so it never advanced past its first page (${fetched} node(s) fetched, repeats included)`;
    case "pages-pending":
      return `the walk stopped with more pages still outstanding, after ${fetched} node(s)`;
    case "no-total-count":
      return `the server sent no totalCount, so the ${fetched} node(s) fetched cannot be confirmed complete`;
    // `short-drain` and the untruncated case both read naturally as a count.
    default:
      return `fetched ${fetched} of ${drain.totalCount}`;
  }
}
