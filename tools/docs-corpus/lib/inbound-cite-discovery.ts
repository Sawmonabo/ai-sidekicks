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
// cites that do not exist in CI. Content reads route through an index-aware
// reader (`makeIndexAwareReader`) so unstaged WIP in citers and worktree-only
// deletions do not influence the validation set — only the index (the
// would-be-committed state) is consulted for non-argv-staged paths.

import { readFileSync, existsSync } from "node:fs";
import { resolve, relative, dirname, sep, basename } from "node:path";
import { spawnSync } from "node:child_process";

import { extractCites, type FileContentReader } from "./cite-target-existence.ts";

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

export function getRepoRoot(): string {
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

function enumerateGovernanceCorpus(repoRoot: string, stagedBasenames: string[]): string[] {
  // Two-pass enumeration:
  //
  // 1. `git ls-files` (index-only — tracked + staged-new, excludes untracked
  //    + ignored) bounds the candidate set to what exists in CI.
  // 2. `git grep --cached -l -F` narrows that set to citers whose staged
  //    blob mentions any staged file's BASENAME — a necessary substring of
  //    every cite shape we recognize (`[label](path/to/file.md):NNN` or
  //    `path/to/file.md:NNN` in code spans). Without this narrowing every
  //    governance file becomes a `git show :path` subprocess (~20ms each on
  //    macOS), turning a single-file stage into a 2-3s pre-commit on the
  //    real repo (~120 governance files). Substring-only false positives
  //    (e.g., a citer that mentions the basename without a `:NNN` cite) are
  //    cheap — extractCites simply finds no cite and the candidate falls
  //    out of the union.
  //
  // Graceful fallback: return [] on spawn error for either pass — the
  // inbound expansion is lost but pre-existing per-file coverage is
  // preserved, and CI's repo-wide sweep remains the backstop. `git grep`
  // exits 1 on "no matches" (not an error); treat 0 and 1 as success.
  const lsFiles = spawnSync("git", ["-C", repoRoot, "ls-files", "--", ...GOVERNANCE_CORPUS_DIRS], {
    encoding: "utf8",
  });
  if (lsFiles.status !== 0) return [];
  const allTracked = lsFiles.stdout.split("\n").filter((line) => line.endsWith(".md"));
  if (stagedBasenames.length === 0) return allTracked.map((line) => resolve(repoRoot, line));

  const grepArgs = ["-C", repoRoot, "grep", "--cached", "-l", "-F"];
  for (const b of stagedBasenames) grepArgs.push("-e", b);
  grepArgs.push("--", ...GOVERNANCE_CORPUS_DIRS);
  const grep = spawnSync("git", grepArgs, { encoding: "utf8" });
  // git grep status: 0 = matches, 1 = no matches, 128 = error.
  if (grep.status !== 0 && grep.status !== 1) {
    return allTracked.map((line) => resolve(repoRoot, line));
  }
  const candidates = new Set(grep.stdout.split("\n").filter(Boolean));
  return allTracked.filter((line) => candidates.has(line)).map((line) => resolve(repoRoot, line));
}

// makeIndexAwareReader builds a FileContentReader that distinguishes the
// developer's explicit opt-in (argv-staged paths → working tree) from
// auto-expanded scope (everything else → git index via `git show :path`).
// The returned reader memoizes by absolute path so each file is fetched at
// most once across the corpus walk + cite-target checks — without this,
// the redundant re-reads turn ~50 governance files into ~50 + ~hundreds of
// subprocesses (extractCites runs twice per citer; cite-targets are looked
// up per-cite). Pre-commit p99 with memoization: ~250ms vs ~3.5s without.
//
// Why two semantics:
// - argv-staged is the convention: developers stage, sometimes continue
//   editing, and the runner validates the working tree as a close-enough
//   proxy for the index. Switching argv-staged paths to index-only would
//   surprise developers ("I just fixed that").
// - Auto-expanded scope was NOT opted in. Reading the working tree leaks
//   unstaged WIP into the validation set — a developer mid-editing one
//   governance doc gets blocked staging an unrelated change. Reading the
//   index instead matches what CI would see post-merge.
//
// Errors from `git show :path` (exit 128 on untracked / outside-repo path)
// surface as a thrown Error so checkCite's catch maps them to
// `missing-target-file` — semantically equivalent to ENOENT under the
// default reader. Memoization caches errors too so a failed lookup costs
// the same as a successful one on the second hit.
export function makeIndexAwareReader(
  repoRoot: string,
  stagedPaths: Set<string>,
): FileContentReader {
  const cache = new Map<string, { ok: true; content: string } | { ok: false; error: Error }>();
  return (absolutePath) => {
    const cached = cache.get(absolutePath);
    if (cached !== undefined) {
      if (cached.ok) return cached.content;
      throw cached.error;
    }
    try {
      const content = stagedPaths.has(absolutePath)
        ? readFileSync(absolutePath, "utf8")
        : (() => {
            const relPath = toRepoRelative(repoRoot, absolutePath);
            const result = spawnSync("git", ["-C", repoRoot, "show", `:${relPath}`], {
              encoding: "utf8",
            });
            if (result.status !== 0) {
              throw new Error(
                `git show :${relPath} failed (status ${result.status}): ${result.stderr.trim()}`,
              );
            }
            return result.stdout;
          })();
      cache.set(absolutePath, { ok: true, content });
      return content;
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      cache.set(absolutePath, { ok: false, error: e });
      throw e;
    }
  };
}

export function expandToInboundCiteCorpus(
  stagedFiles: string[],
  repoRoot?: string,
  reader?: FileContentReader,
): string[] {
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

  const stagedBasenames = [...stagedAbsolute].map((p) => basename(p));
  const expanded = new Set<string>(stagedAbsolute);
  const candidates = enumerateGovernanceCorpus(root, stagedBasenames).filter(
    (candidate) => !stagedAbsolute.has(candidate),
  );
  for (const candidate of candidates) {
    const cites = extractCites(candidate, reader);
    for (const cite of cites) {
      if (stagedAbsolute.has(resolve(cite.targetPath))) {
        expanded.add(candidate);
        break;
      }
    }
  }
  return [...expanded];
}
