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
import { dirname, relative, resolve, isAbsolute, sep } from "node:path";

export interface Cite {
  file: string;
  line: number;
  rawTarget: string;
  targetPath: string;
  targetLine: number; // 0 for symbol-form and section-form cites
  symbol?: string; // present for `path#symbol` cites
  section?: string; // present for backticked `Spec-NNN §Heading` cites (label-cite pass 3)
  volatileCodeTarget?: boolean; // raw line-pin into packages/ | apps/
}

export interface CiteViolation {
  cite: Cite;
  reason:
    | "missing-target-file"
    | "line-out-of-range"
    | "target-line-empty"
    | "raw-line-cite-into-volatile-code"
    | "symbol-not-found"
    | "section-not-found";
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

// Volatile trees per AGENTS.md §Durable-Cite Rule: raw line-pins into code
// under these prefixes rot on every edit and are denied in favor of the
// `path#exportedSymbol` form.
const VOLATILE_CODE_PREFIXES = ["packages/", "apps/"];
// `.rs` targets get VOLATILE-TREE-ONLY semantics in both extractors below:
// repo Rust lives under packages/ (sidecar-rust-pty), while most `.rs` doc
// mentions cite EXTERNAL library sources (`src/windows.rs:413` in ADR-021) —
// flooring those would chase paths that never existed in this repo. So a
// volatile `.rs` line-pin is denied, a volatile `.rs#symbol` is verified, and
// a non-volatile `.rs` mention stays gate-invisible (Codex review, PR #188
// round 4).
const symbolRe = /`([\w./-]+\.(?:ts|tsx|js|mjs|mts|cts|rs))#([A-Za-z_$][\w$]*)`/g;

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
  // codeRe's tail is the same number-list grammar linkRe uses, so
  // `` `packages/x.ts:24,35` `` / `` `x.ts:10-99` `` stop being invisible.
  // Extension set: the runner's CODE_FILE_RE (ts|tsx|mts|cts) plus js|mjs|md —
  // a SUPERSET, and that is fine: CODE_FILE_RE partitions which STAGED FILES
  // get checked as citers; codeRe decides which cite TARGETS get extracted
  // from md. The two filters are orthogonal — widening extraction never
  // widens the citer lane.
  const codeRe = /`([\w./-]+\.(?:ts|tsx|js|mjs|mts|cts|rs|md)):(\d+(?:\s*[,-]\s*\d+)*)`/g;
  // Markdown-link form with a CODE-extension target — extracted solely for the
  // volatile deny (see the pass below).
  const linkCodeRe = /\]\(([^)]+\.(?:ts|tsx|js|mjs|mts|cts|rs))\)\s*:\s*([\d,\s-]+)/g;
  // BARE (unbackticked, unlinked) volatile line-pins. Anchored on the volatile
  // prefixes themselves, so plain prose paths (`tools/foo.ts:12`) and longer
  // paths whose tail merely contains `packages/` (the `/` in the lookbehind)
  // stay invisible — this pass exists ONLY to deny the raw form the other two
  // passes cannot see (Codex review, PR #188 round 4).
  const bareVolatileRe =
    /(?<![`[\w/.-])((?:packages|apps)\/[\w./-]+\.(?:ts|tsx|js|mjs|mts|cts|rs)):(\d+(?:\s*[,-]\s*\d+)*)/g;
  const repoRoot = getRepoRoot();

  const lines = content.split("\n");
  // Fence tracking feeds ONLY the bare-volatile pass below: fenced content is
  // quoted-example territory (a doc quoting a test fixture or manifest entry
  // verbatim), so the bare deny must not chase it. The backtick / link /
  // symbol passes deliberately stay fence-blind — they predate the fence
  // distinction, and narrowing them could silently uncover cites the floor
  // checks today.
  let insideFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) insideFence = !insideFence;
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
    // Path-shaped citations (containing `/`) are checked unconditionally —
    // a renamed/deleted target is the exact CAT-06 silent-failure mode this
    // hook exists to catch. Bare-name citations (e.g. `session.ts:N`) are
    // kept gated on existence because the resolver only tries
    // `<repoRoot>/<bare>`, which is wrong for nested files; flagging them
    // would generate false positives until basename-resolution is reworked.
    while ((m = codeRe.exec(line)) !== null) {
      const targetName = m[1];
      const candidate = resolve(repoRoot, targetName);
      const isPathShaped = targetName.includes("/");
      // Volatility derives from the RESOLVED repo-relative path, never the
      // raw spelling: `./packages/…`, `docs/../packages/…` and friends all
      // resolve to the same target, and prefix-testing any raw string
      // invites spelling bypasses (Codex review, PR #188 rounds 1 + 3).
      // The volatile deny covers CODE targets only — a `packages/**/*.md:NN`
      // cite is not "code under packages/" per AGENTS.md §Durable-Cite Rule,
      // so `.md` targets keep floor semantics.
      const repoRelativeTarget = relative(repoRoot, candidate).split(sep).join("/");
      const underVolatileTree = VOLATILE_CODE_PREFIXES.some((prefix) =>
        repoRelativeTarget.startsWith(prefix),
      );
      const isVolatileCode =
        isPathShaped && !repoRelativeTarget.endsWith(".md") && underVolatileTree;
      // Non-volatile `.rs` mentions cite external sources — skip (see the
      // volatile-tree-only note above symbolRe).
      if (repoRelativeTarget.endsWith(".rs") && !underVolatileTree) continue;
      if (!(isPathShaped || existsSync(candidate))) continue;
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
          rawTarget: `${targetName}:${targetLine}`,
          targetPath: candidate,
          targetLine,
          ...(isVolatileCode ? { volatileCodeTarget: true } : {}),
        });
      }
    }
    // BARE volatile line-pins (`packages/foo.ts:24,35,59` with no backticks
    // and no link) — deny-only, per endpoint, deduped by the caller. Skipped
    // inside fences (see the fence-tracking note above the loop).
    bareVolatileRe.lastIndex = 0;
    while (!insideFence && (m = bareVolatileRe.exec(line)) !== null) {
      const bareTargetName = m[1];
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
          rawTarget: `${bareTargetName}:${targetLine}`,
          targetPath: resolve(repoRoot, bareTargetName),
          targetLine,
          volatileCodeTarget: true,
        });
      }
    }
    // Markdown-LINK line-pins into code targets (`[impl](../x/bar.ts):12`).
    // linkRe above accepts only `.md` targets, so a code-target link was
    // invisible to the volatile deny — a raw line-pin bypass via link syntax
    // (Codex review, PR #188). This pass extracts code-extension link targets
    // ONLY to apply the deny: the target resolves citer-relative (like md
    // links), and its repo-relative form decides volatility. Non-volatile
    // code links stay unextracted — pre-existing scope, unchanged.
    linkCodeRe.lastIndex = 0;
    while ((m = linkCodeRe.exec(line)) !== null) {
      const relTarget = m[1].trim();
      if (/^https?:/.test(relTarget)) continue;
      const targetPath = isAbsolute(relTarget) ? relTarget : resolve(baseDir, relTarget);
      const repoRelative = relative(repoRoot, targetPath).split(sep).join("/");
      if (!VOLATILE_CODE_PREFIXES.some((prefix) => repoRelative.startsWith(prefix))) continue;
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
          volatileCodeTarget: true,
        });
      }
    }
    // Symbol-form cites (`path#exportedSymbol`). SAME bare-name gating as
    // codeRe above: a slash-free `` `session.ts#Foo` `` is not
    // repo-root-resolvable and must stay gate-invisible (the bare-name sweep
    // is a separate workstream; extracting them here would mint
    // missing-target-file failures on every such doc the moment this lands).
    while ((m = symbolRe.exec(line)) !== null) {
      const symbolTargetName = m[1];
      const symbolCandidate = resolve(repoRoot, symbolTargetName);
      if (!(symbolTargetName.includes("/") || existsSync(symbolCandidate))) continue;
      // Non-volatile `.rs` symbol mentions cite external sources — skip (see
      // the volatile-tree-only note above symbolRe).
      const symbolRepoRelative = relative(repoRoot, symbolCandidate).split(sep).join("/");
      if (
        symbolRepoRelative.endsWith(".rs") &&
        !VOLATILE_CODE_PREFIXES.some((prefix) => symbolRepoRelative.startsWith(prefix))
      )
        continue;
      cites.push({
        file: citingFile,
        line: i + 1,
        rawTarget: `${symbolTargetName}#${m[2]}`,
        targetPath: symbolCandidate,
        targetLine: 0,
        symbol: m[2],
      });
    }
  }
  return cites;
}

export function checkCite(
  c: Cite,
  reader: FileContentReader = defaultReader,
): CiteViolation | null {
  // The volatile deny fires BEFORE any read: the citation form itself is the
  // defect, regardless of whether today's target line happens to exist. The
  // detail carries the remediation inline so the failing developer gets the
  // fix recipe, not just the rule.
  if (c.volatileCodeTarget) {
    return {
      cite: c,
      reason: "raw-line-cite-into-volatile-code",
      detail:
        "cite `path#exportedSymbol` instead (AGENTS.md §Durable-Cite Rule) — raw line-pins into packages//apps/ rot on every edit; pick the export enclosing the old line (rg -n 'export' <target>)",
    };
  }
  let content: string;
  try {
    content = reader(c.targetPath);
  } catch {
    // Single failure mode for both the default reader (ENOENT, EISDIR) and
    // the index-aware reader (`git show :path` exit 128 on untracked path) —
    // the cite target is not a readable file from this reader's perspective.
    return { cite: c, reason: "missing-target-file", detail: c.targetPath };
  }
  // Symbol-form cites skip line checks: the contract is "this identifier is
  // present in the file". LOOKAROUND boundary match with the symbol
  // regex-escaped — `includes` would pass `#SessionSubscribe` against
  // `SessionSubscribeRequest`, and plain \b breaks on $-suffixed symbols
  // (`\bstore\$\b` demands a word char AFTER the $, so it never matches
  // `store$ =`; $ is legal in the symbol charset and regex-special).
  // (?<![\w$])…(?![\w$]) treats $ as part of the identifier alphabet on both
  // edges. On failure the detail lists the file's current exported symbols so
  // the fix is self-serve.
  if (c.symbol !== undefined) {
    const escaped = c.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(content)) {
      const exports = [
        ...content.matchAll(
          /^export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
        ),
      ]
        .map((e) => e[1])
        .slice(0, 20);
      return {
        cite: c,
        reason: "symbol-not-found",
        detail: `symbol \`${c.symbol}\` not found in ${c.targetPath}; exported symbols there: ${exports.join(", ") || "(none parsed)"}`,
      };
    }
    return null;
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
  // A range cite expands per endpoint, but the volatile deny is about the
  // citation FORM — one violation per citing line + target, not one per
  // endpoint.
  const deniedVolatile = new Set<string>();
  for (const f of files) {
    for (const c of extractCites(f, reader)) {
      const v = checkCite(c, reader);
      if (!v) continue;
      if (v.reason === "raw-line-cite-into-volatile-code") {
        const key = `${c.file}:${c.line}:${c.targetPath}`;
        if (deniedVolatile.has(key)) continue;
        deniedVolatile.add(key);
      }
      violations.push(v);
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
    `cite-target-existence: ${violations.length} violation(s). Update the line number, convert to a durable form (AGENTS.md §Durable-Cite Rule), or document the move in the commit message.`,
  );
  return lines.join("\n");
}
