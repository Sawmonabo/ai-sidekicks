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
// static import. EACH side widens its own copy of the corpus with ITS OWN row
// predicates (`stripBlockquotePrefix` / `isTableRow` / `isDelimiterRow`) — a
// shared widener would leave any delimiter shape the edited predicates stop
// accepting unwidened on BOTH sides, hiding exactly the recognition loss the
// instrument exists to surface (Codex, PR #271). The baseline rev must
// therefore export those three predicates and emit `headerLine`-bearing
// violations; a rev that predates them fails closed with a named message.
// Same tree + `--baseline=HEAD` must report a zero delta with an equal
// denominator — that is the instrument's own sanity check.
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
// failure: a recognition-widening change EXPECTS gains. And the denominator
// counts VIOLATIONS, which equals the table count only while every recognized
// table yields exactly one forced hit: a body row that is itself
// delimiter-shaped would be widened too and add a second hit under the same
// header (Codex, PR #271 — measured population today: zero across the 230
// enforced files). The per-side multi-hit tripwire below turns that silent
// overcount into a hard failure the day the population stops being empty.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PER_FILE_CHECK_EXCLUDED_PREFIXES } from "../bin/pre-commit-runner.ts";
import { checkTableArity } from "../lib/table-arity.ts";
import { stripBlockquotePrefix } from "../lib/markdown-fences.ts";
import { isDelimiterRow, isTableRow } from "../lib/markdown-tables.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BASELINE_LIB_GIT_PREFIX = "tools/docs-corpus/lib";

// The baseline modules are loaded from computed specifiers, so the compiler
// cannot type them; these are the slices of their surface the measurement
// consumes. `headerLine` is optional because it crosses the same untyped
// boundary — the multi-hit tripwire guards its presence at runtime.
interface RecognitionHit {
  file: string;
  line: number;
  headerLine?: number;
}
type TableArityCheck = (files: string[]) => RecognitionHit[];

/** The row predicates the widener rides — one bundle per side. */
interface WidenerPredicates {
  stripBlockquotePrefix(line: string): string;
  isTableRow(line: string): boolean;
  isDelimiterRow(line: string): boolean;
}
const workingTreePredicates: WidenerPredicates = {
  stripBlockquotePrefix,
  isTableRow,
  isDelimiterRow,
};

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
// scratch files can never inflate the denominator. Repo-relative: content is
// read from the index too (`git show :<path>` in the staging loop below), so
// the measurement is over the SNAPSHOT the runner enforces — enumerating from
// the index while reading worktree bytes measured a hybrid corpus, where an
// unstaged local edit could silently move the denominator or hide a
// recognition loss from LOST (Codex, PR #271 round 4).
const enforcedFiles = repoGit(["ls-files", "-z", "--", "*.md"])
  .split("\0")
  .filter((path) => path !== "")
  .filter((path) => !PER_FILE_CHECK_EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)))
  .sort();

console.log(`baseline: ${baselineRevision}`);
console.log(`enforced files: ${enforcedFiles.length}`);

function widenDelimiterRows(content: string, predicates: WidenerPredicates): string {
  return content
    .split("\n")
    .map((line) => {
      const unquoted = predicates.stripBlockquotePrefix(line);
      if (!predicates.isTableRow(unquoted) || !predicates.isDelimiterRow(unquoted)) return line;
      const trimmedEnd = line.trimEnd();
      return trimmedEnd.endsWith("|") ? `${trimmedEnd} --- |` : `${trimmedEnd} | ---`;
    })
    .join("\n");
}

const stage = mkdtempSync(join(tmpdir(), "table-recognition-"));
// The `finally` below covers the normal path, but the fail-closed
// process.exit(2) guards inside the try skip it — the 'exit' event fires on
// every termination path, so the stage never outlives the run either way.
process.on("exit", () => rmSync(stage, { recursive: true, force: true }));
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

  // The BASELINE side widens with the BASELINE predicates. A single widener
  // riding the working-tree predicates leaves any delimiter shape an edited
  // predicate stops accepting unwidened on both sides — the baseline scan
  // then emits no forced violation for it and the recognition loss never
  // reaches the LOST list (Codex, PR #271).
  const baselineFencesModule = (await import(
    pathToFileURL(join(baselineLibDirectory, "markdown-fences.ts")).href
  )) as Partial<WidenerPredicates>;
  const baselineTablesModule = (await import(
    pathToFileURL(join(baselineLibDirectory, "markdown-tables.ts")).href
  )) as Partial<WidenerPredicates>;
  const baselinePredicateEntries = {
    stripBlockquotePrefix: baselineFencesModule.stripBlockquotePrefix,
    isTableRow: baselineTablesModule.isTableRow,
    isDelimiterRow: baselineTablesModule.isDelimiterRow,
  };
  for (const [exportName, predicate] of Object.entries(baselinePredicateEntries)) {
    if (typeof predicate !== "function") {
      console.error(
        `baseline ${baselineRevision.slice(0, 7)} does not export ${exportName} from its lib — ` +
          `the per-side widener needs it; pick a baseline at or after the table-arity landing (PR #269).`,
      );
      process.exit(2);
    }
  }
  const baselinePredicates = baselinePredicateEntries as WidenerPredicates;

  const baselineWidenedRoot = join(stage, "widened-baseline");
  const editedWidenedRoot = join(stage, "widened-edited");
  const pristineRoot = join(stage, "pristine");
  const baselineWidenedPaths: string[] = [];
  const editedWidenedPaths: string[] = [];
  const pristinePaths: string[] = [];
  for (const relativePath of enforcedFiles) {
    const content = repoGit(["show", `:${relativePath}`]);
    const stagedCopies = [
      {
        root: baselineWidenedRoot,
        transformed: widenDelimiterRows(content, baselinePredicates),
        collection: baselineWidenedPaths,
      },
      {
        root: editedWidenedRoot,
        transformed: widenDelimiterRows(content, workingTreePredicates),
        collection: editedWidenedPaths,
      },
      { root: pristineRoot, transformed: content, collection: pristinePaths },
    ];
    for (const { root, transformed, collection } of stagedCopies) {
      const stagedPath = join(root, relativePath);
      mkdirSync(dirname(stagedPath), { recursive: true });
      writeFileSync(stagedPath, transformed);
      collection.push(stagedPath);
    }
  }

  const baselineHits = checkBaseline(baselineWidenedPaths);
  const editedHits = checkTableArity(editedWidenedPaths);
  console.log(`\n── recognition denominator (widened delimiters) ──`);
  console.log(`  baseline (${baselineRevision.slice(0, 7)}): ${baselineHits.length}`);
  console.log(`  edited (working tree):  ${editedHits.length}`);
  console.log(`  delta:                  ${editedHits.length - baselineHits.length}`);

  // Keys are relative to each side's OWN widened root: the two sides stage
  // the same corpus layout under different directories, and keying on the
  // shared stage would make every hit LOST on one side and GAINED on the
  // other. Widening edits lines in place, so line numbers stay comparable.
  const hitKey = (root: string) => (hit: RecognitionHit) =>
    `${relative(root, hit.file)}:${hit.line}`;
  const baselineKeys = new Set(baselineHits.map(hitKey(baselineWidenedRoot)));
  const editedKeys = new Set(editedHits.map(hitKey(editedWidenedRoot)));
  const lost = [...baselineKeys].filter((key) => !editedKeys.has(key));
  const gained = [...editedKeys].filter((key) => !baselineKeys.has(key));
  console.log(`  LOST:   ${lost.length}`);
  for (const key of lost) console.log(`    ${key}`);
  console.log(`  GAINED: ${gained.length}`);
  for (const key of gained) console.log(`    ${key}`);

  // Per-file identity, not just totals: two files could trade a table and
  // leave the count unchanged.
  const perFileCounts = (hits: RecognitionHit[], root: string) => {
    const counts = new Map<string, number>();
    for (const hit of hits) {
      const relativePath = relative(root, hit.file);
      counts.set(relativePath, (counts.get(relativePath) ?? 0) + 1);
    }
    return counts;
  };
  const baselinePerFile = perFileCounts(baselineHits, baselineWidenedRoot);
  const editedPerFile = perFileCounts(editedHits, editedWidenedRoot);
  const movedFiles = [...new Set([...baselinePerFile.keys(), ...editedPerFile.keys()])].filter(
    (file) => (baselinePerFile.get(file) ?? 0) !== (editedPerFile.get(file) ?? 0),
  );
  console.log(`  files whose recognized-table count moved: ${movedFiles.length}`);
  for (const file of movedFiles) {
    console.log(
      `    ${file}: ${baselinePerFile.get(file) ?? 0} -> ${editedPerFile.get(file) ?? 0}`,
    );
  }

  // TRIPWIRE: the denominator counts violations, which equals the recognized
  // TABLE count only while every table yields exactly one forced hit. A body
  // row that is itself delimiter-shaped gets widened too and lands as a
  // second hit under the same header (Codex, PR #271) — measured zero across
  // the corpus today, and this check is what stops that zero from decaying
  // silently. Violations carry table identity as `headerLine`; a scan that
  // omits it cannot be tripwired, so its absence fails closed.
  const tablesWithMultipleHits = (hits: RecognitionHit[], root: string) => {
    const hitsPerTable = new Map<string, number>();
    for (const hit of hits) {
      if (typeof hit.headerLine !== "number") {
        console.error(
          "scan emitted a violation without a numeric headerLine — without table identity the " +
            "multi-hit tripwire cannot run; pick a baseline at or after the table-arity landing (PR #269).",
        );
        process.exit(2);
      }
      const tableKey = `${relative(root, hit.file)}@${hit.headerLine}`;
      hitsPerTable.set(tableKey, (hitsPerTable.get(tableKey) ?? 0) + 1);
    }
    return [...hitsPerTable].filter(([, count]) => count > 1);
  };
  const multiHitSides = [
    { side: "baseline", multiHit: tablesWithMultipleHits(baselineHits, baselineWidenedRoot) },
    { side: "edited", multiHit: tablesWithMultipleHits(editedHits, editedWidenedRoot) },
  ];
  for (const { side, multiHit } of multiHitSides) {
    if (multiHit.length === 0) continue;
    console.error(
      `  TRIPWIRE ${side}: ${multiHit.length} table(s) yielded more than one forced hit — ` +
        `the denominator above overcounts recognized tables; adjudicate:`,
    );
    for (const [tableKey, count] of multiHit) console.error(`    ${tableKey} x${count}`);
    process.exitCode = 1;
  }
  if (multiHitSides.every(({ multiHit }) => multiHit.length === 0)) {
    console.log(`  tripwire clean: every recognized table yielded exactly one hit on both sides`);
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
