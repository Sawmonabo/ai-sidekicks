// Discriminating mutation matrix over the table-arity check: each arm must
// fail a DIFFERENT subset of the suite. An arm that fails nothing means the
// behavior is untested; two arms failing identical sets means one of those
// tests is redundant. Arms M1-M35 accumulated across PR #269 review rounds
// 1-4; each anchors on a content string in the shipped source.
//
// Usage (author-invoked; NEVER wire this into CI or any hook — it MUTATES the
// working tree while it runs):
//
//   node --experimental-strip-types tools/docs-corpus/harness/mutate-table-arity.ts
//
// Restoration: every arm restores its target immediately after its suite run,
// a `finally` restores all three targets on any error, and SIGINT/SIGTERM are
// trapped to restore before exiting. A SIGKILL between mutate and restore
// still leaves residue — the harness therefore REFUSES to start unless the
// docs-corpus tree (harness/ excepted — never loaded by a suite) is committed
// clean, so recovery is always `git checkout -- <targets>` with nothing of
// yours in the blast radius, and no arm is ever scored against a hybrid of
// committed targets and dirty dependency code.
//
// Arm decay — the failure mode the repo's gates cannot see: the typecheck and
// lint gates keep this file compiling, not meaningful, and nothing runs it
// automatically. An arm reports SKIPPED when its anchor no longer matches
// (the source moved under it) and it reports SURVIVED when its fixture
// stopped discriminating (the tests moved under it). Both are repair signals:
// re-anchor the arm or sharpen the fixture when the underlying code changes —
// do not retire the arm.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const ARITY = join(REPO_ROOT, "tools/docs-corpus/lib/table-arity.ts");
const TABLES = join(REPO_ROOT, "tools/docs-corpus/lib/markdown-tables.ts");
const RUNNER = join(REPO_ROOT, "tools/docs-corpus/bin/pre-commit-runner.ts");
// Absolute suite paths: a repo-relative positional filter is a SUBSTRING
// match, so it would also collect the same suite inside any checkout under
// `.worktrees/` and dilute each arm's failure set with unmutated copies.
const ARITY_SUITE = join(REPO_ROOT, "tools/docs-corpus/__tests__/table-arity.test.ts");
const RUNNER_SUITE = join(REPO_ROOT, "tools/docs-corpus/__tests__/pre-commit-runner.test.ts");
const REPORT_DIRECTORY = mkdtempSync(join(tmpdir(), "table-arity-mutation-"));
const REPORT = join(REPORT_DIRECTORY, "report.json");
// The 'exit' event fires on EVERY termination path — normal completion, the
// fail-closed process.exit(2) refusals (which skip `finally`), and the signal
// handlers' process.exit — so the temp directory never outlives the run.
process.on("exit", () => rmSync(REPORT_DIRECTORY, { recursive: true, force: true }));

interface Mutation {
  name: string;
  file: string;
  from: string;
  to: string;
  /** Suite override for arms whose failure is invisible to the arity suite. */
  suite?: string;
}

const MUTATIONS: Mutation[] = [
  {
    name: "M1 fence suppression disabled",
    file: ARITY,
    from: "const fenceSuppressed = scanState.openFence !== null || isDelimiterLine;",
    to: "const fenceSuppressed = false;",
  },
  {
    name: "M2 splitRow drops escape handling entirely",
    file: TABLES,
    from: `    if (character === "\\\\") {
      let runLength = 0;
      while (index < trimmed.length && trimmed[index] === "\\\\") {
        runLength++;
        index++;
      }
      current += "\\\\".repeat(runLength >> 1);
      if (runLength % 2 === 1) {
        if (index < trimmed.length && trimmed[index] === "|") {
          current += "|";
          index++;
        } else {
          current += "\\\\";
        }
      }
      continue;
    }`,
    to: "",
  },
  {
    name: "M3 delimiter-arity check dropped",
    file: ARITY,
    from: "if (delimiterCells !== expected) {",
    to: "if (false) {",
  },
  {
    name: "M4 blockquote prefix not stripped",
    file: ARITY,
    from: "const unquoted = stripBlockquotePrefix(lines[i]);",
    to: "const unquoted = lines[i];",
  },
  {
    name: "M5 only wider rows flagged",
    file: ARITY,
    from: "        if (actual !== openTable.expected) {",
    to: "        if (actual > openTable.expected) {",
  },
  {
    name: "M6 delimiter row not required to start a table",
    file: ARITY,
    from: `    if (!isTableRow(delimiter) || !isDelimiterRow(delimiter)) continue;
    if (!hasLegalTableIndent(delimiter)) continue;
    if (blockquoteDepth(lines[i + 1]) !== depth) continue;
    if (!hasOnlyValidDelimiterCells(delimiter)) continue;`,
    to: `    if (!isTableRow(delimiter)) continue;
    if (!hasLegalTableIndent(delimiter)) continue;
    if (blockquoteDepth(lines[i + 1]) !== depth) continue;`,
  },
  // --- R1 fix arms ---
  {
    name: "M7 splitRow reverts to naive previous-char escape test (R1)",
    file: TABLES,
    from: `    if (character === "\\\\") {
      let runLength = 0;
      while (index < trimmed.length && trimmed[index] === "\\\\") {
        runLength++;
        index++;
      }
      current += "\\\\".repeat(runLength >> 1);
      if (runLength % 2 === 1) {
        if (index < trimmed.length && trimmed[index] === "|") {
          current += "|";
          index++;
        } else {
          current += "\\\\";
        }
      }
      continue;
    }`,
    to: `    if (character === "\\\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 2;
      continue;
    }`,
  },
  {
    name: "M8 body continuation reverts to leading-pipe only (R1)",
    file: ARITY,
    from: `      if (
        depth === openTable.depth &&
        unquoted.trim() !== "" &&
        containsUnescapedPipe(unquoted) &&
        !startsBlockLevelStructure(unquoted)
      ) {`,
    to: "      if (isTableRow(unquoted)) {",
  },
  {
    name: "M9 indentation bound disabled (R1)",
    file: TABLES,
    from: 'return !leadingWhitespace.includes("\\t") && leadingWhitespace.length <= 3;',
    to: "return true;",
  },
  {
    name: "M10 raw-HTML block state never entered (R1, generalized R4)",
    file: ARITY,
    from: `    const closerOfOpenedBlock = blockLevelTerminatingHtmlBlockCloser(unquoted);
    if (closerOfOpenedBlock !== null) {
      openHtmlBlockCloser = closerOfOpenedBlock;
      openTable = null;
      atBlockBoundary = true;
      continue;
    }`,
    to: "",
  },
  {
    name: "M11 open scan uses indexOf not lastIndexOf (R1)",
    file: ARITY,
    from: "const openIndex = line.lastIndexOf(form.opener);",
    to: "const openIndex = line.indexOf(form.opener);",
  },
  // --- R2 fix arms: each must die to at least one test, with a distinct set ---
  {
    name: "M12 opener widened back to a substring scan (R2 F1)",
    file: ARITY,
    // The faithful pre-narrowing body, -1 guard restored: a mutation that also
    // drops that guard makes the predicate true for EVERY line, which kills
    // broadly for the wrong reason and discriminates nothing.
    from: `    if (!form.opens(trimmedLine)) continue;
    const openIndex = line.lastIndexOf(form.opener);
    return line.indexOf(form.closer, openIndex + form.opener.length) === -1 ? form.closer : null;`,
    to: `    const openIndex = line.lastIndexOf(form.opener);
    if (openIndex === -1) continue;
    return line.indexOf(form.closer, openIndex + form.opener.length) === -1 ? form.closer : null;`,
  },
  {
    name: "M13 opener LINE no longer suppressed (R2 F1, advisor)",
    file: ARITY,
    from: `    const closerOfOpenedBlock = blockLevelTerminatingHtmlBlockCloser(unquoted);
    if (closerOfOpenedBlock !== null) {
      openHtmlBlockCloser = closerOfOpenedBlock;
      openTable = null;
      atBlockBoundary = true;
      continue;
    }`,
    to: `    const closerOfOpenedBlock = blockLevelTerminatingHtmlBlockCloser(unquoted);
    if (closerOfOpenedBlock !== null) {
      openHtmlBlockCloser = closerOfOpenedBlock;
    }`,
  },
  {
    name: "M14 front-matter tracker deleted (R2 F4)",
    file: ARITY,
    from: "for (let i = frontMatterEndIndex(lines) + 1; i < lines.length; i++) {",
    to: "for (let i = 0; i < lines.length; i++) {",
  },
  {
    name: "M15 front matter allowed to open anywhere, not only line 1 (R2 F4)",
    file: ARITY,
    // Whole-body swap. An earlier version computed `start` and then left the
    // terminator scan beginning at line 1 — it never actually moved the opener,
    // so it survived for want of being the mutation it claimed to be.
    from: `  if (lines.length === 0 || lines[0].trimEnd() !== "---") return -1;
  let contestedCloserIndex = -1;
  for (let index = 1; index < lines.length; index++) {
    const trimmed = lines[index].trimEnd();
    if (trimmed === "---" || trimmed === "...") return index;
    if (contestedCloserIndex === -1 && CONTESTED_FRONT_MATTER_CLOSER_PATTERN.test(trimmed)) {
      contestedCloserIndex = index;
    }
  }
  return contestedCloserIndex;`,
    to: `  let start = 0;
  while (start < lines.length && lines[start].trimEnd() !== "---") start++;
  if (start >= lines.length) return -1;
  let contestedCloserIndex = -1;
  for (let index = start + 1; index < lines.length; index++) {
    const trimmed = lines[index].trimEnd();
    if (trimmed === "---" || trimmed === "...") return index;
    if (contestedCloserIndex === -1 && CONTESTED_FRONT_MATTER_CLOSER_PATTERN.test(trimmed)) {
      contestedCloserIndex = index;
    }
  }
  return contestedCloserIndex;`,
  },
  {
    name: "M16 depth equality dropped when OPENING a table (R2 F5)",
    file: ARITY,
    from: "if (blockquoteDepth(lines[i + 1]) !== depth) continue;",
    to: "",
  },
  {
    name: "M17 depth equality dropped for BODY rows (R2 F5)",
    file: ARITY,
    from: `        depth === openTable.depth &&
        unquoted.trim() !== "" &&`,
    to: '        unquoted.trim() !== "" &&',
  },
  {
    name: "M18 injected reader ignored, disk hardwired (R2 F2)",
    file: ARITY,
    from: 'const lines = readContent(filePath).split("\\n");',
    to: 'const lines = readFileSync(filePath, "utf8").split("\\n");',
  },
  {
    // The one arm at the runner BOUNDARY rather than inside the check: the
    // reader must actually reach parseFile. Its own suite, because the failure
    // it discriminates is wiring, invisible to table-arity.test.ts.
    name: "M19 runner drops the snapshot reader, arity re-reads the worktree (R2 F2)",
    file: RUNNER,
    suite: RUNNER_SUITE,
    from: "checkTableArity(stagedMd, reader)",
    to: "checkTableArity(stagedMd)",
  },
  // ── Round 3 ────────────────────────────────────────────────────────────────
  {
    name: "M20 block-boundary rule deleted — a table opens anywhere (R3 F2/F4)",
    file: ARITY,
    from: "    if (!mayOpenTable) continue;",
    to: "",
  },
  {
    name: "M21 heading no longer ends a table body (R3 F1)",
    file: ARITY,
    from: "    ATX_HEADING_PATTERN.test(line) ||\n",
    to: "",
  },
  {
    name: "M22 list marker no longer ends a table body (R3 F1)",
    file: ARITY,
    from: "    LIST_MARKER_PATTERN.test(line) ||\n",
    to: "",
  },
  {
    name: "M23 HTML tag no longer ends a table body (R3 F1)",
    file: ARITY,
    from: "    LIST_MARKER_PATTERN.test(line) ||\n    HTML_TAG_LINE_PATTERN.test(line)",
    to: "    LIST_MARKER_PATTERN.test(line)",
  },
  {
    name: "M24 per-cell delimiter validation deleted (R3 F3)",
    file: ARITY,
    from: "    if (!hasOnlyValidDelimiterCells(delimiter)) continue;",
    to: "",
  },
  {
    // The open site is the ONLY place this write is observable: within a table
    // the flag is already true, so the body-branch write cannot be killed in
    // isolation. Deleting it here means nothing can ever open directly after a
    // table — a recall loss with no test unless one abuts two tables.
    name: "M26 recognized pair leaves no boundary behind it (R3, advisor)",
    file: ARITY,
    from: `    openTable = { headerLine, expected, depth };
    // Header and delimiter are both table machinery, so the pair leaves the
    // first body candidate at a boundary.
    atBlockBoundary = true;`,
    to: "    openTable = { headerLine, expected, depth };",
  },
  {
    name: "M25 trailer emits the widening ban for NARROWER rows too (R3 F5)",
    file: ARITY,
    from: "  if (violations.some((violation) => violation.actual > violation.expected)) {",
    to: "  if (violations.some((violation) => violation.actual < violation.expected)) {",
  },
  // ── Round 4 ────────────────────────────────────────────────────────────────
  {
    name: "M27 lone-pipe header guard deleted (R4 F3)",
    file: ARITY,
    from: '    if (unquoted.trim() === "|") continue;',
    to: "",
  },
  {
    name: "M28 CDATA form dropped from the tracker (R4 F2)",
    file: ARITY,
    from: `  {
    opens: (trimmedLine) => trimmedLine.startsWith("<![CDATA["),
    opener: "<![CDATA[",
    closer: "]]>",
  },`,
    to: "",
  },
  {
    name: "M29 declaration form dropped from the tracker (R4 F2)",
    file: ARITY,
    from: '  { opens: (trimmedLine) => /^<![A-Za-z]/.test(trimmedLine), opener: "<!", closer: ">" },',
    to: "",
  },
  {
    name: "M30 processing-instruction form dropped from the tracker (R4 F2)",
    file: ARITY,
    from: '  { opens: (trimmedLine) => trimmedLine.startsWith("<?"), opener: "<?", closer: "?>" },',
    to: "",
  },
  {
    name: "M31 in-state close scan hardwired back to --> (R4 F2)",
    file: ARITY,
    from: "      if (unquoted.includes(openHtmlBlockCloser)) openHtmlBlockCloser = null;",
    to: '      if (unquoted.includes("-->")) openHtmlBlockCloser = null;',
  },
  {
    name: "M32 runner lane membership reverts to stat-only (R4 F1)",
    file: RUNNER,
    suite: RUNNER_SUITE,
    from: "    (gitIndexPaths !== null && gitIndexPaths.has(resolve(p))) || statIsFile(p);",
    to: "    statIsFile(p);",
  },
  {
    name: "M33 contested front-matter closer fallback deleted (R4 F4)",
    file: ARITY,
    from: "  return contestedCloserIndex;",
    to: "  return -1;",
  },
  {
    name: "M34 contested closer pattern accepts a glued comment (R4 F4)",
    file: ARITY,
    from: "const CONTESTED_FRONT_MATTER_CLOSER_PATTERN = /^(?:---|\\.\\.\\.)[ \\t]+#/;",
    to: "const CONTESTED_FRONT_MATTER_CLOSER_PATTERN = /^(?:---|\\.\\.\\.)[ \\t]*#/;",
  },
  {
    name: "M35 contested closer outranks a later bare fence (R4 F4)",
    file: ARITY,
    from: `    if (trimmed === "---" || trimmed === "...") return index;
    if (contestedCloserIndex === -1 && CONTESTED_FRONT_MATTER_CLOSER_PATTERN.test(trimmed)) {
      contestedCloserIndex = index;
    }`,
    to: `    if (trimmed === "---" || trimmed === "...") return index;
    if (CONTESTED_FRONT_MATTER_CLOSER_PATTERN.test(trimmed)) return index;`,
  },
];

const TARGET_FILES = [ARITY, TABLES, RUNNER];

// Refuse a dirty docs-corpus tree (the harness's own directory excepted).
// Targets, because restoration on a kill is `git checkout -- <targets>`,
// which is only safe when the committed state IS the pre-run state. And
// everything the suites LOAD — the tests themselves, libs the targets import
// (markdown-fences.ts is neither a target nor a suite, yet table-arity.ts
// rides it), the runner, the vitest config — because every arm's failure
// signature is a claim about the COMMITTED implementation: scoring against a
// hybrid of committed targets and dirty dependency code describes neither
// state. The harness/ exclusion is deliberate: the harness orchestrates the
// runs but is never loaded by a suite, and excluding it keeps
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

const originalContents = new Map<string, string>();
for (const path of TARGET_FILES) originalContents.set(path, readFileSync(path, "utf8"));

function restoreAllTargets(): void {
  for (const [path, content] of originalContents) writeFileSync(path, content);
}
process.on("SIGINT", () => {
  restoreAllTargets();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restoreAllTargets();
  process.exit(143);
});

/**
 * One vitest run's outcome. Harvesting only failed assertions is not enough:
 * a run can fail at REPORTER level with zero failing assertions — a
 * transform/import/setup error writes a failed suite entry with an empty
 * `assertionResults`, and a path that matches no test writes `success: false`
 * with an empty `testResults` — and reading either as "no failures" turns a
 * red run green (Codex, PR #271 round 2; both shapes probed against vitest's
 * actual JSON output). `failures` therefore carries failing assertion titles
 * AND suite-level error lines, and `reportedSuccess` is the report's own
 * top-level verdict — a run counts as green only when both agree.
 */
interface SuiteVerdict {
  reportedSuccess: boolean;
  failures: string[];
}

function runSuite(suite: string = ARITY_SUITE): SuiteVerdict {
  // Delete the previous report first: a run that crashes before reporting
  // would otherwise leave the PRIOR run's report in place, and re-reading it
  // silently scores this run with the previous run's failure set.
  rmSync(REPORT, { force: true });
  try {
    execFileSync(
      "pnpm",
      ["exec", "vitest", "run", suite, "--reporter=json", `--outputFile=${REPORT}`],
      { cwd: REPO_ROOT, stdio: "pipe" },
    );
  } catch {
    /* a non-zero exit is the EXPECTED outcome for a mutation */
  }
  if (!existsSync(REPORT)) {
    return {
      reportedSuccess: false,
      failures: [`vitest wrote no JSON report for ${suite} — the run crashed before reporting`],
    };
  }
  const report = JSON.parse(readFileSync(REPORT, "utf8")) as {
    success?: boolean;
    testResults?: {
      status?: string;
      name?: string;
      message?: string;
      assertionResults?: { status: string; title: string }[];
    }[];
  };
  const failures: string[] = [];
  for (const suiteResult of report.testResults ?? []) {
    let suiteHasFailedAssertion = false;
    for (const assertion of suiteResult.assertionResults ?? []) {
      if (assertion.status === "failed") {
        failures.push(assertion.title);
        suiteHasFailedAssertion = true;
      }
    }
    if (suiteResult.status === "failed" && !suiteHasFailedAssertion) {
      const messageHead = (suiteResult.message ?? "").split("\n")[0].slice(0, 200);
      failures.push(
        `suite-level failure in ${suiteResult.name ?? suite}: ` +
          (messageHead !== "" ? messageHead : "no failing assertion and no message"),
      );
    }
  }
  const reportedSuccess = report.success === true;
  if (!reportedSuccess && failures.length === 0) {
    // Fail closed on shape drift: the report says red but nothing above
    // captured why (the no-matching-test shape lands here).
    failures.push(`report.success=false for ${suite} with no parsed failure detail`);
  }
  return { reportedSuccess, failures };
}

try {
  console.log("=== BASELINE (unmutated) ===");
  const baselineVerdicts = [runSuite(ARITY_SUITE), runSuite(RUNNER_SUITE)];
  if (
    baselineVerdicts.some((verdict) => !verdict.reportedSuccess || verdict.failures.length !== 0)
  ) {
    // A red baseline poisons every arm's failure set: a surviving mutation
    // inherits the pre-existing failures, reports a non-empty set, and scores
    // as killed — and the shared failures collapse distinct arms' signatures
    // in the dedup map. Nothing has been mutated yet, so exiting here needs
    // no restoration.
    console.error("refusing to score mutations against a red baseline:");
    for (const verdict of baselineVerdicts) {
      for (const failure of verdict.failures) console.error(`  - ${failure}`);
    }
    console.error("fix the suite first — a kill is only evidence against a green baseline.");
    process.exit(2);
  }
  console.log("  all pass\n");

  const signatures = new Map<string, string>();
  let survived = 0;
  let skipped = 0;
  let duplicateSignatures = 0;
  for (const mutation of MUTATIONS) {
    const original = originalContents.get(mutation.file)!;
    if (!original.includes(mutation.from)) {
      console.log(`${mutation.name}\n  SKIPPED — anchor not found\n`);
      skipped++;
      continue;
    }
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
    const verdict = runSuite(mutation.suite ?? ARITY_SUITE);
    writeFileSync(mutation.file, original);

    // An arm survives only when the report itself says green AND nothing
    // failed. A reporter-level crash (import error, no report) is a KILL —
    // the mutation stopped the suite from passing — and its failure line
    // joins the signature so the dedup map still discriminates crash arms.
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
  restoreAllTargets();
  console.log("restored all three source files");
}
