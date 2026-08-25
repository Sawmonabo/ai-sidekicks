#!/usr/bin/env node
// coverage-report — renders the per-package v8 coverage numbers produced by
// `turbo run test:coverage` (plus the tools/docs-corpus tree) as one markdown
// table, written to $GITHUB_STEP_SUMMARY when running under GitHub Actions and
// to stdout otherwise.
//
// Why first-party rather than a marketplace coverage-comment action
// (BL-123 Stage 1):
//   - The action updates one marker-keyed PR comment. That makes the reporting
//     surface order-dependent across concurrent jobs, and it constrains the CI
//     shape to whatever avoids the race — a constraint with no local
//     reproduction, paid on every future change to the job layout.
//   - The usual action's headline feature is threshold icons, which it derives
//     by regex-scanning a package's vitest config. Stage 1 deliberately sets no
//     thresholds and defines coverage in the repo-root `vitest.shared.ts`
//     factory, so that feature would find nothing to read.
//   - A PR comment needs `pull-requests: write`. `.github/workflows/ci.yml`
//     grants `contents: read` and nothing else today; a job summary keeps it
//     that way, and keeps third-party code out of the workflow that carries the
//     required `ci-gate`.
// Inline PR-comment rendering is the named upgrade if the summary tab proves
// too far from where reviewers look.
//
// Fail-closed, in the shape of tools/run-node-tests.mjs: a root that declares a
// `test:coverage` script but produced no report is an error, not an omitted
// table row. Otherwise a package silently dropping out of the run would show up
// as a shorter table in a green job.

import { existsSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

// Trees that carry a vitest coverage block but no package.json, so the
// workspace scan below cannot discover them. Kept explicit and asserted.
const EXTRA_ROOTS = ["tools/docs-corpus"];

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
  const roots = [...discoverWorkspaceRoots(), ...EXTRA_ROOTS];
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
      "::error::coverage-report: every root with a test:coverage script must produce a report; a missing one means the run skipped it",
    );
    process.exit(1);
  }

  const lines = [
    "## Coverage (informational)",
    "",
    "Measurement substrate only — no thresholds are enforced. Per BL-123 exit criteria (b)-(d)",
    "the per-package floors are derived from a >=5-PR sample before any number gates a merge.",
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
