// cite-target-existence — verifies `file.md:NNN` style line citations point at
// a non-empty line of a file with at least NNN lines.
//
// Catches the FLOOR of line-citation drift: truncation, file rename / delete,
// empty-line-targeting. Does NOT catch semantic drift (Spec-027:6 → :5 — both
// lines exist, both non-empty). Semantic drift is residual; see
// docs/operations/failure-mode-catalog.md row CAT-07.
//
// Citation forms recognized:
//   - [Plan-001](../plans/001-shared-session-core.md):12         (markdown link with trailing :N)
//   - [Plan-001](../plans/001-shared-session-core.md):12, 55, 121
//   - `session.ts:408`                                            (inline-code with :N)

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";

export interface Cite {
  file: string;
  line: number;
  rawTarget: string;
  targetPath: string;
  targetLine: number;
}

export interface CiteViolation {
  cite: Cite;
  reason: "missing-target-file" | "line-out-of-range" | "target-line-empty";
  detail: string;
}

// FileContentReader abstracts the source-of-truth for file content so callers
// can choose between the working tree (the default — what the developer sees)
// and the git index (what would land if the staged set were committed). The
// pre-commit runner uses an index-aware reader for auto-expanded scope so
// unstaged WIP in a citer does not leak into the validation set; see
// `inbound-cite-discovery.ts` makeIndexAwareReader.
export type FileContentReader = (absolutePath: string) => string;

const defaultReader: FileContentReader = (absolutePath) => readFileSync(absolutePath, "utf8");

function findRepoRoot(): string {
  // Termination via parent-equals-current rather than `dir !== "/"` so the walk
  // terminates on Windows drive roots too. `path.dirname("C:\\")` returns
  // `"C:\\"` (idempotent), so the POSIX-only `dir !== "/"` guard would loop
  // forever there and hang the pre-commit hook with no diagnostic. The same
  // termination check covers POSIX root because `dirname("/") === "/"`.
  let dir = process.cwd();
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

// REPO_ROOT is read lazily (not captured at module load) so tests can override
// via the env var across multiple cases without resetting the module graph.
function getRepoRoot(): string {
  return process.env.REPO_ROOT ?? findRepoRoot();
}

export function extractCites(
  citingFile: string,
  reader: FileContentReader = defaultReader,
): Cite[] {
  const content = reader(citingFile);
  const cites: Cite[] = [];
  const baseDir = dirname(citingFile);
  const linkRe = /\]\(([^)]+\.md)\)\s*:\s*([\d,\s-]+)/g;
  const codeRe = /`([\w./-]+\.(?:ts|tsx|js|mjs|md)):(\d+)`/g;
  const repoRoot = getRepoRoot();

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(line)) !== null) {
      const relTarget = m[1].trim();
      if (/^https?:/.test(relTarget) || relTarget.startsWith("#")) continue;
      const targetPath = isAbsolute(relTarget) ? relTarget : resolve(baseDir, relTarget);
      // Range citations like `:10-99` validate BOTH endpoints — only checking
      // the start lets a citation drift out of range at the tail when the
      // target file shrinks. Each endpoint becomes its own cite so a bad end
      // surfaces independently of a valid start.
      const lineList: number[] = [];
      for (const token of m[2].split(/[,\s]+/).filter(Boolean)) {
        for (const part of token.split("-")) {
          const n = Number.parseInt(part, 10);
          if (Number.isFinite(n) && n > 0) lineList.push(n);
        }
      }
      for (const targetLine of lineList) {
        cites.push({
          file: citingFile,
          line: i + 1,
          rawTarget: `${relTarget}:${targetLine}`,
          targetPath,
          targetLine,
        });
      }
    }
    while ((m = codeRe.exec(line)) !== null) {
      const targetName = m[1];
      const targetLine = Number.parseInt(m[2], 10);
      const candidate = resolve(repoRoot, targetName);
      // Path-shaped citations (containing `/`) are checked unconditionally —
      // a renamed/deleted target is the exact CAT-06 silent-failure mode this
      // hook exists to catch. Bare-name citations (e.g. `session.ts:N`) are
      // kept gated on existence because the resolver only tries
      // `<repoRoot>/<bare>`, which is wrong for nested files; flagging them
      // would generate false positives until basename-resolution is reworked.
      const isPathShaped = targetName.includes("/");
      if (isPathShaped || existsSync(candidate)) {
        cites.push({
          file: citingFile,
          line: i + 1,
          rawTarget: `${targetName}:${targetLine}`,
          targetPath: candidate,
          targetLine,
        });
      }
    }
  }
  return cites;
}

export function checkCite(
  c: Cite,
  reader: FileContentReader = defaultReader,
): CiteViolation | null {
  let content: string;
  try {
    content = reader(c.targetPath);
  } catch {
    // Single failure mode for both the default reader (ENOENT, EISDIR) and
    // the index-aware reader (`git show :path` exit 128 on untracked path) —
    // the cite target is not a readable file from this reader's perspective.
    return { cite: c, reason: "missing-target-file", detail: c.targetPath };
  }
  const lines = content.split("\n");
  if (c.targetLine > lines.length) {
    return {
      cite: c,
      reason: "line-out-of-range",
      detail: `cited :${c.targetLine}, file has ${lines.length} lines`,
    };
  }
  const targetText = lines[c.targetLine - 1];
  if (targetText.trim().length === 0) {
    return {
      cite: c,
      reason: "target-line-empty",
      detail: `:${c.targetLine} is whitespace-only`,
    };
  }
  return null;
}

export function checkCiteTargetExistence(
  files: string[],
  reader: FileContentReader = defaultReader,
): CiteViolation[] {
  const violations: CiteViolation[] = [];
  for (const f of files) {
    for (const c of extractCites(f, reader)) {
      const v = checkCite(c, reader);
      if (v) violations.push(v);
    }
  }
  return violations;
}

export function formatCiteTargetViolations(violations: CiteViolation[]): string {
  if (violations.length === 0) return "";
  const lines: string[] = [];
  for (const v of violations) {
    lines.push(
      `cite-target-existence: ${v.cite.file}:${v.cite.line} — ${v.cite.rawTarget} ${v.reason} (${v.detail})`,
    );
  }
  lines.push("");
  lines.push(
    `cite-target-existence: ${violations.length} violation(s). Update the line number, or document the move in commit message.`,
  );
  return lines.join("\n");
}
