// Discriminating mutation matrix over the shared fence tracker: each arm must
// fail a DIFFERENT subset of the suites. An arm that fails nothing means the
// behavior is untested; two arms failing identical sets means one of those
// tests is redundant. Sibling of `mutate-table-arity.ts`, same mechanism, same
// rules — see that file's header for the reasoning behind the shape.
//
// Usage (author-invoked; NEVER wire this into CI or any hook — it MUTATES the
// working tree while it runs):
//
//   node --experimental-strip-types tools/docs-corpus/harness/mutate-markdown-fences.ts
//
// TWO SUITES, one failure set. `markdown-fences.test.ts` pins each rule at its
// own boundary; `commonmark-oracle.test.ts` checks the ensemble against the
// reference parser. An arm's signature is the union, because the two catch
// different things: the oracle notices shapes nobody wrote a fixture for, and
// the direct suite notices rules the oracle's fixture set never reaches.
//
// ARM PROVENANCE. M1-M20 were measured against the container-stack rewrite
// (PR #273 round 2). M21-M25 carry forward the round-1 suite's P4-P7 and S1
// arms, re-anchored. They are called out because of HOW they went missing: the
// round-2 matrix was written fresh against rewritten code, so those anchors
// moved and a fresh matrix simply never asked about them. That is arm decay
// with no SKIPPED report to show for it — the arm was not skipped, it was never
// carried over — and it is the reason this matrix lives in the tree, where the
// arms are reviewable, rather than in a scratchpad that dies with the session.
//
// Arm decay — the failure mode the repo's gates cannot see: the typecheck and
// lint gates keep this file compiling, not meaningful, and nothing runs it
// automatically. An arm reports SKIPPED when its anchor no longer matches (the
// source moved under it) and it reports SURVIVED when its fixture stopped
// discriminating (the tests moved under it). Both are repair signals:
// re-anchor the arm or sharpen the fixture when the underlying code changes —
// do not retire the arm.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const FENCES = join(REPO_ROOT, "tools/docs-corpus/lib/markdown-fences.ts");
const DOCS_CORPUS_ROOT = join(REPO_ROOT, "tools/docs-corpus");
// Suites are named RELATIVE to `--root`, and `--root` is passed explicitly.
// A bare positional filter is a SUBSTRING match against every collected file,
// so from the repo root it also matches the same suite inside any checkout
// under `.worktrees/` and dilutes each arm's failure set with unmutated
// copies. Pinning the root scopes collection to this tree and to this tree's
// vitest config in one move.
const SUITES = ["__tests__/markdown-fences.test.ts", "__tests__/commonmark-oracle.test.ts"];
const REPORT_DIRECTORY = mkdtempSync(join(tmpdir(), "markdown-fences-mutation-"));
const REPORT = join(REPORT_DIRECTORY, "report.json");
process.on("exit", () => rmSync(REPORT_DIRECTORY, { recursive: true, force: true }));

interface Mutation {
  name: string;
  from: string;
  to: string;
}

const MUTATIONS: Mutation[] = [
  {
    name: "M1 ordered-marker start read as TEXT, not value",
    from: "return Number.parseInt(markerText, 10) === 1;",
    to: 'return markerText === "1." || markerText === "1)";',
  },
  {
    name: "M2 blank line satisfies a BLOCKQUOTE entry (asymmetry erased)",
    from: `      const afterMarker = matchBlockquoteMarker(rawLine, offset);
      if (afterMarker === null) break;`,
    to: `      const afterMarker = matchBlockquoteMarker(rawLine, offset);
      if (afterMarker === null) {
        if (isBlank(rawLine.slice(offset))) {
          matched++;
          continue;
        }
        break;
      }`,
  },
  {
    name: "M3 blank line KILLS a list-item entry (asymmetry inverted)",
    from: `    const rest = rawLine.slice(offset);
    if (isBlank(rest)) {
      // The item survives, and there is nothing to consume.
      matched++;
      continue;
    }`,
    to: `    const rest = rawLine.slice(offset);
    if (isBlank(rest)) break;`,
  },
  {
    name: "M4 paragraph reachability conjunct dropped",
    from: "const paragraphIsOpen = state.inParagraph && match.matched === state.containers.length;",
    to: "const paragraphIsOpen = state.inParagraph;",
  },
  {
    name: "M5 fence never dies to a container exit",
    from: "const openFenceAtLineStart = held !== null && match.matched < held.containerDepth ? null : held;",
    to: "const openFenceAtLineStart = held;",
  },
  {
    name: "M6 fence dies one container too eagerly (<= for <)",
    from: "match.matched < held.containerDepth",
    to: "match.matched <= held.containerDepth",
  },
  {
    name: "M7 opening a QUOTE does not clear the paragraph",
    from: `      offset = afterQuoteMarker;
      containers.push({ kind: "blockquote" });
      interruptsParagraph = false;`,
    to: `      offset = afterQuoteMarker;
      containers.push({ kind: "blockquote" });`,
  },
  {
    name: "M8 opening a LIST ITEM does not clear the paragraph",
    from: `    containers.push({ kind: "listItem", indent });
    offset += indent;
    interruptsParagraph = false;`,
    to: `    containers.push({ kind: "listItem", indent });
    offset += indent;`,
  },
  {
    name: "M9 quote markers never OPEN in the walk (interleaving lost)",
    from: `    const afterQuoteMarker = matchBlockquoteMarker(rawLine, offset);
    if (afterQuoteMarker !== null) {`,
    to: `    const afterQuoteMarker = null as number | null;
    if (afterQuoteMarker !== null) {`,
  },
  {
    name: "M10 quote marker's optional space left for the content",
    from: 'return rawLine[afterMarker] === " " ? afterMarker + 1 : afterMarker;',
    to: "return afterMarker;",
  },
  {
    name: "M11 list indent measured from the marker, not the line",
    from: "const markerWidth = markerIndent.length + markerText.length;",
    to: "const markerWidth = markerText.length;",
  },
  {
    name: "M12 five-plus-space content cap dropped",
    from: `      remainder === "" || spacesAfterMarker.length >= 5`,
    to: `      remainder === ""`,
  },
  {
    name: "M13 fence records depth 0 instead of its container depth",
    from: "containerDepth: opened.containers.length,",
    to: "containerDepth: 0,",
  },
  {
    name: "M14 container content reached by a BLIND slice (no spaces-only guard)",
    from: "if (!isSpacesOnly(rest.slice(0, entry.indent))) break;",
    to: "if (rest.length < entry.indent) break;",
  },
  {
    name: "M15 container stack NOT frozen while a fence is open",
    from: `    openFenceAtLineStart === null
      ? openContainers(rawLine, match.offset, matchedContainers, paragraphIsOpen)
      : { containers: matchedContainers, offset: match.offset };`,
    to: "    openContainers(rawLine, match.offset, matchedContainers, paragraphIsOpen);",
  },
  {
    name: "M16 paragraph state tracked INSIDE a fence",
    from: `    inParagraph: openFenceAtLineStart !== null ? false : isParagraphText(content, isDelimiterLine),`,
    to: `    inParagraph: isParagraphText(content, isDelimiterLine),`,
  },
  {
    name: "M17 empty item may interrupt a paragraph (spec Example 285)",
    from: `  if (remainder === "") return false;`,
    to: "",
  },
  {
    name: "M18 thematic break opens a list container",
    from: "    if (THEMATIC_BREAK_PATTERN.test(rest)) break;",
    to: "",
  },
  {
    name: "M19 marker needs no whitespace after it (`-foo` opens a list)",
    from: `    if (spacesAfterMarker.length === 0 && remainder !== "") break;`,
    to: "",
  },
  {
    name: "M20 container walk does not STOP at the first failure",
    from: `      const afterMarker = matchBlockquoteMarker(rawLine, offset);
      if (afterMarker === null) break;
      offset = afterMarker;
      matched++;
      continue;`,
    to: `      const afterMarker = matchBlockquoteMarker(rawLine, offset);
      if (afterMarker === null) continue;
      offset = afterMarker;
      matched++;
      continue;`,
  },
  // Round-1 arms, re-anchored onto the rewrite. See ARM PROVENANCE above.
  {
    name: "M21 (r1 P5) paragraph interruption rule NEVER applies",
    from: "const paragraphIsOpen = state.inParagraph && match.matched === state.containers.length;",
    to: "const paragraphIsOpen = false;",
  },
  {
    name: "M22 (r1 P4) paragraph interruption rule ALWAYS applies",
    from: "const paragraphIsOpen = state.inParagraph && match.matched === state.containers.length;",
    to: "const paragraphIsOpen = true;",
  },
  {
    name: "M23 (r1 P6) paragraph state never set (blank check swallows all)",
    from: "  if (isBlank(content)) return false;",
    to: "  return false;",
  },
  {
    name: "M24 (r1 P7) ATX headings counted as paragraph text",
    from: "  if (ATX_HEADING_PATTERN.test(content)) return false;",
    to: "",
  },
  {
    name: "M25 (r1 S1) a non-closing delimiter inside a fence clears it",
    from: "    state: settled(true, openFenceAtLineStart),",
    to: "    state: settled(true, null),",
  },
];

// Refuse a dirty docs-corpus tree (the harness's own directory excepted).
// The target, because restoration on a kill is `git checkout -- <target>`,
// which is only safe when the committed state IS the pre-run state. And
// everything the suites LOAD — the two suites themselves, the ambient
// declaration the oracle suite compiles against, the vitest config — because
// every arm's failure signature is a claim about the COMMITTED implementation:
// scoring against a hybrid of committed target and dirty dependency code
// describes neither state. The harness/ exclusion is deliberate: the harness
// orchestrates the runs but is never loaded by a suite, and excluding it keeps
// run-before-commit iteration on a new arm possible.
const dirtyFiles = execFileSync(
  "git",
  ["status", "--porcelain", "--", "tools/docs-corpus", ":(exclude)tools/docs-corpus/harness"],
  { cwd: REPO_ROOT, encoding: "utf8" },
).trim();
if (dirtyFiles !== "") {
  console.error("refusing to run: the docs-corpus tree has uncommitted changes:");
  console.error(dirtyFiles);
  console.error("commit or stash them first so a mid-run kill is recoverable by git checkout.");
  process.exit(2);
}

const ORIGINAL = readFileSync(FENCES, "utf8");

function restoreTarget(): void {
  writeFileSync(FENCES, ORIGINAL);
}
process.on("SIGINT", () => {
  restoreTarget();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restoreTarget();
  process.exit(143);
});

/**
 * One vitest run's outcome. Harvesting only failed assertions is not enough:
 * a run can fail at REPORTER level with zero failing assertions — a
 * transform/import/setup error writes a failed suite entry with an empty
 * `assertionResults`, and a path that matches no test writes `success: false`
 * with an empty `testResults` — and reading either as "no failures" turns a
 * red run green (Codex, PR #271 round 2). `failures` therefore carries failing
 * assertion titles AND suite-level error lines, and `reportedSuccess` is the
 * report's own top-level verdict — a run counts as green only when both agree.
 */
interface SuiteVerdict {
  reportedSuccess: boolean;
  failures: string[];
}

function runSuites(): SuiteVerdict {
  // Delete the previous report first: a run that crashes before reporting
  // would otherwise leave the PRIOR run's report in place, and re-reading it
  // silently scores this run with the previous run's failure set.
  rmSync(REPORT, { force: true });
  try {
    execFileSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--root",
        DOCS_CORPUS_ROOT,
        ...SUITES,
        "--reporter=json",
        `--outputFile=${REPORT}`,
      ],
      { cwd: REPO_ROOT, stdio: "pipe" },
    );
  } catch {
    /* a non-zero exit is the EXPECTED outcome for a mutation */
  }
  if (!existsSync(REPORT)) {
    return {
      reportedSuccess: false,
      failures: ["vitest wrote no JSON report — the run crashed before reporting"],
    };
  }
  const report = JSON.parse(readFileSync(REPORT, "utf8")) as {
    success?: boolean;
    testResults?: {
      status?: string;
      name?: string;
      message?: string;
      assertionResults?: { status: string; fullName?: string; title: string }[];
    }[];
  };
  const failures: string[] = [];
  for (const suiteResult of report.testResults ?? []) {
    let suiteHasFailedAssertion = false;
    for (const assertion of suiteResult.assertionResults ?? []) {
      if (assertion.status === "failed") {
        failures.push(assertion.fullName ?? assertion.title);
        suiteHasFailedAssertion = true;
      }
    }
    if (suiteResult.status === "failed" && !suiteHasFailedAssertion) {
      const messageHead = (suiteResult.message ?? "").split("\n")[0].slice(0, 200);
      failures.push(
        `suite-level failure in ${suiteResult.name ?? "<unnamed>"}: ` +
          (messageHead !== "" ? messageHead : "no failing assertion and no message"),
      );
    }
  }
  const reportedSuccess = report.success === true;
  if (!reportedSuccess && failures.length === 0) {
    // Fail closed on shape drift: the report says red but nothing above
    // captured why (the no-matching-test shape lands here).
    failures.push("report.success=false with no parsed failure detail");
  }
  return { reportedSuccess, failures };
}

try {
  console.log("=== BASELINE (unmutated) ===");
  const baseline = runSuites();
  if (!baseline.reportedSuccess || baseline.failures.length !== 0) {
    // A red baseline poisons every arm's failure set: a surviving mutation
    // inherits the pre-existing failures, reports a non-empty set, and scores
    // as killed — and the shared failures collapse distinct arms' signatures
    // in the dedup map. Nothing has been mutated yet, so exiting here needs no
    // restoration.
    console.error("refusing to score mutations against a red baseline:");
    for (const failure of baseline.failures) console.error(`  - ${failure}`);
    console.error("fix the suite first — a kill is only evidence against a green baseline.");
    process.exit(2);
  }
  console.log("  all pass\n");

  const signatures = new Map<string, string>();
  let survived = 0;
  let skipped = 0;
  let duplicateSignatures = 0;
  for (const mutation of MUTATIONS) {
    // Exactly one occurrence, not merely one or more: an anchor that matches
    // twice mutates only the first, so the arm silently measures half of what
    // its name claims.
    const occurrences = ORIGINAL.split(mutation.from).length - 1;
    if (occurrences !== 1) {
      console.log(`${mutation.name}\n  SKIPPED — anchor matched ${occurrences}x, expected 1\n`);
      skipped++;
      continue;
    }
    writeFileSync(FENCES, ORIGINAL.replace(mutation.from, mutation.to));
    const verdict = runSuites();
    restoreTarget();

    // An arm survives only when the report itself says green AND nothing
    // failed. A reporter-level crash (import error, no report) is a KILL — the
    // mutation stopped the suite from passing — and its failure line joins the
    // signature so the dedup map still discriminates crash arms.
    const signature = [...verdict.failures].sort().join(" || ");
    const duplicate = signatures.get(signature);
    if (!duplicate) signatures.set(signature, mutation.name);
    console.log(mutation.name);
    console.log(`  ${verdict.failures.length} failure(s)`);
    for (const failure of verdict.failures) console.log(`    - ${failure}`);
    if (verdict.reportedSuccess && verdict.failures.length === 0) {
      console.log("    !! MUTATION SURVIVED — behavior is untested");
      survived++;
    }
    if (duplicate) {
      console.log(`    !! SAME failure set as ${duplicate}`);
      duplicateSignatures++;
    }
    console.log("");
  }
  console.log(
    `=== ${MUTATIONS.length} arms: ${MUTATIONS.length - survived - skipped} killed, ` +
      `${survived} survived, ${skipped} skipped, ${duplicateSignatures} duplicate signature(s) ===`,
  );
  // Decay is a FAILURE, not a footnote: a green exit beside a SURVIVED,
  // SKIPPED, or duplicate-signature arm reads as "the matrix holds" while its
  // discriminating invariant is broken (Codex, PR #271 round 3).
  if (survived !== 0 || skipped !== 0 || duplicateSignatures !== 0) {
    console.error(
      "matrix decayed — repair the arms, do not retire them: " +
        `${survived} survived (fixture no longer discriminates), ` +
        `${skipped} skipped (anchor moved), ` +
        `${duplicateSignatures} duplicate signature(s) (arms fail identically).`,
    );
    process.exitCode = 1;
  }
} finally {
  restoreTarget();
  console.log("restored tools/docs-corpus/lib/markdown-fences.ts");
}
