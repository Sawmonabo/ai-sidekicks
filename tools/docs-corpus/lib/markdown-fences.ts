// Shared CommonMark fence-state tracker — the ONE implementation behind every
// fence-aware markdown scanner in the docs-corpus tools (label-cite's heading
// collection, floor/§-cite extractor, and volatile-cite deny; cite-target-
// existence's bare-volatile pass; table-arity's boundary scan; mermaid-set-
// coherence's and table-total-coherence's fence suppression). Call with the
// blockquote-stripped line; an
// opener may carry an info string (` ```ts `), and a CLOSER is the same
// delimiter character, at least the opener's length, followed by whitespace
// only — a delimiter-looking line with trailing text inside a fence is fence
// content, and a `~~~` cannot close a backtick fence. The naive toggle this
// replaces mis-closed on info-string lines, letting the real closer REOPEN
// the fence over following prose — in the md deny that suppressed checks
// (Codex, PR #207 round 2); in heading collection, the floor extractor, and
// the bare-volatile pass the same flip could silently skip §-verification of
// real anchors or chase quoted example content, so every site shares this
// tracker rather than each porting the rule (PR #207 round 3). Lives in its
// own module because label-cite imports cite-target-existence — a shared
// definition in either would cycle.
//
// The threaded state is a LIST CONTAINER STACK alongside the open fence,
// because CommonMark measures the three-space delimiter budget from the
// innermost container's CONTENT COLUMN rather than from column zero: under
// `10. ` that column is four, so a four-space ``` there is a fence and not
// indented code. A line-local classifier cannot see this — continuation lines
// carry no marker — which is why the budget was root-relative through PR #270
// and a list-nested fence was read as code content (task #83 closes that; the
// stack is what every consumer's walk now carries).
//
// The subset is bounded on purpose. Containers are LIST ITEMS only, pushed
// from a marker line and popped when a non-blank line dedents below their
// content column; blockquotes stay the caller's `stripBlockquotePrefix` step,
// and tabs are declined everywhere a column is computed (below). That is a
// block parser's list machinery and nothing else — no setext, no HTML blocks,
// no link reference definitions — which keeps the shared walk proportionate to
// what fence recognition actually needs.

/** An open fence's identity: what may close it, and what it declared. */
export type OpenFence = {
  readonly marker: string;
  readonly length: number;
  /** The opener's tail verbatim — ` ```ts ` yields `ts`, a closer yields `""`. */
  readonly infoString: string;
};

/**
 * Fence state plus the enclosing list containers, as content COLUMNS from
 * outermost to innermost. Threaded through a document walk; start from
 * `INITIAL_SCAN_STATE` and reassign from each `advanceFenceState` result.
 *
 * Readonly throughout because every consumer shares the one
 * `INITIAL_SCAN_STATE` value: a walk that wrote through its own state handle
 * would seed every later walk in the process with the leftovers.
 */
export type MarkdownScanState = {
  readonly containers: readonly number[];
  readonly openFence: OpenFence | null;
};

export const INITIAL_SCAN_STATE: MarkdownScanState = { containers: [], openFence: null };

/**
 * A list item marker with the pieces the content column is computed from:
 * indentation, the marker itself (`-`/`+`/`*` or `1.`/`9999)`), the spaces
 * after it, and whatever remains. Mirrors `table-arity`'s LIST_MARKER_PATTERN,
 * split into groups and extended with the empty-item case that pattern has no
 * need for.
 */
const LIST_ITEM_MARKER_PATTERN = /^( {0,3})([-+*]|\d{1,9}[.)])( *)(.*)$/;

/**
 * `- - -`, `***`, `___` — a thematic break, which shares the bullet characters
 * but opens no list. Without this, `* * *` would push three containers and
 * shift the budget for everything indented beneath it.
 */
const THEMATIC_BREAK_PATTERN = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** Spaces only — a tab is never a column this module is willing to count. */
function isSpacesOnly(text: string): boolean {
  return /^ *$/.test(text);
}

function innermostContentColumn(containers: readonly number[]): number {
  return containers.length === 0 ? 0 : containers[containers.length - 1];
}

/**
 * The line as its innermost container sees it, or `null` when the line does
 * not reach that container's content column through spaces alone.
 *
 * Slicing blind would read `abcd``` ` as a delimiter at content column four:
 * the prefix has to be verified, not assumed.
 */
function contentAtColumn(unquotedLine: string, contentColumn: number): string | null {
  if (!isSpacesOnly(unquotedLine.slice(0, contentColumn))) return null;
  return unquotedLine.slice(contentColumn);
}

/**
 * Advance the container stack over one line, returning it with the line's
 * content as seen from the innermost container.
 *
 * Popping is unconditional on a non-blank line that dedents below a content
 * column — that is what keeps a container from leaking past its item and
 * shifting the budget for the rest of the file. A BLANK line never pops: it
 * ends a paragraph, not a list item, and an item's fence routinely follows one.
 */
function advanceContainers(
  unquotedLine: string,
  containers: readonly number[],
): { containers: readonly number[]; content: string | null } {
  if (isBlank(unquotedLine)) return { containers, content: "" };

  let column = 0;
  const open: number[] = [];
  for (const contentColumn of containers) {
    if (!isSpacesOnly(unquotedLine.slice(column, contentColumn))) break;
    open.push(contentColumn);
    column = contentColumn;
  }

  for (;;) {
    const rest = unquotedLine.slice(column);
    if (THEMATIC_BREAK_PATTERN.test(rest)) break;
    const marker = LIST_ITEM_MARKER_PATTERN.exec(rest);
    if (marker === null) break;
    const [, markerIndent, markerText, spacesAfterMarker, remainder] = marker;
    // `-foo` and `1.x` are paragraphs: a marker needs whitespace or the line's
    // end after it. A TAB there is declined with the rest of the tab handling
    // — the container is simply not pushed, leaving the line on the root-
    // relative budget it had before this module tracked containers.
    if (spacesAfterMarker.length === 0 && remainder !== "") break;
    const markerEnd = column + markerIndent.length + markerText.length;
    // CommonMark 5.2: content begins after the marker's following spaces —
    // except that an EMPTY item, or one whose first content sits five-plus
    // spaces past the marker (that content is indented code), begins one
    // space past it.
    const contentColumn =
      remainder === "" || spacesAfterMarker.length >= 5
        ? markerEnd + 1
        : markerEnd + spacesAfterMarker.length;
    open.push(contentColumn);
    column = contentColumn;
  }

  return { containers: open, content: unquotedLine.slice(column) };
}

export function advanceFenceState(
  unquotedLine: string,
  state: MarkdownScanState,
): { state: MarkdownScanState; isDelimiterLine: boolean } {
  // Containers FREEZE while a fence is open. Fence content is opaque, so a
  // `- item` line inside one must not push a container: that would shift the
  // budget out from under the closer, leaving the fence open over the rest of
  // the file and suppressing every check below it — fail-silent, the direction
  // that costs findings. The freeze also makes the innermost content column at
  // the closer necessarily the OPENER's, so the closer's budget needs no
  // separate record; a stored copy would be state nothing can disagree with,
  // and no mutation of it could fail a test.
  //
  // The residual, disclosed and measured: a fence opened inside a list item
  // stays open past the item's end, because container EXIT is not modeled. Of
  // 597 fence spans across the 261 tracked `.md` files, zero could be cut
  // short this way — no span is unclosed, closes at a lower indent than its
  // opener, or holds an interior line that dedents below it.
  const advanced =
    state.openFence === null
      ? advanceContainers(unquotedLine, state.containers)
      : {
          containers: state.containers,
          content: contentAtColumn(unquotedLine, innermostContentColumn(state.containers)),
        };
  const unchanged: MarkdownScanState = {
    containers: advanced.containers,
    openFence: state.openFence,
  };
  if (advanced.content === null) return { state: unchanged, isDelimiterLine: false };

  // At most three SPACES past the container's content column (CommonMark):
  // four or more — or a tab, which expands past the limit — makes the line
  // indented-code CONTENT, not a delimiter. The earlier `\s*` treated an
  // indented literal (`    ``` `) as an opener, exempting the ordinary prose
  // after it from the volatile-cite deny and §-cite extraction until the next
  // delimiter (Codex, PR #207 round 3).
  const fenceDelimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(advanced.content);
  if (fenceDelimiter === null) return { state: unchanged, isDelimiterLine: false };
  // A backtick fence's info string may not contain a backtick (CommonMark
  // 4.5) — a ```` ```ts`x ```` line is inline code, not a delimiter, so it
  // neither opens a fence (which would exempt the following prose from the
  // volatile-cite deny) nor breaks wrap adjacency. Tilde info strings may
  // carry backticks. Closers are unaffected: their tail is whitespace-only
  // (Codex, PR #207 round 4).
  if (fenceDelimiter[1][0] === "`" && fenceDelimiter[2].includes("`")) {
    return { state: unchanged, isDelimiterLine: false };
  }
  if (state.openFence === null) {
    return {
      state: {
        containers: advanced.containers,
        openFence: {
          marker: fenceDelimiter[1][0],
          length: fenceDelimiter[1].length,
          infoString: fenceDelimiter[2],
        },
      },
      isDelimiterLine: true,
    };
  }
  if (
    fenceDelimiter[1][0] === state.openFence.marker &&
    fenceDelimiter[1].length >= state.openFence.length &&
    fenceDelimiter[2].trim() === ""
  ) {
    return {
      state: { containers: advanced.containers, openFence: null },
      isDelimiterLine: true,
    };
  }
  return { state: unchanged, isDelimiterLine: true };
}

// Strip blockquote containers for FENCE tracking (`> ```text` opens a fence
// inside a quoted example). Each quote level admits at most three SPACES of
// indentation before its `>` (CommonMark block-quote marker rule) — four or
// more, or a tab, makes the line indented code, and stripping the marker
// anyway would hand advanceFenceState a synthetic delimiter that bypasses
// its own indentation guard and exempts the following prose from the
// volatile-cite deny (Codex, PR #207 round 4). Quote DEPTH is deliberately
// not matched between opener and closer — the pragmatic bound for this
// illustrative-example exemption, shared by every scanner that tracks
// fences.
const BLOCKQUOTE_PREFIX_RE = /^(?: {0,3}>)+ ?/;

export function stripBlockquotePrefix(line: string): string {
  return line.replace(BLOCKQUOTE_PREFIX_RE, "");
}

/**
 * How many blockquote markers `stripBlockquotePrefix` consumes on this line.
 *
 * Shares the prefix pattern with the strip above rather than restating it, so
 * the two can never disagree about what counts as a container marker. Fence
 * tracking does not need this — its quote-depth tolerance is deliberate (see
 * above) — but a scanner tracking a MULTI-LINE construct inside a quote does:
 * GFM builds a table only from rows in the same container, so `table-arity`
 * requires header and delimiter to sit at one depth before it will read them
 * as a table at all. Without that, a quoted header abutting an unquoted
 * delimiter synthesizes a table GFM never renders and then reports its "rows"
 * (Codex, PR #269 round 2).
 */
export function blockquoteDepth(line: string): number {
  const prefix = BLOCKQUOTE_PREFIX_RE.exec(line);
  if (prefix === null) return 0;
  let depth = 0;
  for (const character of prefix[0]) {
    if (character === ">") depth++;
  }
  return depth;
}
