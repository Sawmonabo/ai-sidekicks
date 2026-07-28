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
// DIVERGENCE, deliberate and one-directional: the tracker treats quoted and
// unquoted fences as one flat state stream. This scanner is STRICTER — it also
// tracks whether a quote-opened fence is still inside its blockquote, and ends
// it at the first unquoted line (see findDoneChecklistHeadings). The tracker's
// rule set is untouched; this is a container rule layered above it, so the two
// cannot drift.
//
// The asymmetry is deliberate because this is a DUPLICATE-DETECTION surface,
// where the two error directions are not equally bad. Ending the fence too
// eagerly over-reports a heading — loud, and the failure names the file and
// line. Keeping it open too long swallows every heading after it, so a genuine
// duplicate `## Done Checklist` goes unseen and the suite reports clean. A
// scanner whose whole purpose is catching duplicates must not fail in the
// direction that hides them.
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
  let fenceOpenedInQuote = false;
  let inComment = false;

  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;
    const commentOpenAtLineStart = inComment;

    // A fence opened inside a blockquote dies at the FIRST unquoted line,
    // whatever that line is, and dies BEFORE the line is processed.
    //
    // This is a derivation, not a policy choice. CommonMark laziness applies to
    // paragraph continuation text and nothing else, so fence CONTENT is never
    // lazily continued — the spec says outright that "we can't omit the `>` in
    // front of subsequent lines of an indented or fenced code block"
    // (CommonMark 0.31.2 §5.1). An unquoted line therefore ends the container,
    // and the fence inside it closes with the container. Spec example 237 is
    // this exact shape:
    //
    //     > ```        ->  <blockquote><pre><code></code></pre></blockquote>
    //     foo              <p>foo</p>
    //     ```              <pre><code></code></pre>
    //
    // — note the third line RE-OPENS a fence at top level, which is why the
    // line is processed normally after the container closes rather than being
    // skipped.
    //
    // This replaced an ATX-heading-only version of the same rule. That form was
    // a special case of this one and drew a finding for each case it missed:
    // `<!--` also ends the quote (HTML block type 2 interrupts a paragraph, so
    // it is never lazy continuation), and under the narrow rule the fence
    // stayed open across it, suppressed comment tracking, and then let a
    // checklist heading INSIDE the comment count as real — a phantom, and a
    // false duplicate in any doc that also has its real checklist. Enumerating
    // line types that end a blockquote is the wrong mechanism; asking whether
    // the line is still in the blockquote is the right one.
    //
    // Scoped to a fence opened INSIDE a quote: an ordinary unquoted fence is in
    // no container, so its unquoted content lines are just content and must
    // keep hiding the headings in them — the control directly below.
    //
    // Measured, and narrow on purpose: FOR A QUOTE-OPENED FENCE this rule makes
    // the quoted-fence tracking below unobservable, because the heading pattern
    // is anchored at `#` on the RAW line — so any heading such a fence could
    // hide is unquoted, and an unquoted line has already ended the container.
    // The tracking is kept because that equivalence rests on the anchoring:
    // move the pattern to the stripped line and dropping this rule silently
    // restores the round-1 swallowed-heading defect. The claim does NOT extend
    // to quoted fence lines generally — a quoted CLOSER on an unquoted fence is
    // observable, and has its own control below.
    if (openFence !== null && fenceOpenedInQuote && stripBlockquotePrefix(line) === line) {
      openFence = null;
      fenceOpenedInQuote = false;
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
    // The shared tracker's contract takes a BLOCKQUOTE-STRIPPED line, so a
    // quoted opener (`> ```md`) is recognised as a delimiter at all — which is
    // what `fenceOpenedInQuote` above needs in order to know the fence began
    // inside a container. It is NOT what hides quoted example headings: the
    // heading test runs on the RAW line, so `> ## quoted` fails to match and is
    // never a candidate, fence or no fence.
    if (!commentOpenAtLineStart) {
      const stripped = stripBlockquotePrefix(line);
      ({ openFence } = advanceFenceState(stripped, openFence));
      if (!inFenceAtLineStart && openFence !== null) fenceOpenedInQuote = stripped !== line;
      if (openFence === null) fenceOpenedInQuote = false;
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

test("control: a quoted closer ends an UNQUOTED fence — the tracker's approximation, pinned", () => {
  // The one shape where handing `advanceFenceState` the stripped line rather
  // than the raw one is observable in this scanner's output, so it is the only
  // thing pinning that call. Without it, the stripped/raw choice is a free
  // variable no assertion here constrains (mutation-measured).
  //
  // This deviates from strict CommonMark, deliberately and by inheritance: a
  // `> ``` ` line is NOT a valid closer for a top-level fence — inside an open
  // fence it is content, so a spec parser keeps the fence open and hides the
  // heading. The shared tracker declines to match quote DEPTH between opener
  // and closer (its documented pragmatic bound for illustrative examples), and
  // this scanner inherits that.
  //
  // Pinned rather than filed as a defect because the inherited behavior errs in
  // the LOUD direction — it over-reports a heading. The spec-exact behavior
  // hides one, which on a duplicate-detection surface is the silent failure
  // this suite exists to prevent. If the shared tracker ever tightens to match
  // quote depth, this control fails and names the decision instead of letting
  // the corpus census quietly shrink.
  const { headings, hidden } = findDoneChecklistHeadings(
    ["# Plan-099", "", "```md", "> ```", "## Done Checklist", ""].join("\n"),
  );
  assert.equal(headings.length, 1, "the quoted closer ends the unquoted fence");
  assert.equal(headings[0].level, 2);
  assert.deepEqual(hidden, []);
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
