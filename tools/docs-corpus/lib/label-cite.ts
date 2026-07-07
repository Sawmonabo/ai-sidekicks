// label-cite — verifies governance line-citations embedded in code comments
// point at a non-empty line of the governing doc. (Named for its original
// LABEL-form scope; it now also floors the DOCS-PATH form — see below.) Both
// forms route through the SAME checkCite() the markdown path uses:
//
//   1. LABEL form — `Spec-NNN:LL`, `Plan-NNN:LL`, `ADR-NNN:LL`; the token
//      resolves to its doc via the `NNN-` glob over docs/{specs,plans,decisions}.
//   2. DOCS-PATH form — a repo-root-relative governance path with a line suffix,
//      `` `docs/<subtree>/<file>.md:LL` `` (e.g. `docs/domain/session-model.md:61-77`).
//      This is the ONLY floor reachable for docs that carry no label token —
//      domain / architecture / operations docs are not `Spec/Plan/ADR-NNN`.
//   3. SECTION form — backticked `` `Spec-NNN §Heading` `` (likewise Plan/ADR);
//      the token resolves via the same NNN glob and the heading is verified
//      against the doc's current headings (exact-after-normalize) — the durable
//      anchor form per AGENTS.md §Durable-Cite Rule.
//
// This is the CODE-COMMENT analogue of cite-target-existence's `file.md:NNN`
// check. The deterministic walk only ever reached `.md` governance docs, so a
// spec amendment that shifted line numbers silently invalidated every such cite
// living in `packages/**` + `apps/**` TypeScript — the gap PR #139's ~40-cite
// hand sweep across 8 code/test files exposed. Resolving the cite to its doc and
// running checkCite() enforces the floor (truncation / rename / delete /
// out-of-range / empty-line) for code cites too.
//
// SCOPE — high-confidence, repo-root-resolvable forms ONLY, by design. The
// matcher runs in a REQUIRED gate (lefthook pre-commit + the `docs-corpus-gate`
// CI job), where a false positive breaks correct commits for every developer —
// strictly worse than the gap it closes. So it matches exactly two shapes:
//   • the unambiguous token-adjacent `Spec-NNN:LL` label shape, and
//   • the `docs/`-rooted path-colon shape, anchored on the governance-corpus
//     root — so a package-relative code-to-code ref (`internal/branded.ts:25`,
//     no `docs/` root) is never matched, which is exactly the FP that flooring
//     all backtick path-cites would have minted (it resolves wrong from repo
//     root). Three fuzzier classes stay one layer up in /ripple-check (Subagent
//     D, CAT-07) — the audit layer where liberal, LLM-driven enumeration is safe
//     and non-blocking:
//       – line-WORD forms (`Spec-003 line 178`, `§Acceptance Criteria line 81`):
//         a bare `line N` near a governance token is mis-readable (`chunks/foo.js
//         line 812` adjacent to a Spec comment must never mint `Spec-NNN:812`),
//         and cross-line token inheritance is unsafe in a blocking check.
//       – BARE-BASENAME path cites (`api-payload-contracts.md:120`, no `docs/`
//         prefix): basename → path resolution is ambiguous (`template.md` exists
//         in several subtrees), so it cannot be made zero-FP in a required gate.
//       – RELATIVE `docs/` paths (`../docs/x.md:5`) and in-package `docs/` dirs
//         (`src/docs/y.md:5`): not repo-root-resolvable, and the lookbehind
//         rejects the leading `/`, so they fall through to Layer-B's basename
//         grep (which catches them regardless of prefix). A repo-root
//         `docs/…md:LL` of ANY depth — incl. `docs/architecture/contracts/…` —
//         IS floored above and never reaches this layer.
//       – SEMANTIC line shift (below) — no static check can see it.
// This is the repo's own CAT-06 (deterministic floor) / CAT-07 (audit-only
// residual) split; see docs/operations/failure-mode-catalog.md.
//
// Like cite-target-existence, this catches the FLOOR only — NOT semantic line
// shift. `Spec-003:73 → :77` after a +4-line insertion still resolves to a
// non-empty line 77, so the floor passes; that shift is the CAT-07 residual,
// audit-only by design (no static check can see it without reading content).

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  checkCite,
  type Cite,
  type CiteViolation,
  type FileContentReader,
} from "./cite-target-existence.ts";
import { getRepoRoot } from "./inbound-cite-discovery.ts";

// Label token → governance tree. The number is NOT shared across token types
// (`Spec-024` ≠ `Plan-024`); each resolves within its own tree. ADRs live under
// `docs/decisions/`, NOT `docs/adr/` (CLAUDE.md Documentation Corpus).
const TOKEN_DIRS: Record<string, string> = {
  Spec: "docs/specs",
  Plan: "docs/plans",
  ADR: "docs/decisions",
};

const defaultReader: FileContentReader = (absolutePath) => readFileSync(absolutePath, "utf8");

// Token-adjacent colon form ONLY. `\b` before the token rejects a longer word
// ending in the token name (`MySpec-003:5` does not match). `(\d{3})` pins the
// 3-digit doc number; the colon must immediately follow (no space) so a
// named-section reference like `Spec-003 §Foo` never matches (the backticked
// §-form is matched by pass 3's SECTION_CITE_RE and verified against headings,
// not lines). The number-list tail accepts ranges and comma lists (`:381-382`,
// `:81,107`) but NOT a bare trailing space-separated integer (`:5 7`), so prose
// after the cite cannot be swallowed into a spurious second line number.
const LABEL_CITE_RE = /\b(Spec|Plan|ADR)-(\d{3}):(\d+(?:\s*[,-]\s*\d+)*)/g;

// Backticked-only §Heading form — backticks are the zero-FP boundary for the
// heading text in a REQUIRED gate (unbounded heading matches over comment prose
// would over-match; unbackticked forms stay audit-layer via /ripple-check).
const SECTION_CITE_RE = /`(Spec|Plan|ADR)-(\d{3}) §([^`]+)`/g;

// Ported from preflight.mjs findSectionHeading/normalizeTokenForMatch — port,
// don't reinvent: exact-after-normalize so `§Token` cannot prefix-match
// "Token Security Properties".
function normalizeTokenForMatch(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function verifySectionHeading(docContent: string, sectionName: string): boolean {
  const target = normalizeTokenForMatch(sectionName);
  for (const line of docContent.split("\n")) {
    if (/^#+\s+/.test(line)) {
      if (normalizeTokenForMatch(line.replace(/^#+\s+/, "")) === target) return true;
    }
  }
  return false;
}

// Docs-path form: a repo-root-relative governance path with a line suffix,
// `docs/<subtree…>/<file>.md:LL` — ANY depth under the repo-root `docs/`
// (`docs/domain/session-model.md:61-77`, and the two-segment
// `docs/architecture/contracts/error-contracts.md:266`). The negative lookbehind
// `(?<![\w/.-])` pins `docs/` to the repo-ROOT: a backtick / space / `(` before
// it matches, but a nested `node_modules/x/docs/y.md:3`, a relative
// `../docs/x.md:5`, and an in-package `src/docs/y.md:5` (all preceded by `/`)
// do NOT, and a package-relative ref with no `docs/` root is never reached.
// `(?:[a-z][a-z-]*\/)*` accepts zero-or-more lowercase path segments, so every
// repo-root `docs/…md:LL` resolves — single-subtree, multi-subtree
// (`architecture/contracts`), or a top-level `docs/<file>.md`. All resolve
// cleanly from repo root, so the match stays zero-FP regardless of depth.
// Capture 1 is the path; capture 2 is the same number-list tail as the label
// form. The filename allows the `NNN-kebab` and `dotted.name` shapes the corpus
// uses.
const DOCS_PATH_CITE_RE =
  /(?<![\w/.-])(docs\/(?:[a-z][a-z-]*\/)*[A-Za-z0-9._-]+\.md):(\d+(?:\s*[,-]\s*\d+)*)/g;

// Memoize the directory listing per absolute governance tree so a file with N
// label cites does at most one readdir per tree (3 trees total) instead of one
// per cite. Keyed on the absolute dir, so a REPO_ROOT override in tests gets
// its own entry. Safe because the corpus is static for the lifetime of a single
// pre-commit / CI run (the only contexts this runs in).
const dirEntryCache = new Map<string, string[]>();

function listGovernanceDir(absoluteDir: string): string[] {
  const cached = dirEntryCache.get(absoluteDir);
  if (cached !== undefined) return cached;
  let entries: string[];
  try {
    entries = readdirSync(absoluteDir);
  } catch {
    // Tree absent (unusual checkout, or a token type whose dir was moved):
    // treat as "no doc matches" — resolveLabelTarget returns the sentinel and
    // checkCite reports missing-target-file.
    entries = [];
  }
  dirEntryCache.set(absoluteDir, entries);
  return entries;
}

// Resolve `Spec-003` → absolute path of `docs/specs/003-*.md`. Returns the
// matching file's absolute path, or — when no doc matches (a cite to a
// nonexistent / deleted / renamed-away governance doc, itself a real defect) —
// an absolute SENTINEL path (`docs/specs/003-*.md`, literal `*`) that no reader
// can open, so checkCite reports `missing-target-file`. One uniform code path:
// resolution failure and content failure both flow through checkCite.
function resolveLabelTarget(repoRoot: string, type: string, num: string): string {
  const absoluteDir = resolve(repoRoot, TOKEN_DIRS[type]);
  const prefix = `${num}-`;
  for (const entry of listGovernanceDir(absoluteDir)) {
    if (entry.startsWith(prefix) && entry.endsWith(".md")) {
      return resolve(absoluteDir, entry);
    }
  }
  return resolve(absoluteDir, `${num}-*.md`);
}

// Expand a number-list spec (`383`, `61-77`, `81,107-113`) into individual line
// numbers. Range / list cites validate EVERY endpoint — mirrors
// cite-target-existence's markdown-link range handling so a tail that drifts out
// of range surfaces independently of a valid start.
function expandLineSpec(spec: string): number[] {
  const lineList: number[] = [];
  for (const token of spec.split(/[,\s]+/).filter(Boolean)) {
    for (const part of token.split("-")) {
      const n = Number.parseInt(part, 10);
      if (Number.isFinite(n) && n > 0) lineList.push(n);
    }
  }
  return lineList;
}

// Push one Cite per target line for a single matched citation. `rawPrefix` is
// the human-readable cite stem (`Spec-003:` or `docs/domain/x.md:`); `targetPath`
// is the already-resolved absolute doc path both forms feed to checkCite.
function pushExpandedCites(
  cites: Cite[],
  citingFile: string,
  lineIndex: number,
  rawPrefix: string,
  targetPath: string,
  numberSpec: string,
): void {
  for (const targetLine of expandLineSpec(numberSpec)) {
    cites.push({
      file: citingFile,
      line: lineIndex + 1,
      rawTarget: `${rawPrefix}${targetLine}`,
      targetPath,
      targetLine,
    });
  }
}

function extractLabelCitesFrom(
  citingFile: string,
  repoRoot: string,
  reader: FileContentReader,
): Cite[] {
  // Resolve to absolute before reading: the index-aware reader keys its
  // staged-set membership test on absolute paths, so a relative citer path
  // would miss the set and read the git index instead of the developer's
  // working tree — making a same-commit cite fix invisible to the gate. The
  // displayed `file` below keeps the original (relative) path for a clean,
  // clickable message. `resolve()` is idempotent for already-absolute inputs
  // (the test harness passes absolute temp paths), so this is a no-op there.
  const content = reader(resolve(citingFile));
  const cites: Cite[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;

    // Pass 1 — label form (`Spec-003:178`). Token resolves via the NNN glob.
    LABEL_CITE_RE.lastIndex = 0;
    while ((m = LABEL_CITE_RE.exec(line)) !== null) {
      const type = m[1];
      const num = m[2];
      pushExpandedCites(
        cites,
        citingFile,
        i,
        `${type}-${num}:`,
        resolveLabelTarget(repoRoot, type, num),
        m[3],
      );
    }

    // Pass 2 — docs-path form (`docs/domain/session-model.md:61-77`). The path
    // is already repo-root-relative, so it resolves directly; a `docs/` path
    // that does not exist flows through checkCite as `missing-target-file`,
    // exactly the rename / delete signal the floor exists to catch.
    DOCS_PATH_CITE_RE.lastIndex = 0;
    while ((m = DOCS_PATH_CITE_RE.exec(line)) !== null) {
      const docsPath = m[1];
      pushExpandedCites(cites, citingFile, i, `${docsPath}:`, resolve(repoRoot, docsPath), m[2]);
    }

    // Pass 3 — backticked section-anchor form (`` `Spec-003 §Wire Format` ``).
    // Heading existence is verified in checkLabelCiteTargets, not checkCite —
    // there is no line number to floor.
    SECTION_CITE_RE.lastIndex = 0;
    while ((m = SECTION_CITE_RE.exec(line)) !== null) {
      cites.push({
        file: citingFile,
        line: i + 1,
        rawTarget: `${m[1]}-${m[2]} §${m[3]}`,
        targetPath: resolveLabelTarget(repoRoot, m[1], m[2]),
        targetLine: 0,
        section: m[3],
      });
    }
  }
  return cites;
}

// Exported for direct testing of the extractor (mirrors cite-target-existence's
// exported extractCites). Resolves repo root per call via the REPO_ROOT-aware
// getRepoRoot, so tests drive it through the same withRepoRoot harness.
export function extractLabelCites(
  citingFile: string,
  reader: FileContentReader = defaultReader,
): Cite[] {
  return extractLabelCitesFrom(citingFile, getRepoRoot(), reader);
}

export function checkLabelCiteTargets(
  files: string[],
  reader: FileContentReader = defaultReader,
): CiteViolation[] {
  const repoRoot = getRepoRoot();
  const violations: CiteViolation[] = [];
  for (const f of files) {
    for (const c of extractLabelCitesFrom(f, repoRoot, reader)) {
      if (c.section !== undefined) {
        let content: string;
        try {
          content = reader(c.targetPath);
        } catch {
          violations.push({ cite: c, reason: "missing-target-file", detail: c.targetPath });
          continue;
        }
        if (!verifySectionHeading(content, c.section)) {
          // Self-heal detail: a §-cite usually breaks because the heading was
          // RENAMED — list the doc's current headings (prefix-matched first,
          // else the first few) so the citer's fix is self-serve.
          const headings = content
            .split("\n")
            .filter((l) => /^#+\s+/.test(l))
            .map((l) => l.replace(/^#+\s+/, "").trim());
          const target = normalizeTokenForMatch(c.section);
          const near = headings.filter((h) => {
            const n = normalizeTokenForMatch(h);
            return n.startsWith(target.slice(0, 6)) || target.startsWith(n.slice(0, 6));
          });
          const suggestions = (near.length > 0 ? near : headings).slice(0, 5);
          violations.push({
            cite: c,
            reason: "section-not-found",
            detail: `heading '§${c.section}' not found in ${c.targetPath}; nearest headings: ${suggestions.join(" | ") || "(none)"}`,
          });
        }
        continue;
      }
      const v = checkCite(c, reader);
      if (v) violations.push(v);
    }
  }
  return violations;
}

export function formatLabelCiteViolations(violations: CiteViolation[]): string {
  if (violations.length === 0) return "";
  const lines: string[] = [];
  for (const v of violations) {
    lines.push(
      `label-cite: ${v.cite.file}:${v.cite.line} — ${v.cite.rawTarget} ${v.reason} (${v.detail})`,
    );
  }
  lines.push("");
  lines.push(
    `label-cite: ${violations.length} violation(s). A governance line-cite in code points at a missing, empty, or out-of-range line. Update the line number, or document the move in the commit message.`,
  );
  return lines.join("\n");
}
