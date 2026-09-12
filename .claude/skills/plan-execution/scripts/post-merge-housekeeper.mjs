#!/usr/bin/env node
// post-merge-housekeeper.mjs — plan-execution skill housekeeper script.
//
// Authoritative contract: ../references/post-merge-housekeeper-contract.md.
//
// One job: after a phase PR squash-merges, propose the plan's own
// `### Shipment Manifest` YAML entry for that PR and emit it as a JSON
// manifest under `.agents/tmp/`. The orchestrator merges in the DAG's
// audit-derived fields and performs the plan-file write; this script edits no
// document and shells out to nothing.
//
// Public surface (used by runHousekeeper + tests):
//   parseArgs + ParseArgsError   — CLI argument parsing
//   buildProposedManifestEntry   — the proposed Shipment Manifest entry
//   emitManifest                 — manifest JSON writer
//   readTouchedFilesFromPath     — touched-file list reader

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

// ---------- parseArgs ----------
//
// Throws ParseArgsError(exitCode≥6) on shape-validation violations. The CLI
// entrypoint translates `error.exitCode` into the process exit code so callers
// can route on it.

export class ParseArgsError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "ParseArgsError";
    this.exitCode = exitCode;
  }
}

// Positive-integer regex: rejects empty, `0`, `00`, and leading zeros (`01`).
// PR numbers MUST be > 0 — `0` flowing in from an unset upstream env var
// default would otherwise corrupt the audit trail with "PR #0" instead of
// failing fast at arg parse.
const PR_NUMBER_RE = /^[1-9]\d*$/;
const PLAN_RE = /^\d{3}(-partial)?$/;
const PHASE_RE = /^(\d+|[A-Z])$/;
const TASK_RE = /^(T\d+(\.\d+)?|T-\d{3}-\d+-\d+|tier-\d+)$/;
// Mirrors lib/manifest.mjs SHA_RE + DATE_RE — the single source of truth lives
// in the shared module; we re-validate at the CLI surface so a malformed value
// fails fast at parseArgs rather than producing an invalid manifest entry the
// orchestrator's appendManifestEntry would later reject.
const SQUASH_SHA_RE = /^[0-9a-f]{7,40}$/i;
const MERGED_AT_RE = /^\d{4}-\d{2}-\d{2}$/;

const VALUE_FLAGS = new Set([
  "--plan",
  "--phase",
  "--task",
  "--touched-files-path",
  "--squash-sha",
  "--merged-at",
]);

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new ParseArgsError("missing positional <PR#> argument", 6);
  }
  const [first, ...rest] = argv;
  if (!PR_NUMBER_RE.test(first)) {
    throw new ParseArgsError(`<PR#> must be a positive integer, got: ${first}`, 6);
  }
  const result = {
    prNumber: Number(first),
    plan: null,
    phase: null,
    task: null,
    touchedFilesPath: null,
    squashSha: null,
    mergedAt: null,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!VALUE_FLAGS.has(flag)) {
      throw new ParseArgsError(`unknown flag: ${flag}`, 6);
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ParseArgsError(`flag ${flag} requires a value`, 6);
    }
    i += 1;
    switch (flag) {
      case "--plan":
        if (!PLAN_RE.test(value)) throw new ParseArgsError(`--plan malformed: ${value}`, 6);
        result.plan = value;
        break;
      case "--phase":
        if (!PHASE_RE.test(value)) throw new ParseArgsError(`--phase malformed: ${value}`, 6);
        result.phase = value;
        break;
      case "--task":
        if (!TASK_RE.test(value)) throw new ParseArgsError(`--task malformed: ${value}`, 6);
        result.task = value;
        break;
      case "--touched-files-path":
        result.touchedFilesPath = value;
        break;
      case "--squash-sha":
        if (!SQUASH_SHA_RE.test(value)) {
          throw new ParseArgsError(`--squash-sha malformed: ${value}`, 6);
        }
        result.squashSha = value;
        break;
      case "--merged-at":
        if (!MERGED_AT_RE.test(value)) {
          throw new ParseArgsError(`--merged-at malformed: ${value}`, 6);
        }
        result.mergedAt = value;
        break;
    }
  }
  return result;
}

// ---------- buildProposedManifestEntry + emitManifest ----------
//
// The manifest is written under <repoRoot>/.agents/tmp/.
//
// `proposed_manifest_entry` is the script's draft of the in-plan
// `### Shipment Manifest` YAML entry the orchestrator appends via
// lib/housekeeper-orchestrator-helpers.buildFinalManifestEntry. It is null when
// the identity or merge metadata the entry requires is missing (graceful
// degradation for tests and partial callers); the script never edits the plan
// file's manifest block itself.

export function buildProposedManifestEntry({ args, diffTouchedFiles }) {
  if (!args.squashSha || !args.mergedAt) return null;
  if (!args.plan || !args.phase || !args.task) return null;
  // Phase A-Z (Tier-A / Tier-B style) cannot be expressed as a positive
  // integer; the manifest schema requires `phase: <int>`. Skip rather than
  // coerce — any later consumer would reject NaN.
  const phaseNum = Number(args.phase);
  if (!Number.isInteger(phaseNum) || phaseNum < 1) return null;
  return {
    phase: phaseNum,
    task: args.task,
    pr: args.prNumber,
    sha: args.squashSha,
    merged_at: args.mergedAt,
    files: diffTouchedFiles ?? [],
    // verifies_invariant + spec_coverage come from the audit Tasks-block
    // (analyst output → DAG → orchestrator). The script has no DAG access; the
    // orchestrator merges these in before the final appendManifestEntry call.
    verifies_invariant: [],
    spec_coverage: [],
  };
}

export function emitManifest({
  repoRoot,
  prNumber,
  generatedAt = null,
  plan = null,
  phase = null,
  taskId = null,
  scriptExitCode,
  proposedManifestEntry = null,
}) {
  const tmpDir = join(repoRoot, ".agents", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const manifestPath = join(tmpDir, `housekeeper-manifest-PR${prNumber}.json`);
  const manifest = {
    generated_at: generatedAt ?? new Date().toISOString(),
    pr_number: prNumber,
    plan,
    phase,
    task_id: taskId,
    script_exit_code: scriptExitCode,
    proposed_manifest_entry: proposedManifestEntry,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifestPath };
}

export function runHousekeeper({
  args,
  repoRoot,
  today = process.env.HOUSEKEEPER_TODAY ?? new Date().toISOString().slice(0, 10),
  diffTouchedFiles = null,
}) {
  const { manifestPath } = emitManifest({
    repoRoot,
    prNumber: args.prNumber,
    generatedAt: `${today}T00:00:00Z`,
    plan: args.plan,
    phase: args.phase,
    taskId: args.task ?? null,
    scriptExitCode: 0,
    proposedManifestEntry: buildProposedManifestEntry({ args, diffTouchedFiles }),
  });
  return { exitCode: 0, manifestPath };
}

// Diff source: the orchestrator owns git knowledge — this script never shells
// out to git. The orchestrator computes the PR-wide diff (e.g.
// `git diff origin/develop...HEAD --name-only` on the feature branch BEFORE
// squash-merge) and writes the resulting one-path-per-line file, then passes
// its absolute path via `--touched-files-path`. Tests inject `diffTouchedFiles`
// directly (bypassing the CLI file read) for hermeticity.
export function readTouchedFilesFromPath(touchedFilesPath) {
  const out = readFileSync(touchedFilesPath, "utf8");
  return out.split("\n").filter(Boolean);
}

/**
 * Direct-invocation guard — same form as
 * `tools/docs-corpus/bin/pre-commit-runner.ts` § isDirectlyInvoked.
 *
 * NOT a comparison of `import.meta.url` against a `file://` string built from
 * `process.argv[1]`: that compares a percent-ENCODED URL against a raw path, so
 * a checkout under a directory containing a space (or `#`, `?`, non-ASCII)
 * makes them unequal and this script silently does nothing while exiting 0.
 * `realpathSync` on both sides also survives a symlinked invocation
 * (macOS `/tmp` → `/private/tmp`).
 *
 * A miss here is worse than a plain no-op: Phase E would go on to read
 * `.agents/tmp/housekeeper-manifest-PR<N>.json`, and because that path is keyed
 * only on the PR number, a STALE manifest from an earlier run of the same PR
 * would validate and be acted upon as if this run had produced it.
 */
function isDirectlyInvoked() {
  const invokedPath = process.argv[1];
  if (typeof invokedPath !== "string") return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that will not resolve to a real file was not this module's entry
    // point, so `false` is the correct answer rather than a swallowed failure.
    return false;
  }
}

if (isDirectlyInvoked()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.touchedFilesPath === null) {
      throw new ParseArgsError("--touched-files-path is required when invoked as CLI", 6);
    }
    const repoRoot = process.cwd();
    const diffTouchedFiles = readTouchedFilesFromPath(args.touchedFilesPath);
    const result = runHousekeeper({ args, repoRoot, diffTouchedFiles });
    process.exit(result.exitCode);
  } catch (err) {
    if (err instanceof ParseArgsError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    throw err;
  }
}
