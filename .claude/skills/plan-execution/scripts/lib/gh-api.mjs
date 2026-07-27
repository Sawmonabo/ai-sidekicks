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
 * This is robustness against a future object-typed endpoint, NOT a fix for a
 * live crash: all three paginated call sites in codex-gate.mjs are array
 * endpoints, where plain `--paginate` already merges the pages into one valid
 * array. The shape that defeats a bare `JSON.parse` is the object-typed one —
 * `search/issues --paginate` emits 60 back-to-back `}{` joins and fails to parse
 * at position 9620 — and routing every paginated call through here forecloses
 * it before a future endpoint can reach the gate.
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
 * Drain a GraphQL connection to completion.
 *
 * `truncated` is true whenever the fetched node count falls short of
 * `totalCount` — the page ceiling was hit, a cursor stopped advancing, or the
 * server withheld nodes it counted. It is a fail-closed signal, not a warning:
 * callers feed it into the verdict, which refuses `merge_ok` on it. A count the
 * gate cannot vouch for is indistinguishable from a hidden unresolved thread.
 *
 * @param {(cursor: string | null) => ({totalCount?: number, nodes?: Array<object>, pageInfo?: {hasNextPage?: boolean, endCursor?: string | null}} | null | undefined)} fetchPage
 * @returns {{nodes: Array<object>, totalCount: number, truncated: boolean, pages: number}}
 */
export function drainConnection(fetchPage) {
  const nodes = [];
  let totalCount = 0;
  let cursor = null;
  let pages = 0;

  while (pages < MAX_CONNECTION_PAGES) {
    const connection = fetchPage(cursor);
    pages += 1;
    if (!connection) break;

    totalCount = connection.totalCount ?? totalCount;
    nodes.push(...(connection.nodes ?? []));

    const pageInfo = connection.pageInfo ?? {};
    // An `endCursor` of null with `hasNextPage` set cannot advance the walk;
    // stopping leaves `nodes.length < totalCount`, which fails closed.
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }

  return { nodes, totalCount, truncated: nodes.length < totalCount, pages };
}
