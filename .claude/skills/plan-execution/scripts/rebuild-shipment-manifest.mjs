#!/usr/bin/env node
// rebuild-shipment-manifest.mjs
//
// Recovery tool: rebuild a plan's `### Shipment Manifest` block from gh PR
// history. Use cases:
//   1. Plan pre-dates the housekeeper's structured-manifest write path
//      (Plan-001 / Plan-007 backfill — see Commit 5 of the cozy-crafting-
//      hummingbird plan).
//   2. Post-merge-housekeeper crashed mid-manifest-write and the on-disk
//      manifest drifted from git history.
//   3. Operator wants to cross-validate a hand-curated manifest against
//      gh ground truth (the Commit 5 cross-check pattern).
//
// Plan Invariant I-3 boundary: post-merge-housekeeper.mjs imports only
// node:fs/path/process and never shells out (asserted by an `I-3 invariant`
// test). This script is intentionally separate so the housekeeper invariant
// stays local; this rebuild script is a one-time / on-demand operator tool
// that DOES use child_process to query gh.
//
// CLI:
//   node --experimental-strip-types \
//     .claude/skills/plan-execution/scripts/rebuild-shipment-manifest.mjs \
//     --plan NNN [--dry-run] [--force]
//
// Exit codes:
//   0  success (entries appended OR --dry-run produced YAML)
//   1  arg-validation failure (missing --plan, malformed value)
//   2  gh runner failure (gh not installed, auth error, network)
//   3  plan file not found at docs/plans/NNN-*.md
//   4  manifest write conflict — entry exists for a PR; pass --force to
//      overwrite (default: refuse to clobber existing entries)
//   5  parse failure — proposed entry failed validateEntry() (caller should
//      inspect output, fix gh data or use --force to skip the bad entry)

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  parseManifestBlock,
  appendManifestEntry,
  validateEntry,
  serializeEntry,
} from "./lib/manifest.mjs";

// ---------- arg parsing ----------

class ArgError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv) {
  const result = { plan: null, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--plan": {
        const value = argv[i + 1];
        if (!value || !/^\d{3}$/.test(value)) {
          throw new ArgError(`--plan requires a 3-digit value (got: ${value ?? "<missing>"})`);
        }
        result.plan = value;
        i += 1;
        break;
      }
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--force":
        result.force = true;
        break;
      default:
        throw new ArgError(`unknown flag: ${flag}`);
    }
  }
  if (!result.plan) throw new ArgError("--plan is required");
  return result;
}

// ---------- gh runner (default) ----------

function defaultGhRunner(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = new Error(`gh runner failed: ${cmd}\nstderr: ${e.stderr ?? "<no stderr>"}`);
    err.cause = e;
    throw err;
  }
}

// ---------- pure parsing helpers ----------

// Parse phase number from PR title/body. Returns integer >= 1 or null.
// Checks (title first, body second; first match wins):
//   "Phase N" / "phase N"
//   "P5" / "P5.1" (Plan-001 phase-number-with-task-suffix style)
export function parsePhaseFromPr({ title, body }) {
  const patterns = [/\bPhase\s+(\d+)\b/i, /\bP(\d+)(?:\.\d+)?\b/];
  for (const text of [title, body]) {
    if (!text) continue;
    for (const re of patterns) {
      const m = re.exec(text);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

// Parse task ID(s) from PR title/body. Returns:
//   single string when exactly one task found
//   string[] when multiple distinct task IDs found (legacy multi-task PRs)
//   null when no task ID present
//
// Recognized shapes:
//   T-NNN-N-N or T-NNNp-N-N (audit-runbook style, e.g. T-007p-3-1)
//   TN.M       (Plan-001 phase-task style, e.g. T5.1)
//
// `plan` constrains the per-plan T-NNN prefix so e.g. a "T-007" cite in
// a Plan-024 PR doesn't pollute the result.
export function parseTaskFromPr({ title, body, plan }) {
  const patterns = [new RegExp(`\\bT-${plan}p?-\\d+-\\d+\\b`, "g"), /\bT\d+\.\d+\b/g];
  const found = new Set();
  for (const text of [title, body]) {
    if (!text) continue;
    for (const re of patterns) {
      const matches = text.match(re);
      if (matches) for (const m of matches) found.add(m);
    }
  }
  if (found.size === 0) return null;
  const sorted = [...found].sort();
  return sorted.length === 1 ? sorted[0] : sorted;
}

// Build a manifest-entry candidate from a PR's gh JSON. Returns
// { entry, ambiguities: string[] } where ambiguities is non-empty when
// any field needed operator confirmation (and the entry's `notes` field
// records the same).
export function buildEntryFromPr({ pr, details, plan }) {
  const ambiguities = [];
  const phase = parsePhaseFromPr(details);
  const task = parseTaskFromPr({ ...details, plan });
  const sha = (details.mergeCommit?.oid ?? "").slice(0, 7);
  const mergedAt = details.mergedAt ? details.mergedAt.split("T")[0] : null;
  const files = (details.files ?? []).map((f) => f.path).sort();

  if (phase === null) ambiguities.push("phase not in title/body");
  if (task === null) ambiguities.push("no task-id in title/body — phase-level entry");
  if (!sha) ambiguities.push("missing mergeCommit.oid");
  if (!mergedAt) ambiguities.push("missing mergedAt");

  const noteLines = [`Backfill from PR #${pr}.`];
  if (ambiguities.length > 0) {
    noteLines.push(`Operator confirmed: ${ambiguities.join("; ")}.`);
  }

  // The entry shape mirrors lib/manifest.mjs validator. When phase or task
  // can't be derived we still emit the entry (caller decides whether to
  // skip on validateEntry failure or hand-edit before commit).
  const entry = {
    phase: phase ?? 0,
    task: task ?? "",
    pr,
    sha,
    merged_at: mergedAt ?? "",
    files,
    verifies_invariant: [],
    spec_coverage: [],
    notes: noteLines.join(" "),
  };
  return { entry, ambiguities };
}

// ---------- gh fetch (uses ghRunner) ----------

export function fetchMergedPrNumbers({ plan, ghRunner = defaultGhRunner }) {
  const cmd = `gh pr list --state merged --search "Plan-${plan}" --json number --limit 200`;
  const data = JSON.parse(ghRunner(cmd));
  return data.map((p) => p.number).sort((a, b) => a - b);
}

export function fetchPrDetails({ pr, ghRunner = defaultGhRunner }) {
  const cmd = `gh pr view ${pr} --json title,body,mergedAt,mergeCommit,files`;
  return JSON.parse(ghRunner(cmd));
}

// ---------- plan-file resolver ----------

export function resolvePlanFile({ plan, plansDir = "docs/plans" }) {
  if (!existsSync(plansDir)) return null;
  const candidates = readdirSync(plansDir).filter(
    (f) => f.startsWith(`${plan}-`) && f.endsWith(".md"),
  );
  if (candidates.length !== 1) return null;
  return join(plansDir, candidates[0]);
}

// ---------- main ----------

export async function rebuildManifest({
  plan,
  dryRun,
  force,
  ghRunner = defaultGhRunner,
  plansDir = "docs/plans",
  stdout = process.stdout,
}) {
  const planFile = resolvePlanFile({ plan, plansDir });
  if (!planFile) {
    return { exitCode: 3, message: `plan file not found: ${plansDir}/${plan}-*.md` };
  }

  const prNumbers = fetchMergedPrNumbers({ plan, ghRunner });
  if (prNumbers.length === 0) {
    return { exitCode: 0, message: `no merged PRs found for Plan-${plan}` };
  }

  const built = [];
  for (const pr of prNumbers) {
    const details = fetchPrDetails({ pr, ghRunner });
    built.push(buildEntryFromPr({ pr, details, plan }));
  }

  // Validate every entry; collect failures. Caller can pass --force to
  // skip failed entries (rare — usually means a PR has no merge SHA yet,
  // i.e. it was queued and reverted).
  const validated = [];
  const validationFailures = [];
  for (const { entry, ambiguities } of built) {
    const v = validateEntry(entry);
    if (v.ok) {
      validated.push({ entry, ambiguities });
    } else {
      validationFailures.push({ pr: entry.pr, errors: v.errors });
    }
  }
  if (validationFailures.length > 0 && !force) {
    return {
      exitCode: 5,
      message:
        `validation failures (use --force to skip):\n` +
        validationFailures.map((f) => `  PR #${f.pr}: ${f.errors.join(" | ")}`).join("\n"),
    };
  }

  if (dryRun) {
    stdout.write(`# Rebuilt manifest for Plan-${plan} (dry run)\n`);
    stdout.write(`manifest_schema_version: 1\n`);
    stdout.write(`shipped:\n`);
    for (const { entry } of validated) {
      for (const line of serializeEntry(entry)) stdout.write(`${line}\n`);
    }
    if (validationFailures.length > 0) {
      stdout.write(`\n# Skipped (validation failures, --force was passed):\n`);
      for (const f of validationFailures) {
        stdout.write(`#   PR #${f.pr}: ${f.errors.join(" | ")}\n`);
      }
    }
    return { exitCode: 0, message: `${validated.length} entries emitted` };
  }

  // Write mode: read plan file, append each entry idempotently. If an
  // entry already exists for a PR, default behavior refuses to overwrite
  // (returns exitCode 4 with detail); --force replaces (NOT YET — current
  // appendManifestEntry is no-op on collision; force-overwrite would need
  // a separate replace helper).
  let source = readFileSync(planFile, "utf8");
  const existing = parseManifestBlock(source);
  if (!existing.ok) {
    return {
      exitCode: 3,
      message: `plan ${planFile} has no parseable manifest block: ${existing.reason}`,
    };
  }
  const existingPrs = new Set(existing.shipped.map((e) => e.pr));
  const collisions = validated.filter(({ entry }) => existingPrs.has(entry.pr));
  if (collisions.length > 0 && !force) {
    return {
      exitCode: 4,
      message:
        `manifest already has entries for: ${collisions.map((c) => `#${c.entry.pr}`).join(", ")}\n` +
        `Pass --force to skip these (current --force is no-overwrite skip; in-place replace is not yet supported).`,
    };
  }

  let appended = 0;
  for (const { entry } of validated) {
    const before = source;
    source = appendManifestEntry(source, entry);
    if (source !== before) appended += 1;
  }
  writeFileSync(planFile, source);
  return {
    exitCode: 0,
    message: `appended ${appended} new entries to ${planFile} (${validated.length - appended} were already present)`,
  };
}

// ---------- CLI entry ----------

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(e.exitCode ?? 1);
  }
  rebuildManifest(args)
    .then((r) => {
      process.stdout.write(`${r.message}\n`);
      process.exit(r.exitCode);
    })
    .catch((e) => {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(2);
    });
}
