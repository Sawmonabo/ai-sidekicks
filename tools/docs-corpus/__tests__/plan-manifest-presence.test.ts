import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

import {
  checkPlanManifestPresence,
  formatPlanManifestViolations,
} from "../lib/plan-manifest-presence.ts";
import {
  MANIFEST_SCHEMA_VERSION,
  parseManifestBlock,
  validateEntry,
} from "../../../.claude/skills/plan-execution/scripts/lib/manifest.mjs";

// The empty `shipped: []` manifest block — identical in shape to what the
// backfill appends to every never-shipped plan.
const VALID_MANIFEST = [
  "## Progress Log",
  "",
  "### Shipment Manifest",
  "",
  "```yaml",
  "manifest_schema_version: 1",
  "shipped: []",
  "```",
  "",
  "### Notes",
].join("\n");

function plan(status: string, opts: { manifest?: boolean } = {}): string {
  const body = [
    "# Plan — Fixture",
    "",
    `| **Status** | \`${status}\` |`,
    "",
    "## Scope",
    "",
    "Body.",
    "",
  ];
  if (opts.manifest) body.push(VALID_MANIFEST, "");
  body.push("## Done Checklist", "", "- [ ] done", "");
  return body.join("\n");
}

// A manifest that PARSES (valid fence + schema version + `shipped` key) but
// whose single shipped[] entry fails validateEntry — `phase: 1` alone is missing
// the other required keys (task, pr, sha, merged_at, files). Mirrors the
// manifest_invalid_entries class preflight Gate 3 halts on.
const INVALID_ENTRY_MANIFEST = [
  "## Progress Log",
  "",
  "### Shipment Manifest",
  "",
  "```yaml",
  "manifest_schema_version: 1",
  "shipped:",
  "  - phase: 1",
  "```",
  "",
  "### Notes",
].join("\n");

function planWithManifest(status: string, manifestBlock: string): string {
  return [
    "# Plan — Fixture",
    "",
    `| **Status** | \`${status}\` |`,
    "",
    "## Scope",
    "",
    "Body.",
    "",
    manifestBlock,
    "",
    "## Done Checklist",
    "",
    "- [ ] done",
    "",
  ].join("\n");
}

function setupRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(resolve(tmpdir(), "pmp-"));
  execSync("git init -q -b main", { cwd: root });
  execSync("git config user.email test@test", { cwd: root });
  execSync("git config user.name test", { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    const full = resolve(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  execSync("git add -A && git commit -q -m bootstrap", { cwd: root });
  return { root, cleanup: () => rmSync(root, { recursive: true }) };
}

// The check resolves the corpus via getRepoRoot() (REPO_ROOT env override) and
// reads each plan from the git index, so a temp repo (with all fixtures
// committed) + REPO_ROOT fully isolates it without mutating process.cwd().
function runCheck(root: string): ReturnType<typeof checkPlanManifestPresence> {
  const prev = process.env.REPO_ROOT;
  try {
    process.env.REPO_ROOT = root;
    return checkPlanManifestPresence();
  } finally {
    if (prev === undefined) delete process.env.REPO_ROOT;
    else process.env.REPO_ROOT = prev;
  }
}

describe("plan-manifest-presence", () => {
  it("REJECTS an approved plan with no Shipment Manifest", () => {
    const { root, cleanup } = setupRepo({ "docs/plans/005-foo.md": plan("approved") });
    const hits = runCheck(root);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ status: "approved", reason: "no_section" });
    expect(formatPlanManifestViolations(hits)).toMatch(/005-foo\.md/);
    cleanup();
  });

  it("ACCEPTS an approved plan with a valid empty (shipped: []) manifest", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/005-foo.md": plan("approved", { manifest: true }),
    });
    expect(runCheck(root)).toEqual([]);
    cleanup();
  });

  it("REQUIRES a manifest for review and completed plans, not only approved", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/004-review.md": plan("review"),
      "docs/plans/001-completed.md": plan("completed"),
    });
    const hits = runCheck(root);
    expect(hits.map((h) => h.status).sort()).toEqual(["completed", "review"]);
    cleanup();
  });

  it("EXEMPTS draft and superseded plans (manifest not yet required)", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/030-draft.md": plan("draft"),
      "docs/plans/031-superseded.md": plan("superseded"),
    });
    expect(runCheck(root)).toEqual([]);
    cleanup();
  });

  it("EXCLUDES 000-plan-template.md (ships the empty manifest as a copy-me example)", () => {
    const { root, cleanup } = setupRepo({
      "docs/plans/000-plan-template.md": "# Template\n\nNo status row, no manifest.\n",
      "docs/plans/005-foo.md": plan("approved", { manifest: true }),
    });
    expect(runCheck(root)).toEqual([]);
    cleanup();
  });

  it("reads the INDEX: an unstaged manifest does NOT clear the violation; staging it does", () => {
    // Mirror of path-canonical-ripple's `--cached` semantics: a pre-commit gate
    // validates what the NEXT COMMIT would contribute. An unstaged manifest edit
    // on disk must not clear a violation the index still carries — otherwise a
    // staged manifest-less promotion is masked behind unstaged WIP, the
    // false-negative this gate exists to prevent. Only a STAGED fix moves it.
    const root = mkdtempSync(resolve(tmpdir(), "pmp-idx-"));
    execSync("git init -q -b main", { cwd: root });
    execSync("git config user.email test@test", { cwd: root });
    execSync("git config user.name test", { cwd: root });
    const file = resolve(root, "docs/plans/005-foo.md");
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, plan("approved")); // committed WITHOUT a manifest
    execSync("git add -A && git commit -q -m bootstrap", { cwd: root });
    const prev = process.env.REPO_ROOT;
    try {
      process.env.REPO_ROOT = root;
      expect(checkPlanManifestPresence()).toHaveLength(1); // committed/index state: violation
      // Direction 1: add the manifest to the WORKING TREE only — do NOT stage.
      // The index is unchanged, so the violation must persist.
      writeFileSync(file, plan("approved", { manifest: true }));
      expect(checkPlanManifestPresence()).toHaveLength(1);
      // Direction 2: stage the fix — the index now carries the manifest — and
      // the violation clears. Together these pin index (not working-tree) reads.
      execSync("git add docs/plans/005-foo.md", { cwd: root });
      expect(checkPlanManifestPresence()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = prev;
      rmSync(root, { recursive: true });
    }
  });

  it("REJECTS a manifest that parses but has an invalid shipped[] entry (mirrors Gate 3)", () => {
    // parseManifestBlock returns ok for this block (fence + schema version +
    // `shipped` key all present), but the lone entry fails validateEntry —
    // exactly the manifest_invalid_entries case that HALTS preflight Gate 3
    // mid-run. A presence-only check would miss it.
    const { root, cleanup } = setupRepo({
      "docs/plans/005-foo.md": planWithManifest("approved", INVALID_ENTRY_MANIFEST),
    });
    const hits = runCheck(root);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ status: "approved", reason: "invalid_entries" });
    expect(hits[0].detail?.[0]).toMatch(/shipped\[0\]/);
    expect(formatPlanManifestViolations(hits)).toMatch(/invalid_entries/);
    cleanup();
  });

  it("FAILS OPEN on an unknown future schema version (mirrors Gate 3 manifest_future_schema)", () => {
    // A manifest whose version exceeds what this guard's parser knows is treated
    // as opaque, not judged by today's entry rules — the one intentional
    // fail-open, identical to classifyPhaseShipment. Pin it so a future bump
    // can't silently turn this into a false reject.
    const future = [
      "## Progress Log",
      "",
      "### Shipment Manifest",
      "",
      "```yaml",
      `manifest_schema_version: ${MANIFEST_SCHEMA_VERSION + 1}`,
      "shipped:",
      "  - phase: 1", // would FAIL validateEntry under v1 rules — must be skipped
      "```",
      "",
      "### Notes",
    ].join("\n");
    const { root, cleanup } = setupRepo({
      "docs/plans/005-foo.md": planWithManifest("approved", future),
    });
    expect(runCheck(root)).toEqual([]);
    cleanup();
  });

  it("FAILS CLOSED when the corpus cannot be enumerated (not a git repo)", () => {
    // A presence gate that cannot read the corpus must surface the failure, not
    // report "all clear" — mirrors path-canonical-ripple's fail-closed stance.
    const root = mkdtempSync(resolve(tmpdir(), "pmp-nogit-"));
    const prev = process.env.REPO_ROOT;
    try {
      process.env.REPO_ROOT = root; // no `git init` → git ls-files errors
      expect(() => checkPlanManifestPresence()).toThrow(/could not enumerate plans/i);
    } finally {
      if (prev === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = prev;
      rmSync(root, { recursive: true });
    }
  });

  it("DRIFT GUARD: parseManifestBlock + validateEntry return the shapes this gate relies on", () => {
    // Pins manifest.d.mts to the manifest.mjs runtime. If the canonical parser's
    // or validator's contract changes, this fails — forcing the declaration +
    // guard to update in lockstep instead of drifting silently.
    expect(parseManifestBlock("# Plan\n\nNo manifest at all.\n")).toEqual({
      ok: false,
      reason: "no_section",
    });
    const valid = parseManifestBlock(plan("approved", { manifest: true }));
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.version).toBe(1);
      expect(valid.shipped).toEqual([]);
    }
    // validateEntry + MANIFEST_SCHEMA_VERSION feed the invalid-entry and
    // future-schema branches above; pin their shapes too.
    expect(typeof MANIFEST_SCHEMA_VERSION).toBe("number");
    const bad = validateEntry({ phase: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Array.isArray(bad.errors)).toBe(true);
  });
});
