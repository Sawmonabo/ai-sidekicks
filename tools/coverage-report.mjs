#!/usr/bin/env node
// Renders the per-package v8 coverage numbers from `turbo run test:coverage` as one markdown table,
// written to $GITHUB_STEP_SUMMARY under GitHub Actions and to stdout otherwise.
//
// First-party rather than a coverage-comment action: a job summary needs no `pull-requests: write`
// (`.github/workflows/ci.yml` grants `contents: read` only), keeps third-party code out of the
// workflow that carries `ci-gate`, and avoids one PR comment raced by concurrent jobs. The usual
// action also reads thresholds from a package's vitest config, and `vitest.shared.ts` sets none.
//
// Fails closed like `tools/run-node-tests.mjs`: a root that declares `test:coverage` but produced
// no report is an error, not a missing table row.

import { existsSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

/** Every workspace directory whose package.json declares a `test:coverage` script. */
function discoverWorkspaceRoots() {
  const roots = [];
  for (const workspaceDir of ["packages", "apps"]) {
    const absolute = join(REPO_ROOT, workspaceDir);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(absolute, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.scripts?.["test:coverage"]) {
        roots.push(`${workspaceDir}/${entry.name}`);
      }
    }
  }
  return roots.sort();
}

function formatPercent(metric) {
  return `${metric.pct.toFixed(2)}% (${metric.covered}/${metric.total})`;
}

function main() {
  const roots = discoverWorkspaceRoots();
  if (roots.length === 0) {
    console.error(
      "::error::coverage-report: no coverage roots discovered — workspace layout drift?",
    );
    process.exit(1);
  }

  const rows = [];
  const missing = [];
  for (const root of roots) {
    const summaryPath = join(REPO_ROOT, root, "coverage", "coverage-summary.json");
    if (!existsSync(summaryPath)) {
      missing.push(`${root} (expected ${root}/coverage/coverage-summary.json)`);
      continue;
    }
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    const { total, ...files } = summary;
    rows.push({ root, total, fileCount: Object.keys(files).length });
  }

  if (missing.length > 0) {
    for (const entry of missing) {
      console.error(`::error::coverage-report: no coverage report for ${entry}`);
    }
    console.error(
      "::error::coverage-report: every root with a test:coverage script " +
        "must produce a report; a missing one means the run skipped it",
    );
    process.exit(1);
  }

  const lines = [
    "## Coverage (informational)",
    "",
    "Measurement only: no threshold is enforced, and no number here gates a merge.",
    "",
    "| Package | Statements | Branches | Functions | Lines | Files |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const { root, total, fileCount } of rows) {
    lines.push(
      `| \`${root}\` | ${formatPercent(total.statements)} | ${formatPercent(total.branches)} | ` +
        `${formatPercent(total.functions)} | ${formatPercent(total.lines)} | ${fileCount} |`,
    );
  }
  lines.push("");
  lines.push(
    "`Files` is the report's source denominator: the number of files matched by the package's " +
      "`coverage.include` glob, whether or not a test imported them.",
  );
  lines.push("");

  const rendered = `${lines.join("\n")}\n`;
  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    appendFileSync(stepSummaryPath, rendered, "utf8");
  }
  process.stdout.write(rendered);
}

main();
