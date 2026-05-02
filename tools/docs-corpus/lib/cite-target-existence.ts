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

import { readFileSync, statSync, existsSync } from "node:fs";
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

function findRepoRoot(): string {
  let dir = process.cwd();
  while (dir !== "/") {
    if (existsSync(resolve(dir, ".git"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const REPO_ROOT = process.env.REPO_ROOT ?? findRepoRoot();

export function extractCites(citingFile: string): Cite[] {
  const content = readFileSync(citingFile, "utf8");
  const cites: Cite[] = [];
  const baseDir = dirname(citingFile);
  const linkRe = /\]\(([^)]+\.md)\)\s*:\s*([\d,\s-]+)/g;
  const codeRe = /`([\w./-]+\.(?:ts|tsx|js|mjs|md)):(\d+)`/g;

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(line)) !== null) {
      const relTarget = m[1].trim();
      if (/^https?:/.test(relTarget) || relTarget.startsWith("#")) continue;
      const targetPath = isAbsolute(relTarget) ? relTarget : resolve(baseDir, relTarget);
      const lineList = m[2]
        .split(/[,\s]+/)
        .map((s) => s.split("-")[0])
        .filter(Boolean)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
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
      const candidate = resolve(REPO_ROOT, targetName);
      if (existsSync(candidate)) {
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

export function checkCite(c: Cite): CiteViolation | null {
  if (!existsSync(c.targetPath)) {
    return { cite: c, reason: "missing-target-file", detail: c.targetPath };
  }
  let stat;
  try {
    stat = statSync(c.targetPath);
  } catch {
    return { cite: c, reason: "missing-target-file", detail: c.targetPath };
  }
  if (!stat.isFile()) {
    return {
      cite: c,
      reason: "missing-target-file",
      detail: `${c.targetPath} (not a file)`,
    };
  }
  const content = readFileSync(c.targetPath, "utf8");
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

export function checkCiteTargetExistence(files: string[]): CiteViolation[] {
  const violations: CiteViolation[] = [];
  for (const f of files) {
    for (const c of extractCites(f)) {
      const v = checkCite(c);
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
