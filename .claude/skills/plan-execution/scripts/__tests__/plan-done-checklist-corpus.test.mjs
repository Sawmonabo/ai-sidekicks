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
// The container rules this file used to add on top of the tracker are now IN
// the tracker: a fence records how many containers were open when it opened,
// dies on the first line that matches fewer of them, and reads its interior
// after those containers are consumed — so a closer at another depth cannot
// reach it. They were worked out here across two findings, and moved down once
// the tracker grew a threaded scan state (task #83 round 2) — the local copies,
// and the exhaustive strip-parity control that guarded them, now live in the
// tracker's own suite against the live implementation rather than a copy.
//
// The tracker states this in CONTAINER terms rather than blockquote depth
// because quote depth alone could not express a quote nested inside a list
// item, which is what PR #273 round 2 corrected.
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
  advanceScanState,
  INITIAL_SCAN_STATE,
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
  let scanState = INITIAL_SCAN_STATE;
  let inComment = false;

  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;
    const commentOpenAtLineStart = inComment;

    // A FENCE LIVES IN THE CONTAINER IT OPENED IN — it dies at the first line
    // shallower than that container, its closer must match the opener's quote
    // depth, and while it is open a line is read relative to the fence's own
    // depth rather than flattened. All three rules, and the CommonMark 0.31.2
    // §5.1 derivation behind them, moved into the shared tracker
    // (tools/docs-corpus/lib/markdown-fences.ts) when it grew a threaded scan
    // state. This file is where they were worked out, across two findings in
    // the same fail-silent direction; a second copy here is exactly the drift
    // the shared module exists to end.
    // Stepped BEFORE the heading test, and the line's fenced-ness read off
    // `openFenceAtLineStart` rather than the pre-call state: a fence dies on
    // the very line that leaves its container, so the incoming state still
    // holds it and testing that would hide one live line.
    const advanced = commentOpenAtLineStart ? null : advanceScanState(line, scanState);
    const inFenceAtLineStart =
      advanced === null ? scanState.openFence !== null : advanced.openFenceAtLineStart !== null;

    const match = DONE_CHECKLIST_HEADING.exec(line);
    if (match) {
      const entry = { line: lineNumber, level: match[1].length };
      if (commentOpenAtLineStart) hidden.push({ ...entry, reason: "html-comment" });
      else if (inFenceAtLineStart) hidden.push({ ...entry, reason: "fenced-code" });
      else headings.push(entry);
    }

    // A fence delimiter inside an open comment is comment text, not a fence.
    //
    // The tracker takes the RAW line. Stripping the blockquote prefix before
    // the call is what blinded it to a container exit: the prefix is what
    // carries depth, so a pre-stripped line cannot express one.
    if (advanced !== null) scanState = advanced.state;
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
