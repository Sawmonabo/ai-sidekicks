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
// THE CONTAINER MODEL. CommonMark's block parser starts each line by walking
// the open containers OUTSIDE-IN and asking each whether the line still belongs
// to it (0.31.2 §"Blocks and inlines" / the appendix's phase 1). The containers
// interleave freely — a quote inside a list item inside a quote — and each list
// item's indent is measured relative to whatever encloses it, so the walk is
// one heterogeneous stack matched left to right.
//
// This module models exactly that, because the two-phase shape it replaces
// (one global blockquote depth, then a homogeneous list-column stack) could not
// express `list -> blockquote` order at all: after `10. item`, the opener
// `    > ```mermaid` has its `>` at column four, which no "strip the quote
// prefix first" pass can see, so the fence never opened and quoted example
// content read as live markdown. Three Codex findings across PR #273 rounds 1
// and 2 traced to that one shape mismatch, which is why the model moved rather
// than the symptoms (Codex, PR #273 round 2).
//
// The threaded state carries three things, each blind to a line-local
// classifier and each the subject of a real fail-open defect:
//
//   containers   The open container stack, outermost first: blockquotes and
//                list items in the order the document nests them. A list
//                entry's `indent` is what a continuation line must reach,
//                measured from where that item's own marker began. Continuation
//                lines carry no marker, so only threaded state can know it.
//   inParagraph  Whether the previous line was paragraph continuation text,
//                which decides whether a marker may open a list at all
//                (CommonMark 0.31.2 §5.2 — see canStartListItem).
//   openFence    The open fence's identity: what may close it, and how deep in
//                the stack it lives.
//
// Taking the RAW line is load-bearing, not a convenience: the blockquote
// prefix is what carries depth, so a tracker handed a pre-stripped line cannot
// see a quote exit at all. Callers no longer strip before calling.
//
// The subset is bounded on purpose. Containers are BLOCKQUOTES and LIST ITEMS;
// tabs are declined everywhere a column is computed (below). That is a block
// parser's container machinery and nothing else — no setext, no HTML blocks, no
// link reference definitions — which keeps the shared walk proportionate to
// what fence recognition actually needs.

/** One open container. Blockquotes carry no width; list items carry theirs. */
export type ContainerEntry =
  | { readonly kind: "blockquote" }
  | {
      readonly kind: "listItem";
      /**
       * Spaces a continuation line must reach, measured from where this item's
       * marker began — NOT an absolute column. Absolute columns cannot express
       * an item nested inside a blockquote, whose own start moves with the
       * quote marker.
       */
      readonly indent: number;
    };

/** An open fence's identity: what may close it, and what it declared. */
export type OpenFence = {
  readonly marker: string;
  readonly length: number;
  /** The opener's tail verbatim — ` ```ts ` yields `ts`, a closer yields `""`. */
  readonly infoString: string;
  /**
   * How many containers were open when the fence opened. A line that matches
   * fewer has LEFT one of them, and the fence closes with it — the container
   * exit rule below. It also makes a closer's depth implicit: a `> ``` ` line
   * cannot close a top-level fence, because reaching this fence's content at
   * all means matching its containers first.
   */
  readonly containerDepth: number;
};

/**
 * Fence state plus the enclosing block context. Threaded through a document
 * walk; start from `INITIAL_SCAN_STATE` and reassign from each
 * `advanceScanState` result.
 *
 * Readonly throughout because every consumer shares the one
 * `INITIAL_SCAN_STATE` value: a walk that wrote through its own state handle
 * would seed every later walk in the process with the leftovers.
 *
 * Blockquote depth is deliberately NOT a field: it is the number of
 * `blockquote` entries in `containers`, and a stored copy would be a second
 * representation of a fact the stack already holds — state nothing can
 * disagree with, where no mutation could fail a test.
 */
export type MarkdownScanState = {
  /** Open containers, outermost first. */
  readonly containers: readonly ContainerEntry[];
  readonly openFence: OpenFence | null;
  /** Was the previous line paragraph continuation text? */
  readonly inParagraph: boolean;
};

export const INITIAL_SCAN_STATE: MarkdownScanState = {
  containers: [],
  openFence: null,
  inParagraph: false,
};

/**
 * A list item marker with the pieces the content indent is computed from:
 * indentation, the marker itself (`-`/`+`/`*` or `1.`/`9999)`), the spaces
 * after it, and whatever remains. Mirrors `table-arity`'s LIST_MARKER_PATTERN,
 * split into groups and extended with the empty-item case that pattern has no
 * need for.
 *
 * The `\d{1,9}` bound is CommonMark's own ordered-marker grammar (§5.2), and
 * cmark enforces the same ceiling while lexing (`while (digits < 9 && ...)`).
 * It is the ONLY digit-count guard needed: a ten-digit run never produces a
 * marker here, so `canStartListItem` can parse the value without re-checking.
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

/** One blockquote marker: up to three spaces of indent, then `>`. */
const BLOCKQUOTE_LEVEL_RE = /^ {0,3}>/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** Spaces only — a tab is never a column this module is willing to count. */
function isSpacesOnly(text: string): boolean {
  return /^ *$/.test(text);
}

/**
 * Consume one blockquote marker at `offset`, or return null.
 *
 * The single optional space after `>` is part of the marker (§5.1), so it is
 * consumed here rather than left for the content: without that, every quoted
 * line would read one column further right than it sits and a quoted fence's
 * own indentation budget would shift under it.
 */
function matchBlockquoteMarker(rawLine: string, offset: number): number | null {
  const marker = BLOCKQUOTE_LEVEL_RE.exec(rawLine.slice(offset));
  if (marker === null) return null;
  const afterMarker = offset + marker[0].length;
  return rawLine[afterMarker] === " " ? afterMarker + 1 : afterMarker;
}

/**
 * Walk the open containers against one line, outermost first.
 *
 * Returns how many matched and how far into the line they consumed. Matching
 * STOPS at the first container the line does not satisfy — everything inside it
 * has been left, which is what closes a fence that lived there.
 *
 * Blank lines are asymmetric, and the asymmetry is the spec's: a block quote
 * "can contain a blank line only if it's marked with >", so an unmarked blank
 * line leaves it, while a list item survives blank lines — an item's fence
 * routinely follows one, and its interior may contain them.
 */
function matchContainers(
  rawLine: string,
  containers: readonly ContainerEntry[],
): { matched: number; offset: number } {
  let offset = 0;
  let matched = 0;
  for (const entry of containers) {
    if (entry.kind === "blockquote") {
      const afterMarker = matchBlockquoteMarker(rawLine, offset);
      if (afterMarker === null) break;
      offset = afterMarker;
      matched++;
      continue;
    }
    const rest = rawLine.slice(offset);
    if (isBlank(rest)) {
      // The item survives, and there is nothing to consume.
      matched++;
      continue;
    }
    // Reaching the item's content must happen through SPACES: `abcd``` ` puts a
    // delimiter four columns in with four characters of prose in front of it,
    // and a blind slice reads that as the closer.
    if (!isSpacesOnly(rest.slice(0, entry.indent))) break;
    offset += entry.indent;
    matched++;
  }
  return { matched, offset };
}

/**
 * May a marker here actually START a list item?
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
 * The start number is the marker's VALUE, not its text: cmark accumulates the
 * digits (`start = (10 * start) + (c - '0')`) and then tests `start != 1`, so
 * `01.` and `0001)` are start-1 markers and may interrupt. Matching the literal
 * `1` refused them and dropped the container, mis-measuring every delimiter
 * beneath (Codex, PR #273 round 2).
 */
function canStartListItem(
  markerText: string,
  remainder: string,
  interruptsParagraph: boolean,
): boolean {
  if (!interruptsParagraph) return true;
  if (remainder === "") return false;
  if (!/^\d/.test(markerText)) return true;
  return Number.parseInt(markerText, 10) === 1;
}

/**
 * Open every container that STARTS on this line, from `offset` inward.
 *
 * Blockquote and list markers alternate freely here — `> - > ```md ` opens
 * three — which is the whole point of one heterogeneous stack. Each container
 * opened clears `interruptsParagraph`: whatever paragraph was open outside it
 * is not inside it, so a `> 10. item` under prose starts a legal start-10 list
 * even though `10.` could never have interrupted that paragraph directly
 * (Codex, PR #273 round 2).
 */
function openContainers(
  rawLine: string,
  startOffset: number,
  matchedContainers: readonly ContainerEntry[],
  paragraphIsOpen: boolean,
): { containers: readonly ContainerEntry[]; offset: number } {
  const containers = [...matchedContainers];
  let offset = startOffset;
  let interruptsParagraph = paragraphIsOpen;

  for (;;) {
    const rest = rawLine.slice(offset);
    if (THEMATIC_BREAK_PATTERN.test(rest)) break;

    const afterQuoteMarker = matchBlockquoteMarker(rawLine, offset);
    if (afterQuoteMarker !== null) {
      offset = afterQuoteMarker;
      containers.push({ kind: "blockquote" });
      interruptsParagraph = false;
      continue;
    }

    const marker = LIST_ITEM_MARKER_PATTERN.exec(rest);
    if (marker === null) break;
    const [, markerIndent, markerText, spacesAfterMarker, remainder] = marker;
    // `-foo` and `1.x` are paragraphs: a marker needs whitespace or the line's
    // end after it. A TAB there is declined with the rest of the tab handling
    // — the container is simply not pushed, leaving the line on the budget it
    // had before.
    if (spacesAfterMarker.length === 0 && remainder !== "") break;
    if (!canStartListItem(markerText, remainder, interruptsParagraph)) break;
    const markerWidth = markerIndent.length + markerText.length;
    // CommonMark 5.2: content begins after the marker's following spaces —
    // except that an EMPTY item, or one whose first content sits five-plus
    // spaces past the marker (that content is indented code), begins one
    // space past it.
    const indent =
      remainder === "" || spacesAfterMarker.length >= 5
        ? markerWidth + 1
        : markerWidth + spacesAfterMarker.length;
    containers.push({ kind: "listItem", indent });
    offset += indent;
    interruptsParagraph = false;
  }

  return { containers, offset };
}

/**
 * Is this line paragraph continuation text, for the NEXT line's purposes?
 *
 * Leaf blocks that are not paragraphs (§4.2 ATX headings, §4.1 thematic
 * breaks, §4.5 fenced code delimiters) and blank lines all end a paragraph;
 * everything else with content continues one.
 *
 * Over-reporting here only makes the interruption rule STRICTER — fewer
 * containers pushed, delimiters measured from further left, code read as prose,
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
 * BEGAN — after any container exit, before this line's own delimiter is
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
  const match = matchContainers(rawLine, state.containers);

  // A fence dies with the container it lived in, on the line that leaves it,
  // and dies BEFORE that line is processed.
  //
  // This is a derivation, not a policy choice. CommonMark laziness applies to
  // paragraph continuation text and nothing else, so fence CONTENT is never
  // lazily continued — the spec says outright that "we can't omit the `>` in
  // front of subsequent lines of an indented or fenced code block"
  // (CommonMark 0.31.2 §5.1). A line that fails to match one of the fence's
  // containers has left it, and the fence closes with it. Spec example 237 is
  // this exact shape:
  //
  //     > ```        ->  <blockquote><pre><code></code></pre></blockquote>
  //     foo              <p>foo</p>
  //     ```              <pre><code></code></pre>
  //
  // — note the third line RE-OPENS a fence at top level, which is why the line
  // is processed normally after the container closes rather than being skipped.
  //
  // The same rule covers a fence leaving a LIST ITEM, which the previous model
  // could not express and disclosed as a bound: a dedent out of `10. ` ends
  // the item, so the fence ends too and the prose below it is live. Eight of
  // this module's own fixtures pinned the old behaviour and disagreed with
  // cmark; the corpus incidence of the shape is zero, so no document moved.
  //
  // A top-level fence is the SAME rule at depth 0: no line can match fewer
  // than zero containers, so it dies only to its own closer.
  const held = state.openFence;
  const openFenceAtLineStart = held !== null && match.matched < held.containerDepth ? null : held;

  // While a fence is open the stack is FROZEN — fence content is opaque, so a
  // `- item` line inside one must not push a container, which would shift the
  // budget out from under the closer and leave the fence open over the rest of
  // the file (fail-silent, the direction that costs findings). With the freeze,
  // a surviving fence has necessarily matched every container it opened under,
  // so `match.offset` already points at its content.
  const matchedContainers = state.containers.slice(0, match.matched);
  // A paragraph is only interruptible where it is still REACHABLE: cmark asks
  // whether the deepest MATCHED container's open block is a paragraph. If a
  // container failed to match, the paragraph inside it is not what a marker on
  // this line would interrupt — `> prose` then `2. x` opens a start-2 list,
  // because laziness continues a paragraph only when no block start is
  // recognised at all.
  const paragraphIsOpen = state.inParagraph && match.matched === state.containers.length;
  const opened =
    openFenceAtLineStart === null
      ? openContainers(rawLine, match.offset, matchedContainers, paragraphIsOpen)
      : { containers: matchedContainers, offset: match.offset };
  const content = rawLine.slice(opened.offset);

  const settled = (isDelimiterLine: boolean, openFence: OpenFence | null): MarkdownScanState => ({
    containers: opened.containers,
    openFence,
    // Paragraph state describes the OUTER document, so it only moves where
    // containers do: inside a fence every line is opaque content, and the
    // closer is a delimiter line, which ends a paragraph anyway.
    inParagraph: openFenceAtLineStart !== null ? false : isParagraphText(content, isDelimiterLine),
  });

  // At most three SPACES past the container's content, then the delimiter
  // (CommonMark §4.5): four or more — or a tab, which expands past the limit —
  // makes the line indented-code CONTENT. The earlier `\s*` treated an indented
  // literal (`    ``` `) as an opener, exempting the ordinary prose after it
  // from the volatile-cite deny and §-cite extraction until the next delimiter
  // (Codex, PR #207 round 3).
  const fenceDelimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
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
        containerDepth: opened.containers.length,
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
    // ALREADY sits at the fence's own depth: a line that matched fewer
    // containers killed the fence above, and a deeper marker stays in the
    // content (the fence's containers are consumed, the surplus `>` is not) and
    // so never matches the delimiter pattern. An explicit depth guard reads
    // like a third check but is implied by those two — it can never decide
    // anything, so no mutation of it could fail a test. It was written,
    // measured as a SURVIVED mutation arm, and removed.
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
// anyway would hand a scanner a synthetic delimiter that bypasses its own
// indentation guard and exempts the following prose from the volatile-cite
// deny (Codex, PR #207 round 4).
//
// `advanceScanState` no longer calls this: it consumes quote markers one level
// at a time as it walks the container stack. Both remain exported because
// table-arity, label-cite and the plan-execution preflight read a line's quote
// prefix directly, without a document walk.
const BLOCKQUOTE_PREFIX_RE = /^(?: {0,3}>)+ ?/;

export function stripBlockquotePrefix(line: string): string {
  return line.replace(BLOCKQUOTE_PREFIX_RE, "");
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
