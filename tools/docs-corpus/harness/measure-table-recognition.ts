// Recognition-invariance measurement for the docs-corpus GFM table scan, by
// the widen-delimiter denominator method (PR #269 round 3). A 0-before/0-after
// survey of a clean corpus cannot tell "no recognition regression" from "the
// new rules blinded the check" — both read as zero violations. Widening every
// delimiter row by one cell makes every RECOGNIZED table yield exactly one
// header/delimiter arity violation, so the violation count over the widened
// corpus IS the recognition denominator, and a baseline-vs-edited diff of the
// per-site keys shows exactly which tables a rule change gained or lost.
//
// Usage (author-invoked; nothing runs this automatically):
//
//   node --experimental-strip-types \
//     tools/docs-corpus/harness/measure-table-recognition.ts --baseline=<rev>
//
// The baseline `lib/` is materialized from git at <rev> into a temp directory
// and dynamically imported; the edited side is the working tree via a normal
// static import. Same tree + `--baseline=HEAD` must report a zero delta with
// an equal denominator — that is the instrument's own sanity check.
//
// Run this for any PR that changes recognition rules in `lib/table-arity.ts`
// or the shared modules it consumes (`markdown-tables.ts`,
// `markdown-fences.ts`). The container-aware fence-tracking follow-up
// committed in PR #270 round 1 gates on re-measuring this denominator: the
// disclosed bounds are measured populations under today's recognition rules,
// not invariants, so widening recognition re-opens every one of them.
//
// Honest limits: the tree's typecheck/lint gates keep this file compiling,
// not correct — a green gate is no evidence the measurement still measures.
// A LOST/GAINED delta is a finding to adjudicate, not automatically a
// failure: a recognition-widening change EXPECTS gains. And the widener
// itself rides the WORKING-TREE row predicates — if an edit changes what
// counts as a delimiter row, read the LOST list with that in mind.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PER_FILE_CHECK_EXCLUDED_PREFIXES } from "../bin/pre-commit-runner.ts";
import { checkTableArity } from "../lib/table-arity.ts";
import { stripBlockquotePrefix } from "../lib/markdown-fences.ts";
import { isDelimiterRow, isTableRow } from "../lib/markdown-tables.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BASELINE_LIB_GIT_PREFIX = "tools/docs-corpus/lib";

// The baseline module is loaded from a computed specifier, so the compiler
// cannot type it; this is the slice of its surface the measurement consumes.
interface RecognitionHit {
  file: string;
  line: number;
}
type TableArityCheck = (files: string[]) => RecognitionHit[];

function repoGit(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

const baselineArgument = process.argv.find((argument) => argument.startsWith("--baseline="));
if (baselineArgument === undefined) {
  console.error(
    "usage: node --experimental-strip-types tools/docs-corpus/harness/measure-table-recognition.ts --baseline=<rev>",
  );
  console.error(
    "  <rev> is the git revision whose tools/docs-corpus/lib provides the BASELINE scan.",
  );
  process.exit(2);
}
const baselineRevision = repoGit([
  "rev-parse",
  "--verify",
  `${baselineArgument.slice("--baseline=".length)}^{commit}`,
]).trim();

// The enforced population: every tracked `.md` minus the runner's exported
// exclusion prefixes — the same per-file population the pre-commit runner
// gates, enumerated from the index rather than a directory walk so untracked
// scratch files can never inflate the denominator.
const enforcedFiles = repoGit(["ls-files", "-z", "--", "*.md"])
  .split("\0")
  .filter((path) => path !== "")
  .filter((path) => !PER_FILE_CHECK_EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)))
  .sort()
  .map((path) => join(REPO_ROOT, path));

console.log(`baseline: ${baselineRevision}`);
console.log(`enforced files: ${enforcedFiles.length}`);

function widenDelimiterRows(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const unquoted = stripBlockquotePrefix(line);
      if (!isTableRow(unquoted) || !isDelimiterRow(unquoted)) return line;
      const trimmedEnd = line.trimEnd();
      return trimmedEnd.endsWith("|") ? `${trimmedEnd} --- |` : `${trimmedEnd} | ---`;
    })
    .join("\n");
}

const stage = mkdtempSync(join(tmpdir(), "table-recognition-"));
try {
  // Materialize the baseline lib flat into the stage; sibling relative imports
  // between the lib modules resolve against this directory.
  const baselineLibDirectory = join(stage, "baseline-lib");
  mkdirSync(baselineLibDirectory, { recursive: true });
  const baselineLibFiles = repoGit([
    "ls-tree",
    "-r",
    "--name-only",
    baselineRevision,
    "--",
    BASELINE_LIB_GIT_PREFIX,
  ])
    .split("\n")
    .filter((path) => path !== "");
  for (const gitPath of baselineLibFiles) {
    const fileName = gitPath.slice(BASELINE_LIB_GIT_PREFIX.length + 1);
    writeFileSync(
      join(baselineLibDirectory, fileName),
      repoGit(["show", `${baselineRevision}:${gitPath}`]),
    );
  }
  const baselineModule = (await import(
    pathToFileURL(join(baselineLibDirectory, "table-arity.ts")).href
  )) as { checkTableArity: TableArityCheck };
  const checkBaseline = baselineModule.checkTableArity;

  const widenedPaths: string[] = [];
  const pristinePaths: string[] = [];
  for (const file of enforcedFiles) {
    const relativePath = relative(REPO_ROOT, file);
    const content = readFileSync(file, "utf8");
    const widenedPath = join(stage, "widened", relativePath);
    mkdirSync(dirname(widenedPath), { recursive: true });
    writeFileSync(widenedPath, widenDelimiterRows(content));
    widenedPaths.push(widenedPath);
    const pristinePath = join(stage, "pristine", relativePath);
    mkdirSync(dirname(pristinePath), { recursive: true });
    writeFileSync(pristinePath, content);
    pristinePaths.push(pristinePath);
  }

  const baselineHits = checkBaseline(widenedPaths);
  const editedHits = checkTableArity(widenedPaths);
  console.log(`\n── recognition denominator (widened delimiters) ──`);
  console.log(`  baseline (${baselineRevision.slice(0, 7)}): ${baselineHits.length}`);
  console.log(`  edited (working tree):  ${editedHits.length}`);
  console.log(`  delta:                  ${editedHits.length - baselineHits.length}`);

  const hitKey = (hit: RecognitionHit) => `${relative(stage, hit.file)}:${hit.line}`;
  const baselineKeys = new Set(baselineHits.map(hitKey));
  const editedKeys = new Set(editedHits.map(hitKey));
  const lost = [...baselineKeys].filter((key) => !editedKeys.has(key));
  const gained = [...editedKeys].filter((key) => !baselineKeys.has(key));
  console.log(`  LOST:   ${lost.length}`);
  for (const key of lost) console.log(`    ${key}`);
  console.log(`  GAINED: ${gained.length}`);
  for (const key of gained) console.log(`    ${key}`);

  // Per-file identity, not just totals: two files could trade a table and
  // leave the count unchanged.
  const perFileCounts = (hits: RecognitionHit[]) => {
    const counts = new Map<string, number>();
    for (const hit of hits) {
      const relativePath = relative(stage, hit.file);
      counts.set(relativePath, (counts.get(relativePath) ?? 0) + 1);
    }
    return counts;
  };
  const baselinePerFile = perFileCounts(baselineHits);
  const editedPerFile = perFileCounts(editedHits);
  const movedFiles = [...new Set([...baselinePerFile.keys(), ...editedPerFile.keys()])].filter(
    (file) => (baselinePerFile.get(file) ?? 0) !== (editedPerFile.get(file) ?? 0),
  );
  console.log(`  files whose recognized-table count moved: ${movedFiles.length}`);
  for (const file of movedFiles) {
    console.log(
      `    ${file}: ${baselinePerFile.get(file) ?? 0} -> ${editedPerFile.get(file) ?? 0}`,
    );
  }

  // NEGATIVE CONTROL for the method: the widening must be what produces the
  // count. Unperturbed copies must report zero on both sides — a non-zero here
  // means live corpus violations are polluting the denominator and the
  // numbers above are not a recognition measurement.
  const baselineControl = checkBaseline(pristinePaths).length;
  const editedControl = checkTableArity(pristinePaths).length;
  console.log(
    `  CONTROL unperturbed: baseline ${baselineControl}, edited ${editedControl} (both must be 0)`,
  );
  if (baselineControl !== 0 || editedControl !== 0) {
    console.error("CONTROL VIOLATION — the denominator above is not a recognition measurement.");
    process.exitCode = 1;
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
