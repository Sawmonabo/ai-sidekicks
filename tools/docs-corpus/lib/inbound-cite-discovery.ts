// inbound-cite-discovery — given staged files, returns the union of the staged
// set PLUS every governance-corpus markdown file whose outbound `:NNN` cites
// resolve into any of the staged files. Used by the pre-commit runner to widen
// cite-target validation when a governance doc is staged with a line-shifting
// edit — catches CAT-06 inbound ripple before push instead of after CI.
//
// Inbound-cite corpus = docs/{plans,specs,decisions,architecture,domain,
// operations,superpowers/plans,superpowers/specs}/*.md — every tracked tree
// that participates in the `file.md:NNN` cite graph. The six governance
// subtrees are design-contract surfaces (both citers and citees); the two
// docs/superpowers/ subtrees are governance-adjacent stable design docs that
// cite governance line numbers (skill specs + plans), so a governance line
// shift must trigger inbound-cite re-validation against them. Excludes
// docs/archive/ (frozen history), docs/reference/ (external excerpts), and
// docs/vision.md (no `:NNN` cites).
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

// is empty has no staged-only files to preserve.
// Node's spawnSync defaults maxBuffer to 1 MiB and, on overflow, KILLS the
// child with SIGTERM and returns `status: null` with TRUNCATED stdout — it
// does not throw. A caller that only checks `status !== 0` therefore sees a
// generic failure, and a caller that reads stdout without checking sees a
// silently truncated file. Both are reachable here: this repo's own
// cross-plan-dependencies.md passed 1 MiB in 2026-08, so `git show :<path>`
// on it began failing for every consumer of the runner. Every subprocess in
// this module reads repo-scale content (a whole file, a whole ls-files
// listing, a whole grep result), so all of them take the same explicit bound
// rather than the 1 MiB default that no call site here can satisfy for long.
const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

const GOVERNANCE_CORPUS_DIRS = [
  "docs/plans",
  "docs/specs",
  "docs/decisions",
  "docs/architecture",
  "docs/domain",
  "docs/operations",
  "docs/superpowers/plans",
  "docs/superpowers/specs",
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

function enumerateGovernanceCorpus(repoRoot: string, stagedNeedles: string[]): string[] {
  // Two-pass enumeration:
  //
  // 1. `git ls-files` (index-only — tracked + staged-new, excludes untracked
  //    + ignored) bounds the candidate set to what exists in CI.
  // 2. `git grep --cached -l -F` narrows that set to citers whose staged
  //    blob mentions any staged file's NEEDLE — its basename (a necessary
  //    substring of every path-shaped cite: `[label](path/to/file.md):NNN`,
  //    `path/to/file.md:NNN` in code spans) or, for label-token governance
  //    docs, the `Spec-016`-style token §-form citers reference (they never
  //    mention the filename). Without this narrowing every
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
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  });
  if (lsFiles.status !== 0) return [];
  const allTracked = lsFiles.stdout.split("\n").filter((line) => line.endsWith(".md"));
  if (stagedNeedles.length === 0) return allTracked.map((line) => resolve(repoRoot, line));

  const grepArgs = ["-C", repoRoot, "grep", "--cached", "-l", "-F"];
  for (const b of stagedNeedles) grepArgs.push("-e", b);
  grepArgs.push("--", ...GOVERNANCE_CORPUS_DIRS);
  const grep = spawnSync("git", grepArgs, {
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
  });
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
              // The governance corpus already holds a doc past 1 MB
              // (cross-plan-dependencies.md), and spawnSync's default maxBuffer is exactly
              // 1 MB. Overflow returns status null with an EMPTY stderr, so the gate died
              // with an unreadable message instead of reading the file — and any staged set
              // that reached this index path rather than the staged-file path crashed the
              // whole runner. Same ceiling listGitIndexPaths uses below.
              maxBuffer: GIT_OUTPUT_MAX_BUFFER,
            });
            if (result.status !== 0) {
              // Name the overflow explicitly. On maxBuffer overflow spawnSync
              // reports `status: null` + `signal: "SIGTERM"` + an ENOBUFS
              // error, which reads as an opaque "status null" failure and sent
              // the first reader of this message hunting a corrupt index.
              const overflowed =
                result.error !== undefined &&
                (result.error as NodeJS.ErrnoException).code === "ENOBUFS";
              // Do NOT interpolate GIT_OUTPUT_MAX_BUFFER here: the bound that
              // was actually exceeded is whatever the call site passed, and
              // naming the module constant would misreport it for any call
              // that did not pass one (Node's own 1 MiB default). Report the
              // observable facts and let the reader look up the call site.
              const detail = overflowed
                ? `output exceeded the subprocess maxBuffer and the child was killed with ${result.signal} — the file is larger than the bound this call passed`
                : `status ${result.status}: ${result.stderr.trim()}`;
              throw new Error(`git show :${relPath} failed (${detail})`);
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

// Commit-snapshot reader: the git INDEX is the single source of truth for
// what the commit will contain, for every path — citers and targets alike.
// The disk fallback exists ONLY for the runner's EXPLICIT input files
// (ad-hoc probe and preview argv): any other index miss surfaces as
// missing-target-file, whatever the worktree holds. That one rule closes
// both observed evasions — a STAGED DELETION whose worktree copy was
// restored (round 3: the earlier catch-all fallback validated the restored
// copy while the commit deleted the target) and a staged citer citing an
// UNTRACKED target (round 4: the HEAD-presence probe that replaced the
// catch-all classified never-committed targets as probe files and read
// them from disk, §-verifying a citation the commit leaves broken; Codex,
// PR #207). An untracked file the operator NAMED as input is the probe
// case and stays disk-readable — it is the invocation's subject, not a
// resolved citation target.
export function makeCommitSnapshotReader(
  repoRoot: string,
  explicitInputFiles: Iterable<string> = [],
): FileContentReader {
  const indexReader = makeIndexAwareReader(repoRoot, new Set());
  const explicitInputs = new Set([...explicitInputFiles].map((inputPath) => resolve(inputPath)));
  return (absolutePath) => {
    try {
      return indexReader(absolutePath);
    } catch (indexError) {
      if (explicitInputs.has(resolve(absolutePath))) {
        return readFileSync(absolutePath, "utf8");
      }
      throw indexError;
    }
  };
}

// Absolute path of every entry in the git INDEX (tracked + staged-new), for
// the runner's lane classification: a staged file whose worktree copy is gone
// (`git add` then `mv`/`rm` without `git rm`) is still commit content the
// commit-snapshot reader above can serve, and a lane filter that only stats
// the worktree silently dropped it from every per-file check — a required
// gate failing open (Codex, PR #269 round 4). One batched `git ls-files`
// rather than a per-path probe, for the same subprocess-count reason
// `enumerateGovernanceCorpus` batches. `-z` so no filename quoting applies.
//
// Returns null — not an empty set — when enumeration is unavailable (no git,
// not a repository): callers degrade to worktree-only classification, which
// is exactly right for non-repo invocations (ad-hoc probes, test fixtures in
// bare temp directories). An empty SET is a real answer: a repo whose index
export function listGitIndexPaths(repoRoot: string): Set<string> | null {
  const lsFiles = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--cached"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (lsFiles.status !== 0) return null;
  const indexPaths = new Set<string>();
  for (const relPath of lsFiles.stdout.split("\0")) {
    if (relPath !== "") indexPaths.add(resolve(repoRoot, relPath));
  }
  return indexPaths;
}

// Grep needles for one staged file: always its basename; for a governance doc
// in a label-token tree (`docs/specs/016-…` → `Spec-016`), ALSO the token —
// §-form citers reference the token, never the filename, so basename-only
// needles cannot reach them (Codex review, PR #188 round 2).
const LABEL_TREE_TOKENS: Record<string, string> = {
  "docs/specs": "Spec",
  "docs/plans": "Plan",
  "docs/decisions": "ADR",
};

function needlesForStagedFile(repoRoot: string, absolutePath: string): string[] {
  const fileBasename = basename(absolutePath);
  const needles = [fileBasename];
  const relDir = toRepoRelative(repoRoot, dirname(absolutePath));
  const token = LABEL_TREE_TOKENS[relDir];
  const numberedPrefix = fileBasename.match(/^(\d{3})-/);
  if (token !== undefined && numberedPrefix !== null) {
    needles.push(`${token}-${numberedPrefix[1]}`);
  }
  return needles;
}

export function expandToInboundCiteCorpus(
  stagedFiles: string[],
  repoRoot?: string,
  reader?: FileContentReader,
  // Optional secondary target-extractor (absolute paths) so callers can pull
  // in citers whose cite shapes extractCites does not know — the runner
  // passes label-cite's §-form targets here. A callback (not an import of
  // label-cite) keeps the module dependency one-directional: label-cite
  // already imports getRepoRoot from this module.
  extraCiteTargets?: (candidateAbsolutePath: string) => string[],
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

  const stagedNeedles = [...stagedAbsolute].flatMap((p) => needlesForStagedFile(root, p));
  const expanded = new Set<string>(stagedAbsolute);
  const candidates = enumerateGovernanceCorpus(root, stagedNeedles).filter(
    (candidate) => !stagedAbsolute.has(candidate),
  );
  for (const candidate of candidates) {
    const cites = extractCites(candidate, reader);
    let citesStaged = cites.some((cite) => stagedAbsolute.has(resolve(cite.targetPath)));
    if (!citesStaged && extraCiteTargets !== undefined) {
      citesStaged = extraCiteTargets(candidate).some((target) =>
        stagedAbsolute.has(resolve(target)),
      );
    }
    if (citesStaged) expanded.add(candidate);
  }
  return [...expanded];
}

// Reverse direction of expandToInboundCiteCorpus: which governance docs cite
// the STAGED CODE? Advisory-only consumer (pre-commit warning) — never blocks.
export function findGovernanceCitersOfCode(
  stagedCodeFiles: string[],
  repoRoot?: string,
  reader?: FileContentReader,
): Map<string, string[]> {
  const root = repoRoot ?? getRepoRoot();
  const stagedAbsolute = new Set(stagedCodeFiles.map((f) => resolve(f)));
  const citers = new Map<string, string[]>();
  if (stagedAbsolute.size === 0) return citers;
  const stagedBasenames = [...stagedAbsolute].map((p) => basename(p));
  for (const candidate of enumerateGovernanceCorpus(root, stagedBasenames)) {
    let rawTargets: string[];
    try {
      rawTargets = extractCites(candidate, reader)
        .filter((cite) => stagedAbsolute.has(resolve(cite.targetPath)))
        .map((cite) => cite.rawTarget);
    } catch {
      continue; // unreadable candidate — advisory path stays silent
    }
    if (rawTargets.length > 0) {
      citers.set(toRepoRelative(root, candidate), [...new Set(rawTargets)]);
    }
  }
  return citers;
}
