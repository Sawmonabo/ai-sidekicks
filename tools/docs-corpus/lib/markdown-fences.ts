// Shared CommonMark fence-state tracker — the ONE implementation behind every
// fence-aware markdown scanner in the docs-corpus tools (label-cite's heading
// collection, floor/§-cite extractor, and volatile-cite deny; cite-target-
// existence's bare-volatile pass; table-arity's boundary scan; mermaid-set-
// coherence's and table-total-coherence's fence suppression) and the
// plan-execution Done-Checklist census. Call it with the RAW line; an opener
// may carry an info string (` ```ts `), and a CLOSER is the same delimiter
// character, at least the opener's length, followed by whitespace only — a
// delimiter-looking line with trailing text inside a fence is fence content,
// and a `~~~` cannot close a backtick fence. The naive toggle this replaces
// mis-closed on info-string lines, letting the real closer REOPEN the fence
// over following prose — in the md deny that suppressed checks (Codex, PR #207
// round 2); in heading collection, the floor extractor, and the bare-volatile
// pass the same flip could silently skip §-verification of real anchors or
// chase quoted example content, so every site shares this tracker rather than
// each porting the rule (PR #207 round 3). Lives in its own module because
// label-cite imports cite-target-existence — a shared definition in either
// would cycle.
//
// The threaded state carries four things, each blind to a line-local
// classifier and each the subject of a real fail-open defect:
//
//   containers       LIST CONTAINER STACK. CommonMark measures the three-space
//                    delimiter budget from the innermost container's CONTENT
//                    COLUMN, not from column zero: under `10. ` that column is
//                    four, so a four-space ``` there is a fence and not
//                    indented code. Continuation lines carry no marker, so
//                    only threaded state can know this (task #83).
//   inParagraph      Whether the previous line was paragraph continuation
//                    text, which decides whether a marker may open a list at
//                    all (CommonMark 0.31.2 §5.2 — see canStartListItem).
//   blockquoteDepth  So leaving a quote drops the quoted list's containers
//                    instead of leaking them to root level, and so a fence is
//                    closed only at the depth it opened at.
//   openFence        The open fence's identity: what may close it.
//
// Taking the RAW line is load-bearing, not a convenience: the blockquote
// prefix is what carries depth, so a tracker handed a pre-stripped line cannot
// see a quote exit at all. Callers no longer strip before calling.
//
// The subset is bounded on purpose. Containers are LIST ITEMS only; tabs are
// declined everywhere a column is computed (below). That is a block parser's
// list machinery and nothing else — no setext, no HTML blocks, no link
// reference definitions — which keeps the shared walk proportionate to what
// fence recognition actually needs.

/** An open fence's identity: what may close it, and what it declared. */
export type OpenFence = {
  readonly marker: string;
  readonly length: number;
  /** The opener's tail verbatim — ` ```ts ` yields `ts`, a closer yields `""`. */
  readonly infoString: string;
  /**
   * The blockquote depth the opener sat at. A closer must match it: a
   * `> ``` ` line cannot close a top-level fence and a `>> ``` ` line cannot
   * close a `> ``` ` one, because CommonMark allows a closer at most three
   * spaces of indentation (§4.5) and a blockquote marker is not indentation —
   * inside an open fence either line is literal content.
   */
  readonly blockquoteDepth: number;
};

/**
 * Fence state plus the enclosing block context. Threaded through a document
 * walk; start from `INITIAL_SCAN_STATE` and reassign from each
 * `advanceScanState` result.
 *
 * Readonly throughout because every consumer shares the one
 * `INITIAL_SCAN_STATE` value: a walk that wrote through its own state handle
 * would seed every later walk in the process with the leftovers.
 */
export type MarkdownScanState = {
  /** Enclosing list items as content COLUMNS, outermost to innermost. */
  readonly containers: readonly number[];
  readonly openFence: OpenFence | null;
  /** Blockquote depth of the previous line. */
  readonly blockquoteDepth: number;
  /** Was the previous line paragraph continuation text? */
  readonly inParagraph: boolean;
};

export const INITIAL_SCAN_STATE: MarkdownScanState = {
  containers: [],
  openFence: null,
  blockquoteDepth: 0,
  inParagraph: false,
};

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

/** An ATX heading (§4.2) — a leaf block, so it is never paragraph text. */
const ATX_HEADING_PATTERN = /^ {0,3}#{1,6}(?:[ \t]|$)/;

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
 * May a marker on this line actually START a list item here?
 *
 * CommonMark 0.31.2 §5.2 (List items): "When the first list item in a list
 * interrupts a paragraph—that is, when it starts on a line that would
 * otherwise count as paragraph continuation text—then (a) the lines Ls must
 * not begin with a blank line, and (b) if the list item is ordered, the start
 * number must be 1." The spec's Example 285 states the (a) consequence
 * directly: an empty list item cannot interrupt a paragraph.
 *
 * So `2. text` directly under prose is PARAGRAPH TEXT, not a list. Pushing a
 * container for it shifted the delimiter budget, and a following four-space
 * backtick line was then read as a list-relative fence instead of the indented
 * code it is — a false fence, suppressing every fence-aware check over the
 * live prose after it through the apparent closer or EOF (Codex, PR #273
 * round 1). Suppression is the fail-OPEN direction for every consumer here,
 * which is why this is enforced rather than disclosed.
 *
 * The restriction binds only the FIRST item of a list. A marker continuing a
 * list already open at this depth is not interrupting anything — `1. one` /
 * `2. two` is one list, and `10. ten` after it still continues it — so the
 * caller passes `continuesOpenList` and the restriction is skipped.
 */
function canStartListItem(
  markerText: string,
  remainder: string,
  inParagraph: boolean,
  continuesOpenList: boolean,
): boolean {
  if (!inParagraph || continuesOpenList) return true;
  if (remainder === "") return false;
  if (!/^\d/.test(markerText)) return true;
  return /^1[.)]$/.test(markerText);
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
  inParagraph: boolean,
): { containers: readonly number[]; content: string } {
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
    // A container already open at THIS depth means the marker continues that
    // list rather than opening a new one, and the paragraph-interruption rule
    // binds only a list's first item.
    const continuesOpenList = containers.length > open.length;
    if (!canStartListItem(markerText, remainder, inParagraph, continuesOpenList)) break;
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

/**
 * Is this line paragraph continuation text, for the NEXT line's purposes?
 *
 * Leaf blocks that are not paragraphs (§4.2 ATX headings, §4.1 thematic
 * breaks, §4.5 fenced code delimiters) and blank lines all end a paragraph;
 * everything else with content continues one.
 *
 * Over-reporting here only makes the interruption rule STRICTER — fewer
 * containers pushed, delimiters measured root-relative, code read as prose,
 * which is the loud direction. Under-reporting re-opens the false fence the
 * rule exists to close.
 */
function isParagraphText(content: string, isDelimiterLine: boolean): boolean {
  if (isDelimiterLine) return false;
  if (isBlank(content)) return false;
  if (THEMATIC_BREAK_PATTERN.test(content)) return false;
  if (ATX_HEADING_PATTERN.test(content)) return false;
  return true;
}

/**
 * One line's step. `openFenceAtLineStart` is the fence in force as the line
 * BEGAN — after any container death, before this line's own delimiter is
 * classified — and is what decides whether the line's CONTENT is fenced.
 *
 * Consumers must not re-derive that from the pre-call state: a fence dies on
 * the line that leaves its container, so the incoming state still holds it and
 * a caller reading `state.openFence` would suppress one line too many. That is
 * the shape the Done-Checklist census had to get right by hand.
 */
export type ScanStep = {
  readonly state: MarkdownScanState;
  readonly isDelimiterLine: boolean;
  readonly openFenceAtLineStart: OpenFence | null;
};

export function advanceScanState(rawLine: string, state: MarkdownScanState): ScanStep {
  const depth = blockquoteDepth(rawLine);
  // A fence dies at the first line SHALLOWER than the container it opened in,
  // whatever that line is, and dies BEFORE the line is processed.
  //
  // This is a derivation, not a policy choice. CommonMark laziness applies to
  // paragraph continuation text and nothing else, so fence CONTENT is never
  // lazily continued — the spec says outright that "we can't omit the `>` in
  // front of subsequent lines of an indented or fenced code block"
  // (CommonMark 0.31.2 §5.1). A line that drops below the opener's depth has
  // therefore left the container, and the fence inside it closes with the
  // container. Spec example 237 is this exact shape:
  //
  //     > ```        ->  <blockquote><pre><code></code></pre></blockquote>
  //     foo              <p>foo</p>
  //     ```              <pre><code></code></pre>
  //
  // — note the third line RE-OPENS a fence at top level, which is why the line
  // is processed normally after the container closes rather than being skipped.
  //
  // DEPTH, not quotedness. The predecessor of this rule asked only "is the line
  // unquoted?", which is the depth>=1 -> 0 case of it, and that gap was
  // exploitable: inside a `> ``` ` fence, a `> <!--` line is still in the
  // container and must NOT end it, while a depth-1 line inside a `>> ``` `
  // fence has left the container and must. A boolean cannot say both.
  //
  // The unquoted-opened fence is the SAME rule at D=0: no line can be shallower
  // than depth 0, so the fence never dies here and only its own closer ends it.
  //
  // This rule reached the shared tracker from the Done-Checklist census, which
  // had derived it locally across two findings; without it an unterminated
  // quoted example stays open over the rest of the document and suppresses
  // every check below it.
  const openFenceAtLineStart =
    state.openFence !== null && depth < state.openFence.blockquoteDepth ? null : state.openFence;
  // Express the line relative to the block it belongs to:
  //
  //   no fence open -> ALL levels stripped, so a quoted opener (`> ```md`) is
  //                    seen at all, and the depth it opened at is recorded.
  //   fence open    -> EXACTLY the opener's levels stripped, so the line reads
  //                    relative to the fence's own container. A DEEPER line
  //                    still carries `>` afterwards, fails the delimiter
  //                    pattern, and is CONTENT — which is what the spec says.
  //
  // Stripping all levels while a fence was open is what let a `>> ``` ` line
  // close a `> ``` ` fence, ending it early, turning the rest of the document
  // into live markdown and letting example content be read as real.
  const unquotedLine =
    openFenceAtLineStart === null
      ? stripBlockquotePrefix(rawLine)
      : stripQuoteLevels(rawLine, openFenceAtLineStart.blockquoteDepth);

  // Leaving (or entering) a blockquote ends every block inside it. Without
  // this, a `> 10. item` line's content column survived the depth change and a
  // root-level four-space delimiter was measured against it — a false fence
  // over live prose, suppressing citations through the next matching delimiter
  // or EOF (Codex, PR #273 round 1). A fence spans the change untouched: its
  // interior is opaque, and its own depth is pinned on the opener.
  //
  // Paragraph state deliberately SURVIVES the change. Blockquote laziness
  // (§5.1) continues a quoted paragraph across an unquoted line whose content
  // is paragraph continuation text, so `> prose` followed by an unquoted
  // `2. x` is still that paragraph — clearing the flag here would let `2. x`
  // open a list and re-create the very false fence above. It is also the
  // fail-closed direction: keeping the flag can only withhold a container.
  const quoteChanged = openFenceAtLineStart === null && depth !== state.blockquoteDepth;
  const containersIn = quoteChanged ? [] : state.containers;
  const inParagraphIn = state.inParagraph;

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
    openFenceAtLineStart === null
      ? advanceContainers(unquotedLine, containersIn, inParagraphIn)
      : {
          containers: containersIn,
          content: contentAtColumn(unquotedLine, innermostContentColumn(containersIn)),
        };

  const settled = (isDelimiterLine: boolean, openFence: OpenFence | null): MarkdownScanState => ({
    containers: advanced.containers,
    openFence,
    blockquoteDepth: depth,
    // Paragraph state describes the OUTER document, so it only moves where
    // containers do: inside a fence every line is opaque content, and the
    // closer is a delimiter line, which ends a paragraph anyway.
    inParagraph:
      openFenceAtLineStart !== null
        ? false
        : isParagraphText(advanced.content ?? "", isDelimiterLine),
  });

  if (advanced.content === null) {
    return {
      state: settled(false, openFenceAtLineStart),
      isDelimiterLine: false,
      openFenceAtLineStart,
    };
  }

  // At most three SPACES past the container's content column (CommonMark):
  // four or more — or a tab, which expands past the limit — makes the line
  // indented-code CONTENT, not a delimiter. The earlier `\s*` treated an
  // indented literal (`    ``` `) as an opener, exempting the ordinary prose
  // after it from the volatile-cite deny and §-cite extraction until the next
  // delimiter (Codex, PR #207 round 3).
  const fenceDelimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(advanced.content);
  if (fenceDelimiter === null) {
    return {
      state: settled(false, openFenceAtLineStart),
      isDelimiterLine: false,
      openFenceAtLineStart,
    };
  }
  // A backtick fence's info string may not contain a backtick (CommonMark
  // 4.5) — a ```` ```ts`x ```` line is inline code, not a delimiter, so it
  // neither opens a fence (which would exempt the following prose from the
  // volatile-cite deny) nor breaks wrap adjacency. Tilde info strings may
  // carry backticks. Closers are unaffected: their tail is whitespace-only
  // (Codex, PR #207 round 4).
  if (fenceDelimiter[1][0] === "`" && fenceDelimiter[2].includes("`")) {
    return {
      state: settled(false, openFenceAtLineStart),
      isDelimiterLine: false,
      openFenceAtLineStart,
    };
  }
  if (openFenceAtLineStart === null) {
    return {
      state: settled(true, {
        marker: fenceDelimiter[1][0],
        length: fenceDelimiter[1].length,
        infoString: fenceDelimiter[2],
        blockquoteDepth: depth,
      }),
      isDelimiterLine: true,
      openFenceAtLineStart,
    };
  }
  if (
    fenceDelimiter[1][0] === openFenceAtLineStart.marker &&
    fenceDelimiter[1].length >= openFenceAtLineStart.length &&
    fenceDelimiter[2].trim() === ""
  ) {
    // No depth comparison here, deliberately. Any line reaching this point
    // ALREADY sits at the opener's depth: a shallower line killed the fence
    // above, and a deeper one kept its surplus `>` through the depth-limited
    // strip and so never matched the delimiter pattern. An explicit
    // `depth === openFence.blockquoteDepth` reads like a third guard but is
    // implied by those two — it can never decide anything, so no mutation of
    // it can fail a test. It was written, measured as a SURVIVED mutation arm,
    // and removed.
    return { state: settled(true, null), isDelimiterLine: true, openFenceAtLineStart };
  }
  return {
    state: settled(true, openFenceAtLineStart),
    isDelimiterLine: true,
    openFenceAtLineStart,
  };
}

// Strip blockquote containers for FENCE tracking (`> ```text` opens a fence
// inside a quoted example). Each quote level admits at most three SPACES of
// indentation before its `>` (CommonMark block-quote marker rule) — four or
// more, or a tab, makes the line indented code, and stripping the marker
// anyway would hand the tracker a synthetic delimiter that bypasses its own
// indentation guard and exempts the following prose from the volatile-cite
// deny (Codex, PR #207 round 4).
const BLOCKQUOTE_PREFIX_RE = /^(?: {0,3}>)+ ?/;

/** One blockquote level, for the depth-limited strip below. */
const BLOCKQUOTE_LEVEL_RE = /^ {0,3}>/;

export function stripBlockquotePrefix(line: string): string {
  return line.replace(BLOCKQUOTE_PREFIX_RE, "");
}

/**
 * Strip EXACTLY `levels` blockquote markers, leaving any deeper marker in
 * place as content. Used while a fence is open so the line is read relative to
 * the fence's own quote depth.
 *
 * The trailing single space is consumed only when a marker actually was —
 * otherwise a root-level `    ``` ` read against a depth-1 fence would lose a
 * space and become a valid three-space closer, the false-close direction this
 * mechanism exists to prevent. At full depth the result is byte-identical to
 * `stripBlockquotePrefix`, which is what makes this a refinement of that
 * grammar rather than a second implementation of it.
 */
export function stripQuoteLevels(line: string, levels: number): string {
  if (levels === 0) return line;
  let rest = line;
  let stripped = 0;
  for (let level = 0; level < levels; level++) {
    const next = rest.replace(BLOCKQUOTE_LEVEL_RE, "");
    if (next === rest) break;
    rest = next;
    stripped++;
  }
  return stripped === 0 ? rest : rest.replace(/^ ?/, "");
}

/**
 * How many blockquote markers `stripBlockquotePrefix` consumes on this line.
 *
 * Shares the prefix pattern with the strip above rather than restating it, so
 * the two can never disagree about what counts as a container marker. A
 * scanner tracking a MULTI-LINE construct inside a quote needs this: GFM
 * builds a table only from rows in the same container, so `table-arity`
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
