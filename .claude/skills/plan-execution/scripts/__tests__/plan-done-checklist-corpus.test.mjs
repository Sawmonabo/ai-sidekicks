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
  let inComment = false;

  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;
    const commentOpenAtLineStart = inComment;
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
    // quoted opener (`> ```md`) hides quoted example headings the same way an
    // unquoted one does. The heading test above stays on the RAW line, so
    // `> ## quoted` is still correctly not a heading.
    if (!commentOpenAtLineStart) {
      ({ openFence } = advanceFenceState(stripBlockquotePrefix(line), openFence));
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
