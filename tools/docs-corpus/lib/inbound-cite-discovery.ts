// inbound-cite-discovery — given staged files, returns the union of the staged
// set PLUS every governance-corpus markdown file whose outbound `:NNN` cites
// resolve into any of the staged files. Used by the pre-commit runner to widen
// cite-target validation when a governance doc is staged with a line-shifting
// edit — catches CAT-06 inbound ripple before push instead of after CI.
//
// "Governance corpus" = docs/{plans,specs,decisions,architecture,domain,
// operations}/*.md — the design-contract surfaces whose line numbers other
// docs cite by `:NNN`. Excludes docs/archive/ (frozen history), docs/reference/
// (external excerpts), docs/vision.md (no inbound :NNN cites), and
// docs/superpowers/ (transient research drafts).
//
// Enumeration uses `git ls-files` so the candidate set is bounded to tracked
// + staged-new files — untracked private drafts must not block a commit on
// cites that do not exist in CI.

import { existsSync } from "node:fs";
import { resolve, relative, dirname, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { extractCites } from "./cite-target-existence.ts";

const GOVERNANCE_CORPUS_DIRS = [
  "docs/plans",
  "docs/specs",
  "docs/decisions",
  "docs/architecture",
  "docs/domain",
  "docs/operations",
];

function findRepoRoot(): string {
  // Termination via parent-equals-current matches cite-target-existence.ts so
  // the walk completes on Windows drive roots too. Falls back to process.cwd()
  // when no .git ancestor exists.
  let dir = process.cwd();
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function getRepoRoot(): string {
  return process.env.REPO_ROOT ?? findRepoRoot();
}

function toRepoRelative(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).split(sep).join("/");
}

function isInGovernanceCorpus(repoRoot: string, absolutePath: string): boolean {
  if (!absolutePath.endsWith(".md")) return false;
  const rel = toRepoRelative(repoRoot, absolutePath);
  return GOVERNANCE_CORPUS_DIRS.some((dir) => rel.startsWith(`${dir}/`));
}

function enumerateGovernanceCorpus(repoRoot: string): string[] {
  // Use `git ls-files` (index-only by default — tracked + staged-new, excludes
  // untracked + ignored). A raw filesystem walk would scan untracked WIP and
  // could block a developer's commit on a stale cite in a private draft that
  // does not exist in CI. Graceful fallback: return [] on spawn/status error
  // — the new inbound expansion is lost but pre-existing per-file coverage
  // is preserved, and CI's repo-wide sweep remains the backstop.
  //
  // The `existsSync` filter handles the common local state where a tracked
  // governance file has been deleted from the worktree without staging the
  // delete: `git ls-files --cached` (the default) still lists it, but the
  // downstream `readFileSync` in `extractCites` would throw ENOENT and crash
  // the pre-commit runner.
  //
  // The dirty-set filter (`git diff --name-only` = working-tree-vs-index)
  // skips citers with unstaged WIP. Without it, `extractCites` reads the
  // working tree and leaks the developer's unstaged edits into the validation
  // set — a developer mid-editing one governance doc would be blocked while
  // staging an unrelated change. Skipped citers will be validated whenever
  // they themselves get staged + committed, and CI's repo-wide sweep remains
  // the backstop for the residual Scenario-Y case (unstaged WIP would have
  // fixed a HEAD-stale cite that this commit's line-shift now exposes).
  const lsFiles = spawnSync("git", ["-C", repoRoot, "ls-files", "--", ...GOVERNANCE_CORPUS_DIRS], {
    encoding: "utf8",
  });
  if (lsFiles.status !== 0) return [];

  const diff = spawnSync("git", ["-C", repoRoot, "diff", "--name-only"], {
    encoding: "utf8",
  });
  const dirty = new Set<string>(diff.status === 0 ? diff.stdout.split("\n").filter(Boolean) : []);

  return lsFiles.stdout
    .split("\n")
    .filter((line) => line.endsWith(".md"))
    .filter((line) => !dirty.has(line))
    .map((line) => resolve(repoRoot, line))
    .filter((absolute) => existsSync(absolute));
}

export function expandToInboundCiteCorpus(stagedFiles: string[], repoRoot?: string): string[] {
  const root = repoRoot ?? getRepoRoot();
  const stagedAbsolute = new Set<string>(stagedFiles.map((f) => resolve(f)));
  // Expand only when at least one staged file lives inside the governance
  // corpus — otherwise the corpus walk is wasted work, and a non-governance
  // staged file (README.md, docs/vision.md) can't trigger inbound ripple.
  let hasGovernanceStaged = false;
  for (const staged of stagedAbsolute) {
    if (isInGovernanceCorpus(root, staged)) {
      hasGovernanceStaged = true;
      break;
    }
  }
  if (!hasGovernanceStaged) return [...stagedAbsolute];

  const expanded = new Set<string>(stagedAbsolute);
  const candidates = enumerateGovernanceCorpus(root).filter(
    (candidate) => !stagedAbsolute.has(candidate),
  );
  for (const candidate of candidates) {
    const cites = extractCites(candidate);
    for (const cite of cites) {
      if (stagedAbsolute.has(resolve(cite.targetPath))) {
        expanded.add(candidate);
        break;
      }
    }
  }
  return [...expanded];
}
