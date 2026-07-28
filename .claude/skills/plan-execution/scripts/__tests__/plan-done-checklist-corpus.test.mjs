// Corpus invariant: the Done Checklist shape of every plan in docs/plans/.
//
// The housekeeper's plan-checklist tick was retired because it keyed on a
// `#### Done Checklist` nested under `### Phase N` — a shape no plan has ever
// carried. Plans put a single document-level `## Done Checklist` at the end
// instead, so the tick never fired once in production and the run still exited
// clean. The design spec states that as prose; prose cannot notice the next
// plan file added to the corpus. This suite is the enforcement the spec cites
// in place of an uncited claim, and it is what makes "no phase-nested
// checklist exists" a fact about the repo rather than a fact about the day it
// was written.
//
// Two properties are asserted per file, both load-bearing:
//   1. exactly one heading named `Done Checklist`, and
//   2. that heading is at level 2 (`##`) — never level 3-6, the retired shape.
//
// The corpus is enumerated at RUNTIME and no file count is pinned anywhere,
// including in assertion messages: a pinned count is the same staleness this
// test exists to prevent.
//
// Run via:
//   node --test --experimental-strip-types \
//     .claude/skills/plan-execution/scripts/__tests__/plan-done-checklist-corpus.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// The ONE fence tracker. This file used to carry its own copy, byte-equal in
// rule set but enforced by nothing — the CommonMark fence rules have already
// been corrected four times (PR #207 rounds 2-4), and the next correction
// would have landed in one copy only. Importing the canonical module is what
// makes "these agree" a fact rather than a coincidence maintained by hand.
//
// Cross-extension import (`.mjs` importing `.ts`) is sound HERE and only here:
// the test runner passes `--experimental-strip-types`. Bare `node` cannot load
// it at all (ERR_UNKNOWN_FILE_EXTENSION on 22.12), which is why production
// `preflight.mjs` keeps its own tracker rather than importing this one.
//
// DIVERGENCE: the tracker treats quoted and unquoted fences as one flat state
// stream, and its strip is depth-agnostic — it removes every blockquote level,
// so it cannot tell a depth-2 line from a depth-1 one. This scanner records the
// DEPTH its fence opened at and hands the tracker each line reduced to exactly
// that container (see findDoneChecklistHeadings). The tracker's own rule set is
// untouched — this is a container layer above it, so the two cannot drift.
//
// The result is spec-faithful on every shape the flat stream gets wrong: a
// quote-opened fence ends at the first line SHALLOWER than its opener, a DEEPER
// line inside it is content rather than a closer, and a quoted delimiter inside
// an unquoted fence is content too.
//
// The tracker's depth-agnostic strip still exists, but it is no longer reachable
// through this scanner for any depth decision: every line handed to it has
// already had exactly the opener's levels removed, so a `>> ``` ` line arrives
// as `> ``` ` and fails the delimiter pattern instead of closing a depth-1
// fence. What remains inherited is only what the tracker decides about a line
// ALREADY reduced to its container — the delimiter, info-string, and indent
// rules — which is the shared behaviour this scanner wants.
//
// No error direction here is safe, which is why correctness is tracked rather
// than a preferred failure mode. Both of this file's assertions are EQUALITY
// assertions (exactly one heading, at level 2), so over-reporting and
// under-reporting each produce a silent pass on some real document: swallow a
// heading and a duplicate goes unseen; invent one and a plan carrying no
// checklist reports a clean single. An earlier revision of this comment claimed
// over-reporting was the loud direction. It is not — that claim was refuted by
// the fenced-example counterexample the D=0 case now handles, and the
// depth-agnostic strip it replaced produced BOTH directions from one defect.
import {
  advanceFenceState,
  stripBlockquotePrefix,
} from "../../../../../tools/docs-corpus/lib/markdown-fences.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const PLANS_DIR = join(REPO_ROOT, "docs/plans");

// A heading line, per CommonMark ATX: 0-3 leading spaces, 1-6 `#`, then at
// least one space before the text. Matched on the exact heading text, so a
// renamed or decorated heading counts as ZERO rather than being silently
// accepted as a variant — that direction fails the per-file assertion loudly
// instead of passing on a heading nobody meant.
const DONE_CHECKLIST_HEADING = /^ {0,3}(#{1,6})[ \t]+Done Checklist[ \t]*$/;

// The one legal level. Named rather than repeated so a condition and the
// failure message explaining it can never disagree — a perturbation control
// caught them drifting apart while this suite was being written.
const DOCUMENT_LEVEL = 2;

// ONE blockquote level, with CommonMark's marker-indent budget: at most three
// SPACES before the `>`. Four spaces (or a tab) makes the line indented code,
// not a quote — the same boundary the shared tracker's strip enforces, and the
// reason this cannot be `\s*>`.
//
// This is deliberately the inner group of the shared `^(?: {0,3}>)+ ?` and
// nothing more. Repeating it N times plus ONE trailing optional space is that
// pattern's exact semantics, which is what lets the two agree by construction
// rather than by inspection — pinned exhaustively by a control below.
const QUOTE_LEVEL_RE = /^ {0,3}>/;

/**
 * How many blockquote levels a line opens with.
 *
 * @param {string} line
 * @returns {number}
 */
function quoteDepth(line) {
  let depth = 0;
  let rest = line;
  for (;;) {
    const next = rest.replace(QUOTE_LEVEL_RE, "");
    if (next === rest) return depth;
    depth++;
    rest = next;
  }
}

/**
 * Strip EXACTLY `levels` blockquote levels — no more, no fewer.
 *
 * The shared `stripBlockquotePrefix` removes ALL of them, which is the right
 * thing when no fence is open and the wrong thing inside one: a line deeper
 * than the fence's container is fence CONTENT, and flattening it hands the
 * tracker a delimiter that closes a fence the spec says is still open.
 *
 * Zero levels returns the line untouched, INCLUDING any leading space. That is
 * not an optimisation — the shared pattern's trailing ` ?` sits inside a match
 * that requires at least one level, so with no levels present nothing is
 * stripped at all. Consuming a space here would silently corrupt the
 * unquoted-fence arm, where the raw line is what the tracker must see.
 *
 * Callers guarantee `quoteDepth(line) >= levels`.
 *
 * @param {string} line
 * @param {number} levels
 * @returns {string}
 */
function stripQuoteLevels(line, levels) {
  if (levels === 0) return line;
  let rest = line;
  for (let level = 0; level < levels; level++) {
    rest = rest.replace(QUOTE_LEVEL_RE, "");
  }
  return rest.replace(/^ ?/, "");
}

/**
 * Every string over `alphabet` up to `maxLength` characters, shortest first.
 *
 * Test-local on purpose. A sibling suite carries its own copy for a different
 * alphabet and bound; the copies cannot drift into a false clean because each
 * pins its own enumeration SIZE against a closed form, so a generator that
 * stopped early would fail there rather than quietly sweep a smaller space.
 *
 * @param {string[]} alphabet
 * @param {number} maxLength
 * @returns {Generator<string>}
 */
function* stringsOverAlphabet(alphabet, maxLength) {
  const buffer = [];
  function* extend() {
    yield buffer.join("");
    if (buffer.length === maxLength) return;
    for (const character of alphabet) {
      buffer.push(character);
      yield* extend();
      buffer.pop();
    }
  }
  yield* extend();
}

/**
 * Advance HTML-comment state by one line. Every plan file carries HTML
 * comments (template guidance), so a `## Done Checklist` inside one is a
 * reachable phantom, not a hypothetical.
 *
 * @param {string} line
 * @param {boolean} inComment
 * @returns {boolean} whether a comment is still open AFTER this line
 */
function advanceCommentState(line, inComment) {
  let open = inComment;
  let index = 0;
  while (index < line.length) {
    if (open) {
      const close = line.indexOf("-->", index);
      if (close === -1) return true;
      open = false;
      index = close + 3;
    } else {
      const start = line.indexOf("<!--", index);
      if (start === -1) return false;
      open = true;
      index = start + 4;
    }
  }
  return open;
}

/**
 * Find every REAL `Done Checklist` heading in a markdown source — those that
 * render as headings, excluding ones hidden inside fenced code blocks or HTML
 * comments.
 *
 * Note the asymmetry this function carries: skipping hidden regions makes it
 * strictly MORE permissive, so a bug in the fence or comment logic produces a
 * false PASS. That is the exact defect class this suite belongs to, which is
 * why `hidden` is returned rather than discarded and why the controls below
 * pin the hidden-region behavior directly instead of only the happy path.
 *
 * @param {string} source
 * @returns {{ headings: Array<{ line: number, level: number }>,
 *             hidden: Array<{ line: number, level: number, reason: string }> }}
 */
function findDoneChecklistHeadings(source) {
  const headings = [];
  const hidden = [];
  let openFence = null;
  let fenceQuoteDepth = 0;
  let inComment = false;

  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;
    const commentOpenAtLineStart = inComment;
    const depth = quoteDepth(line);

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
    // — note the third line RE-OPENS a fence at top level, which is why the
    // line is processed normally after the container closes rather than being
    // skipped.
    //
    // DEPTH, not quotedness. The predecessor of this rule asked only "is the
    // line unquoted?", which is the depth>=1 -> 0 case of it, and that gap was
    // exploitable: inside a `> ``` ` fence, a `> <!--` line is still in the
    // container and must NOT end it, while a depth-1 line inside a `>> ``` `
    // fence has left the container and must. A boolean cannot say both.
    //
    // The unquoted-opened fence is the SAME rule at D=0: no line can be
    // shallower than depth 0, so the fence never dies here and only its own
    // closer ends it — which is why there is no separate arm for it. That is
    // the second special case this rule absorbed rather than accumulated.
    //
    // Two earlier revisions enumerated the line types that end a blockquote —
    // first ATX headings, then unquoted lines. Each drew a finding for the case
    // it missed (`<!--` under the first, quote DEPTH under the second), because
    // enumerating line types is the wrong mechanism; asking whether the line is
    // still inside the container the fence opened in is the right one.
    if (openFence !== null && depth < fenceQuoteDepth) {
      openFence = null;
      fenceQuoteDepth = 0;
    }

    const inFenceAtLineStart = openFence !== null;

    const match = DONE_CHECKLIST_HEADING.exec(line);
    if (match) {
      const entry = { line: lineNumber, level: match[1].length };
      if (commentOpenAtLineStart) hidden.push({ ...entry, reason: "html-comment" });
      else if (inFenceAtLineStart) hidden.push({ ...entry, reason: "fenced-code" });
      else headings.push(entry);
    }

    // A fence delimiter inside an open comment is comment text, not a fence.
    //
    // A FENCE'S DELIMITERS LIVE IN THE CONTAINER WHERE IT OPENED. One rule,
    // parameterised by that container's depth D — which line form the tracker
    // sees is decided by the open fence, never by the current line:
    //
    //   no fence open -> ALL levels stripped, so a quoted opener (`> ```md`) is
    //                    seen at all; `fenceQuoteDepth` then records the depth
    //                    it opened at.
    //   fence open    -> EXACTLY D levels stripped, so the line is expressed
    //                    relative to the fence's own container. A line at depth
    //                    D reads as the tracker's ordinary case; a DEEPER line
    //                    still carries `>` afterwards, fails the delimiter
    //                    pattern, and is CONTENT — which is what the spec says.
    //
    // D=0 is the unquoted-opened fence and needs no arm of its own: stripping
    // zero levels is the raw line, so a `> ``` ` inside a top-level fence is
    // content by the same sentence.
    //
    // This is where two rounds of false cleans lived, both in the same
    // direction. A `> ``` ` line cannot close a top-level fence, and a
    // `>> ``` ` line cannot close a `> ``` ` one: CommonMark allows a closer at
    // most three spaces of indentation, and a blockquote marker is not
    // indentation, so inside an open fence either line is literal content.
    // Flattening it closed the fence early, turned the rest of the document
    // into live markdown, and let example content be read as real. Against the
    // `exactly one` assertion that direction is SILENT, not loud — it takes a
    // file from zero real headings to one, landing on the passing value, so a
    // plan carrying no Done Checklist sails through the gate whose whole job is
    // noticing that. The same flattening also ends the fence early enough to
    // start comment tracking on a `> <!--` line, which then hides a REAL
    // heading — the under-reporting direction, in the same defect.
    //
    // Note what this is NOT: the heading test runs on the RAW line, so a quoted
    // heading (`> ## …`) never matches and is never a candidate, fence or no
    // fence. Fence tracking is not what hides those.
    if (!commentOpenAtLineStart) {
      const fenceLine = inFenceAtLineStart
        ? stripQuoteLevels(line, fenceQuoteDepth)
        : stripBlockquotePrefix(line);
      ({ openFence } = advanceFenceState(fenceLine, openFence));
      if (!inFenceAtLineStart && openFence !== null) fenceQuoteDepth = depth;
      if (openFence === null) fenceQuoteDepth = 0;
    }
    // Fenced code cannot open an HTML comment.
    if (!inFenceAtLineStart) inComment = advanceCommentState(line, inComment);
  }

  return { headings, hidden };
}

// ---------------------------------------------------------------------------
// Controls — these run BEFORE the corpus assertions so that a broken
// classifier is reported as a classifier failure rather than as a clean corpus.
// Each control feeds the checker an input it MUST reject.
// ---------------------------------------------------------------------------

test("control: the retired phase-nested shape is detected, not ignored", () => {
  const { headings } = findDoneChecklistHeadings(
    ["# Plan-099", "", "### Phase 1 — stub", "", "#### Done Checklist", "", "- [ ] One"].join("\n"),
  );
  assert.equal(headings.length, 1);
  assert.equal(headings[0].level, 4, "a level-4 heading must report level 4, not be normalized");
});

test("control: a file with no Done Checklist heading reports zero", () => {
  const { headings } = findDoneChecklistHeadings(
    "# Plan-099\n\n## Progress Log\n\n- nothing here\n",
  );
  assert.equal(headings.length, 0);
});

test("control: two document-level headings report two", () => {
  const { headings } = findDoneChecklistHeadings(
    ["# Plan-099", "", "## Done Checklist", "", "- [ ] One", "", "## Done Checklist", ""].join(
      "\n",
    ),
  );
  assert.equal(headings.length, 2);
});

test("control: a heading inside a fenced code block is NOT a heading", () => {
  // The false-pass guard. Fence handling only ever REMOVES findings, so this
  // is the direction in which a bug goes unnoticed: a doc whose sole
  // occurrence is fenced must report zero real headings, never one.
  const { headings, hidden } = findDoneChecklistHeadings(
    ["# Plan-099", "", "```md", "## Done Checklist", "```", ""].join("\n"),
  );
  assert.equal(headings.length, 0, "a fenced example must not count as a real heading");
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].reason, "fenced-code");
});

test("control: a fence nested in a longer fence does not leak headings out", () => {
  // A 4-backtick fence contains 3-backtick lines; the inner runs must not
  // close the outer block and expose the heading between them.
  const { headings, hidden } = findDoneChecklistHeadings(
    ["# Plan-099", "", "````md", "```", "## Done Checklist", "```", "````", ""].join("\n"),
  );
  assert.equal(headings.length, 0);
  assert.equal(hidden.length, 1);
});

test("control: a backtick info string containing a backtick opens no fence", () => {
  // ```` ```ts`x ```` is inline code, not a delimiter — the heading after it is
  // real, and a scanner that swallowed it would under-report.
  const { headings } = findDoneChecklistHeadings(
    ["# Plan-099", "", "```ts`x", "", "## Done Checklist", ""].join("\n"),
  );
  assert.equal(headings.length, 1);
  assert.equal(headings[0].level, 2);
});

test("control: an unclosed quoted fence does not hide the heading that follows it", () => {
  // The false-clean this file's fence handling used to carry. The quoted fence
  // is never closed, so a flat tracker keeps it open past the blockquote and
  // swallows every later heading — including a duplicate, which is exactly what
  // this suite exists to catch.
  //
  // The BLANK line is what ends the quote here, one line before the heading —
  // a blank line carries no blockquote marker, so the container rule fires on
  // it. The heading is then read outside any fence.
  const { headings, hidden } = findDoneChecklistHeadings(
    ["# Plan-099", "", "> ```md", "> ## quoted example", "", "## Done Checklist", ""].join("\n"),
  );
  assert.equal(headings.length, 1, "the blank line ends the blockquote; the heading is real");
  assert.equal(headings[0].level, 2);
  assert.equal(hidden.length, 0);
});

test("control: an unquoted heading inside a quoted fence COUNTS", () => {
  // Not a judgement call — a consequence of the container rule. The heading is
  // unquoted, so the blockquote has already ended by that line and the fence
  // died with it; CommonMark and every renderer show a real heading here. An
  // author may have MEANT it as example content, but that is a defect in the
  // example, not in the scanner, and the loud direction is the safe one.
  //
  // Flipping this expectation means abandoning the container rule, not tuning
  // a threshold — see findDoneChecklistHeadings.
  const { headings } = findDoneChecklistHeadings(
    ["# Plan-099", "", "> ```md", "## Done Checklist", "> ```", ""].join("\n"),
  );
  assert.equal(headings.length, 1);
  assert.equal(headings[0].level, 2);
});

test("control: an unquoted `<!--` ends the quoted fence, so the comment can hide a heading", () => {
  // The round-2 finding, and the input that separates the container rule from
  // the ATX-only rule it replaced. Under the narrow rule `<!--` did not end the
  // fence, the open fence suppressed comment tracking, and the checklist line
  // inside the comment was then counted by the ATX escape — a phantom heading,
  // and a false duplicate in any doc that also carries its real checklist.
  const { headings, hidden } = findDoneChecklistHeadings(
    ["# Plan-099", "", "> ```md", "<!--", "## Done Checklist", "-->", ""].join("\n"),
  );
  assert.equal(headings.length, 0, "the heading is inside an HTML comment and is not real");
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].reason, "html-comment", "hidden by the comment, not by the dead fence");
});

test("control: a quoted closer re-opens a quoted fence, bounded to the next unquoted line", () => {
  // A sloppy example — quoted opener, lazy unquoted body, quoted closer. The
  // fence dies at the lazy line, and the closer then RE-OPENS a quoted fence
  // (CommonMark 0.31.2 example 237 has the same re-open at top level). That is
  // the PR-#207 reopen class, which is why it is pinned rather than assumed
  // harmless: here it is bounded to one line, because the new fence is itself
  // quote-opened and dies at the next unquoted line — so the real heading that
  // follows still counts. Were it unbounded, every heading after a sloppy
  // example would vanish.
  const { headings } = findDoneChecklistHeadings(
    ["# Plan-099", "", "> ```md", "lazy text", "> ```", "## Done Checklist", ""].join("\n"),
  );
  assert.equal(headings.length, 1, "the re-opened fence must not swallow the real heading");
  assert.equal(headings[0].level, 2);
});

test("control: a QUOTED example heading inside a quoted fence stays hidden", () => {
  // The complement of the boundary above: the shape an author who quoted the
  // whole example actually writes must still not count.
  //
  // It is hidden by the HEADING REGEX, not by the fence — `> ## Done Checklist`
  // never matches a pattern anchored at `#`, so it is not even a candidate and
  // never reaches `hidden`. Asserting a `fenced-code` reason here would be
  // asserting a fiction; the empty `hidden` is the true observation and is
  // pinned as such.
  const { headings, hidden } = findDoneChecklistHeadings(
    ["# Plan-099", "", "> ```md", "> ## Done Checklist", "> ```", "", "## Done Checklist", ""].join(
      "\n",
    ),
  );
  assert.equal(headings.length, 1, "only the real heading counts, not the quoted example");
  assert.equal(headings[0].level, 2);
  assert.deepEqual(hidden, [], "the quoted line is never a heading candidate in the first place");
});

test("control: a quoted line inside an UNQUOTED fence is content, not a closer", () => {
  // The false clean this scanner shipped for two rounds, now the D=0 case's
  // regression guard. `> ``` ` cannot close a top-level fence: CommonMark
  // permits a closer at most three spaces of indentation, and a blockquote
  // marker is not indentation, so inside an open fence that line is literal
  // content. This whole document is one fenced example and contains NO real
  // checklist heading.
  //
  // Why it was silent rather than loud, which is the part the earlier ruling
  // got backwards: the corpus assertion is `exactly one`. Closing the fence on
  // the quoted line made the example heading count, taking the file from zero
  // real headings to one — straight onto the passing value. A plan carrying no
  // Done Checklist at all would have sailed through the gate whose entire job
  // is to notice that.
  const { headings, hidden } = findDoneChecklistHeadings(
    ["# Plan-099", "", "```md", "> ```", "## Done Checklist", "", "- [ ] example", ""].join("\n"),
  );
  assert.equal(headings.length, 0, "the document has no real checklist; the fence never closed");
  assert.deepEqual(
    hidden.map((entry) => entry.reason),
    ["fenced-code"],
    "the heading is hidden as fence CONTENT",
  );
});

test("control: a DEEPER delimiter inside a quoted fence is content, so a duplicate is caught", () => {
  // The round-4 finding, and the one that turns quote DEPTH from a documented
  // residual into a defect. Every line here is doing work:
  //
  //   > ```md   opens a fence in the depth-1 quote.
  //   >> ```    is DEEPER, so per CommonMark it is fence content — it cannot
  //             close a fence whose container it is nested inside.
  //   > <!--    is still at depth 1, so it is inside the fence too, and fenced
  //             code cannot open an HTML comment.
  //   ##        drops to depth 0, ending container and fence together.
  //
  // The document therefore has TWO real checklist headings — a duplicate, the
  // precise thing this suite exists to catch. A depth-agnostic strip flattens
  // `>> ``` ` to a closer, ends the fence there, lets `> <!--` open a comment
  // that swallows the first heading, and reports exactly one. That is a pass.
  const { headings, hidden } = findDoneChecklistHeadings(
    [
      "# Plan-099",
      "",
      "> ```md",
      ">> ```",
      "> <!--",
      "## Done Checklist",
      "-->",
      "## Done Checklist",
      "",
    ].join("\n"),
  );
  assert.equal(headings.length, 2, "both headings are real — the duplicate must be detected");
  assert.deepEqual(hidden, [], "nothing is hidden: the comment marker never left the fence");
});

test("control: a fence opened at depth 2 dies at a depth-1 line and at an unquoted one", () => {
  // Both kill directions for D=2. The first is the one a quotedness boolean
  // cannot express at all: `> <!--` is quoted, so the predecessor rule left the
  // fence open, suppressed comment tracking, and read the heading as real.
  const shallower = findDoneChecklistHeadings(
    ["# Plan-099", "", ">> ```md", "> <!--", "## Done Checklist", "-->", ""].join("\n"),
  );
  assert.equal(shallower.headings.length, 0, "the depth-1 line ended the depth-2 container");
  assert.deepEqual(
    shallower.hidden.map((entry) => entry.reason),
    ["html-comment"],
    "with the fence dead, the comment is live and hides the heading",
  );

  // The full drop to depth 0 must kill it too — a multi-level fall, not just
  // the single step the D=1 controls above exercise.
  const unquoted = findDoneChecklistHeadings(
    ["# Plan-099", "", ">> ```md", "<!--", "## Done Checklist", "-->", ""].join("\n"),
  );
  assert.equal(unquoted.headings.length, 0);
  assert.deepEqual(
    unquoted.hidden.map((entry) => entry.reason),
    ["html-comment"],
  );
});

test("control: a depth-2 closer closes a depth-2 fence", () => {
  // The complement of the deeper-delimiter control: at its OWN depth the line
  // is an ordinary closer and must close. Stripping one level short leaves
  // `> ``` `, which fails the delimiter pattern and holds the fence open over
  // the rest of the document — so this pins "exactly D", not "at least one".
  const { headings, hidden } = findDoneChecklistHeadings(
    ["# Plan-099", "", ">> ```md", ">> ```", ">> <!--", "## Done Checklist", "-->", ""].join("\n"),
  );
  assert.equal(headings.length, 0, "the fence closed, so the comment that follows it is live");
  assert.deepEqual(
    hidden.map((entry) => entry.reason),
    ["html-comment"],
  );
});

test("control: the depth-limited strip agrees with the shared strip at full depth", () => {
  // `stripQuoteLevels(line, quoteDepth(line))` must equal the shared
  // `stripBlockquotePrefix(line)` for every line — that equality is what makes
  // the local helper a REFINEMENT of the shared one rather than a second
  // implementation of it, and it is the only thing standing between "exactly D
  // levels" and a subtly different prefix grammar.
  //
  // Checked by exhaustive enumeration rather than by examples. The alphabet is
  // the grammar's own: quote marker, both indent characters, a fence character,
  // and one ordinary letter — nothing else can change how the prefix parses.
  const QUOTE_ALPHABET = [" ", "\t", ">", "`", "a"];
  const BOUND = 6;

  let checked = 0;
  const divergent = [];
  // Non-vacuity, measured in the SAME pass: a helper that strips the trailing
  // space even at zero levels must be SEPARATED by this enumeration. That is
  // the exact slip the D=0 arm rides on — it would feed the tracker a line one
  // space short and silently change indent-budget decisions.
  let separatedFromZeroLevelSlip = 0;
  const zeroLevelSlip = (line, levels) => {
    let rest = line;
    for (let level = 0; level < levels; level++) rest = rest.replace(QUOTE_LEVEL_RE, "");
    return rest.replace(/^ ?/, "");
  };

  for (const line of stringsOverAlphabet(QUOTE_ALPHABET, BOUND)) {
    checked++;
    const depth = quoteDepth(line);
    if (stripQuoteLevels(line, depth) !== stripBlockquotePrefix(line)) divergent.push(line);
    if (zeroLevelSlip(line, depth) !== stripBlockquotePrefix(line)) separatedFromZeroLevelSlip++;
  }

  assert.deepEqual(
    divergent.slice(0, 8),
    [],
    `depth-limited strip diverges on ${divergent.length}`,
  );
  // The closed form for sum(5^k, k=0..BOUND). Pinned so a generator that
  // silently stops early cannot report a clean sweep over almost nothing.
  assert.equal(checked, (QUOTE_ALPHABET.length ** (BOUND + 1) - 1) / (QUOTE_ALPHABET.length - 1));
  assert.ok(
    separatedFromZeroLevelSlip > 0,
    "the enumeration cannot separate a wrong zero-level case — it proves nothing",
  );
});

test("control: a heading inside an HTML comment is NOT a heading", () => {
  const { headings, hidden } = findDoneChecklistHeadings(
    ["# Plan-099", "", "<!--", "## Done Checklist", "-->", ""].join("\n"),
  );
  assert.equal(headings.length, 0);
  assert.equal(hidden[0].reason, "html-comment");
});

test("control: a closed comment does not hide the heading that follows it", () => {
  const { headings } = findDoneChecklistHeadings(
    ["# Plan-099", "", "<!-- guidance -->", "", "## Done Checklist", ""].join("\n"),
  );
  assert.equal(headings.length, 1);
});

test("control: the well-formed shape passes", () => {
  const { headings, hidden } = findDoneChecklistHeadings(
    ["# Plan-099", "", "### Phase 1 — stub", "", "## Done Checklist", "", "- [ ] One", ""].join(
      "\n",
    ),
  );
  assert.equal(headings.length, 1);
  assert.equal(headings[0].level, 2);
  assert.equal(hidden.length, 0);
});

// ---------------------------------------------------------------------------
// The corpus invariant itself.
// ---------------------------------------------------------------------------

function readPlanCorpus() {
  return readdirSync(PLANS_DIR)
    .filter((name) => /^\d{3}-.*\.md$/.test(name))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(PLANS_DIR, name), "utf8") }));
}

test("the plan corpus is non-empty", () => {
  // Fail closed. A glob that silently matches nothing would let every
  // assertion below vacuously pass, which is the failure this suite is a
  // reaction to.
  assert.ok(readPlanCorpus().length > 0, `no plan files found under ${PLANS_DIR}`);
});

test("every plan carries exactly one document-level `## Done Checklist`", () => {
  const offenders = [];
  for (const { name, source } of readPlanCorpus()) {
    const { headings } = findDoneChecklistHeadings(source);
    if (headings.length !== 1) {
      offenders.push(`${name}: found ${headings.length} \`Done Checklist\` headings, expected 1`);
    } else if (headings[0].level !== DOCUMENT_LEVEL) {
      offenders.push(
        `${name}:${headings[0].line}: \`Done Checklist\` is at level ${headings[0].level}, expected ${DOCUMENT_LEVEL}`,
      );
    }
  }
  assert.deepEqual(offenders, [], `plan Done Checklist shape violations:\n${offenders.join("\n")}`);
});

test("no plan carries a phase-nested `#### Done Checklist`", () => {
  // Stated separately from the shape assertion above even though it follows
  // from it, because THIS is the property the design spec cites: the retired
  // tick keyed on a level-3-to-6 heading, and the reason it never fired is
  // that the corpus contains none.
  const offenders = [];
  for (const { name, source } of readPlanCorpus()) {
    for (const heading of findDoneChecklistHeadings(source).headings) {
      if (heading.level > DOCUMENT_LEVEL) {
        offenders.push(
          `${name}:${heading.line}: nested \`Done Checklist\` at level ${heading.level}`,
        );
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `phase-nested Done Checklist headings found:\n${offenders.join("\n")}`,
  );
});
