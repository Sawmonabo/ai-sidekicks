import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

import {
  checkPlanManifestPresence,
  formatPlanManifestViolations,
} from "../lib/plan-manifest-presence.ts";
import { parseManifestBlock } from "../../../.claude/skills/plan-execution/scripts/lib/manifest.mjs";

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
// reads each plan from the working tree, so a temp repo + REPO_ROOT fully
// isolates it without mutating process.cwd().
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

  it("reads the WORKING TREE: an unstaged manifest addition clears the violation", () => {
    // Mirror of path-canonical-ripple's `--cached` test with inverted polarity:
    // that check hunts FORBIDDEN content and reads the index so unstaged WIP
    // can't block an unrelated commit; this check requires PRESENT content, so
    // it reads the working tree to the same end — a plan whose manifest is being
    // added on a parallel branch (on disk, not yet staged) must not block an
    // unrelated commit.
    const root = mkdtempSync(resolve(tmpdir(), "pmp-wt-"));
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
      expect(checkPlanManifestPresence()).toHaveLength(1); // committed state: violation
      writeFileSync(file, plan("approved", { manifest: true })); // add to working tree, do NOT stage
      expect(checkPlanManifestPresence()).toEqual([]); // working-tree read clears it
      // Inverse: the index still lacks the manifest — proves it's the working
      // tree, not the index, that cleared the violation.
      const indexed = execSync("git show :docs/plans/005-foo.md", { cwd: root, encoding: "utf8" });
      expect(indexed).not.toMatch(/Shipment Manifest/);
    } finally {
      if (prev === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = prev;
      rmSync(root, { recursive: true });
    }
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

  it("DRIFT GUARD: parseManifestBlock returns the ok/reason shapes this gate relies on", () => {
    // Pins manifest.d.mts to the manifest.mjs runtime. If the canonical parser's
    // contract changes, this fails — forcing the declaration + guard to update
    // in lockstep instead of drifting silently.
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
  });
});
