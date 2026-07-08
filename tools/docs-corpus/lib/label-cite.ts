// label-cite — enforces the Durable-Cite Rule for governance citations in code
// comments (AGENTS.md §Durable-Cite Rule). Post-sweep (2026-07, PR-4 of the
// plan-execution refinement campaign) the regime is deny+verify, not a floor:
//
//   1. LABEL form — `Spec-NNN:LL`, `Plan-NNN:LL`, `ADR-NNN:LL` — DENIED. The
//      2026-07 sweep converted all 259 pre-existing occurrences to the section
//      form, so every raw match is NEW; the violation names the durable form.
//   2. DOCS-PATH form — `` `docs/<subtree>/<file>.md:LL` `` — DENIED, same
//      ratchet (this was the only line-pin shape reachable for label-less
//      domain / architecture / operations docs).
//   3. SECTION form — backticked `` `Spec-NNN §Heading` `` (likewise Plan/ADR);
//      the token resolves via the `NNN-` glob over docs/{specs,plans,decisions}
//      and the heading is VERIFIED against the doc's current headings
//      (exact-after-normalize) — the durable anchor form. Markdown citers get
//      the same verification via checkSectionCites.
//   4. PATH-SECTION form — backticked `` `docs/<path>.md §Heading` `` — the
//      durable anchor for label-LESS governance docs (domain / architecture /
//      operations), which have no Spec/Plan/ADR token to hang a §-cite on.
//      Same heading verification as form 3 (Codex review, PR #189: without
//      this, the path+§ replacements the deny recommends would be
//      gate-invisible and rot silently on a heading rename).
//
// Why deny instead of floor: a line-cite floor (non-empty, in-range) passes
// vacuously on semantic drift — `Spec-003:73 → :77` after a +4-line insertion
// still resolves to a non-empty line — so every governance amendment silently
// rotted the code-comment cites (the gap PR #139's ~40-cite hand sweep across
// 8 code/test files exposed). §Heading anchors survive line shifts and fail
// LOUDLY (section-not-found) when the heading itself changes.
//
// SCOPE — high-confidence, repo-root-resolvable forms ONLY, by design. The
// matcher runs in a REQUIRED gate (lefthook pre-commit + the `docs-corpus-gate`
// CI job), where a false positive breaks correct commits for every developer —
// strictly worse than the gap it closes. So it matches exactly the two raw
// shapes above (token-adjacent label; `docs/`-rooted path-colon — a
// package-relative code-to-code ref like `internal/branded.ts:25` has no
// `docs/` root and is never matched). The fuzzier classes stay one layer up in
// the RESCOPED audit layer (/ripple-check; failure-mode-catalog.md CAT-06/07,
// 2026-07 definitions): heading renames vs `§Heading` cites route to Subagent
// B, export renames vs `#symbol` cites to Subagent A, and the remaining
// line-cite residual — docs→docs `:NNN` in `.md` citers plus the bare-basename
// `.md:NN` wire-doc annotations in code (ambiguous to resolve statically, so
// never gate-floored) — to Subagent D. Semantic drift UNDER an intact anchor
// (a section rewritten without renaming its heading) is likewise audit-only:
// no static check can see it without reading content.

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

// Frozen content — raw `:NNN` cites into these trees stay legal (AGENTS.md
// §Durable-Cite Rule: archive / reference material never shifts after
// landing), so the code-citer deny must not fire on them.
const FROZEN_DOC_PREFIXES = ["docs/archive/", "docs/reference/"];

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

// Backticked path-form §Heading cite — the durable anchor for label-LESS
// governance docs. Path shape mirrors DOCS_PATH_CITE_RE (repo-root `docs/`,
// any depth); the backtick boundary and `[^`]+` heading span mirror
// SECTION_CITE_RE. A heading whose in-doc spelling carries inline code ticks
// (`### \`idempotency_class\``) is cited WITHOUT the inner ticks — an inner
// backtick would terminate the anchor span — and still matches because
// normalizeTokenForMatch strips them from both sides.
const PATH_SECTION_CITE_RE = /`(docs\/(?:[a-z][a-z-]*\/)*[A-Za-z0-9._-]+\.md) §([^`]+)`/g;

// Ported from preflight.mjs findSectionHeading/normalizeTokenForMatch — port,
// don't reinvent: exact-after-normalize so `§Token` cannot prefix-match
// "Token Security Properties".
function normalizeTokenForMatch(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Real document headings only: a `## Heading` line inside a ```/~~~ fence is
// example content, not a section — counting it would keep a §-cite "verified"
// after the real section was renamed away (Codex review, PR #188 round 4).
function listDocHeadings(docContent: string): string[] {
  const headings: string[] = [];
  let insideFence = false;
  for (const line of docContent.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (!insideFence && /^#+\s+/.test(line)) {
      headings.push(line.replace(/^#+\s+/, "").trim());
    }
  }
  return headings;
}

export function verifySectionHeading(docContent: string, sectionName: string): boolean {
  const target = normalizeTokenForMatch(sectionName);
  return listDocHeadings(docContent).some((heading) => normalizeTokenForMatch(heading) === target);
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

// Passes 5-6 (CODE citers only) — the CAT-07 ratchet closing the line-word and
// bare-basename residual (2026-07 sweep, PR-E of the hardening follow-ups):
// with the swept code trees at zero occurrences, every new match is a fresh
// gate-invisible line anchor and is denied outright with the durable-form
// remediation. Markdown citers are exempt — the docs corpus keeps its own
// conventions and the /ripple-check audit lane owns CAT-07 there.
//
// Pass 5 — label line-word: `Spec-021 line 128`, `Plan-022 lines 81, 107-113`,
// `ADR-014 (line 60)`, and the §-section+line hybrid `Spec-027 §Bind-Address
// line 94`. The lazy `[^\n`]{0,60}?` bridge only matches when a `line <N>`
// tail actually follows, so durable backticked §-forms never fire on their
// own; the optional closing backtick before the tail means a locator appended
// AFTER a durable cite (`` `Spec-021 §Bind Address` line 2 ``) is still
// denied — the pin rots identically whichever spelling carries it (Codex,
// PR #195). `\blines?\b` keeps prose like "outlines 3 tiers" out; the
// `[-\s]+` separator also catches the adjectival hyphen spelling
// (`Spec-003 line-48 payload`), the optional `[,;:]` accepts punctuation
// between label and locator (`Spec-003, line 5`), the {0,200} bridge spans
// real long headings (`Plan-003 §T5.3 — Mixed-version status indicator
// (below-floor read-only surfacing) line 600`), and the trailing group
// consumes the full range / comma list so rawTarget shows the whole anchor.
const LABEL_LINE_WORD_RE =
  /\b(Spec|Plan|ADR)-(\d{3})(?:\s+§[^\n`]{0,200}?)?`?\s*[,;:]?\s*\(?\s*\blines?[-\s]+\d+(?:\s*[,-]\s*\d+)*/g;

// Pass 6 — `.md` path/basename with a line anchor: bare `session-model.md:61`
// / `api-payload-contracts.md line 120`, and the line-word tail on ANY path
// shape (`docs/domain/session-model.md line 61`) — the colon form on a
// docs/-rooted path is pass 2's (deny via raw-line-cite), so pass 6 skips that
// overlap. The optional closing backtick mirrors pass 5: a line-word tail
// after a durable path cite (`` `docs/….md §Heading` line 61 ``) is still a
// pin and still denied. The lookbehind keeps mid-path fragments from
// matching twice. The `[-\s]+` separator, `[,;:]` punctuation, {0,200}
// bridge, and trailing range/list group mirror pass 5 (hyphen spellings;
// comma variants; long headings; full-anchor rawTarget).
const MD_LINE_ANCHOR_RE =
  /(?<![\w/.-])([A-Za-z0-9._/-]+\.md)(:\d+|(?:\s+§[^\n`]{0,200}?)?`?\s*[,;:]?\s*\(?\s*\blines?[-\s]+\d+(?:\s*[,-]\s*\d+)*)/g;

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

// Lexical comment extractor for one line of a CODE citer. Returns the line's
// comment text (concatenated `//` tail + `/* … */` regions + whole line when
// inside a carried block comment or on an SQL `--` comment line), or null
// when the line has no comment region. String literals suppress comment
// openers (`"foo// Spec-003 line 5"` is data, not a comment); string state is
// line-local by design — see the pass 5-6 call site for the trade-off.
function extractCommentText(
  line: string,
  insideBlockComment: boolean,
): { text: string | null; insideBlockAfter: boolean } {
  if (line.trimStart().startsWith("--")) {
    // SQL comment line (migration template interiors) — whole line scans.
    return { text: line, insideBlockAfter: insideBlockComment };
  }
  let collected = "";
  let sawComment = false;
  let inBlock = insideBlockComment;
  let quote: string | null = null;
  let i = 0;
  while (i < line.length) {
    if (inBlock) {
      sawComment = true;
      const end = line.indexOf("*/", i);
      if (end === -1) {
        collected += line.slice(i);
        i = line.length;
      } else {
        collected += line.slice(i, end);
        inBlock = false;
        i = end + 2;
      }
      continue;
    }
    const ch = line[i];
    if (quote !== null) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") {
      collected += line.slice(i + 2);
      sawComment = true;
      i = line.length;
      continue;
    }
    if (ch === "/" && line[i + 1] === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  return { text: sawComment ? collected : null, insideBlockAfter: inBlock };
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
  // Markdown citers skip fenced blocks entirely — a fenced `Spec-NNN §…`
  // snippet is an illustrative example, not an authoritative cite (Codex
  // review, PR #188 round 5). Code citers never fence-toggle: a ``` inside a
  // template literal would flip bogus fence state and uncover real label
  // cites.
  const trackFences = citingFile.endsWith(".md");
  // Cross-line `/* … */` state for the code-citer comment lexer (passes 5-6).
  let insideBlockComment = false;
  let insideFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (trackFences && /^\s*(?:```|~~~)/.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
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

    // Pass 4 — backticked path-section form (`` `docs/domain/x.md §Heading` ``).
    // The label-less analogue of pass 3: the path resolves directly from repo
    // root; a deleted / renamed-away doc surfaces as missing-target-file, a
    // renamed heading as section-not-found.
    PATH_SECTION_CITE_RE.lastIndex = 0;
    while ((m = PATH_SECTION_CITE_RE.exec(line)) !== null) {
      cites.push({
        file: citingFile,
        line: i + 1,
        rawTarget: `${m[1]} §${m[2]}`,
        targetPath: resolve(repoRoot, m[1]),
        targetLine: 0,
        section: m[2],
      });
    }

    // Passes 5-6 — line-word / bare-basename deny, CODE citers only, and only
    // within COMMENT text. Cites live in comments; scanning whole code lines
    // turned fixture / diagnostic strings (`expect(format("README.md:12"))`)
    // into required-gate rejections (Codex, PR #195). Comment text is
    // extracted lexically per line — `//` and `/*` openers are ignored inside
    // quoted strings, and `/* … */` block state carries across lines so
    // unstarred interior lines still scan (Codex, PR #195 round 3). Two
    // documented bounds: string state is line-local, so the interior lines of
    // a multi-line template literal scan as code — deliberate, because
    // migration SQL templates carry `--`-prefixed comment lines the ratchet
    // must keep covering (those are also matched explicitly); and cites in
    // single-line non-comment strings stay audit-layer.
    if (!trackFences) {
      const scanText = extractCommentText(line, insideBlockComment);
      insideBlockComment = scanText.insideBlockAfter;
      if (scanText.text === null) continue;
      LABEL_LINE_WORD_RE.lastIndex = 0;
      while ((m = LABEL_LINE_WORD_RE.exec(scanText.text)) !== null) {
        cites.push({
          file: citingFile,
          line: i + 1,
          rawTarget: m[0].trim(),
          targetPath: resolveLabelTarget(repoRoot, m[1], m[2]),
          targetLine: 0,
          lineWordDeny: true,
        });
      }
      MD_LINE_ANCHOR_RE.lastIndex = 0;
      while ((m = MD_LINE_ANCHOR_RE.exec(scanText.text)) !== null) {
        const mdPath = m[1];
        // Colon-form means `:NNN` directly — `.md: line 5` (colon + line-word,
        // reachable via the [,;:] separator) is a line-word spelling and must
        // stay in pass 6, not be misrouted to pass 2 and vanish.
        const colonForm = /^:\d/.test(m[2]);
        // Scope: bare basenames and repo-root docs/ paths only. Path-y
        // non-corpus refs (node_modules/x/docs/y.md:3, src/docs/y.md:5) stay
        // audit-layer — this is a required gate and those are the FP guards
        // the pass-2 lookbehind already promised (kept green by this test
        // suite's exclusion block).
        if (mdPath.includes("/") && !mdPath.startsWith("docs/")) continue;
        // Docs-rooted colon forms are pass 2's match (raw-line-cite deny /
        // frozen carve-out); firing here too would double-report the line.
        if (colonForm && mdPath.startsWith("docs/")) continue;
        // Frozen trees keep their line anchors legal (parity with the raw
        // colon carve-out): the content never shifts, so the pin cannot rot.
        // Legal ≠ unchecked — route the cite through the pre-ratchet FLOOR
        // (no lineWordDeny; first endpoint as the target line) so a deleted
        // frozen doc or out-of-range pin still fails loudly, exactly like the
        // colon form does in checkLabelCiteTargets' frozen branch (Codex,
        // PR #195 — pass 6 previously dropped these matches entirely).
        if (FROZEN_DOC_PREFIXES.some((prefix) => mdPath.startsWith(prefix))) {
          // Anchor numbers are the digits AFTER the line-word — a §-segment
          // number (`§RFC 9110 line 20`) is part of the heading, not a pin —
          // and every range / list endpoint floors, matching the colon form's
          // per-endpoint expansion (Codex, PR #195 round 2).
          const lineWordTail = m[2].slice(m[2].search(/\blines?\b/));
          for (const endpointMatch of lineWordTail.matchAll(/\d+/g)) {
            cites.push({
              file: citingFile,
              line: i + 1,
              rawTarget: m[0].trim(),
              targetPath: resolve(repoRoot, mdPath),
              targetLine: Number(endpointMatch[0]),
            });
          }
          continue;
        }
        cites.push({
          file: citingFile,
          line: i + 1,
          rawTarget: m[0].trim(),
          targetPath: mdPath.startsWith("docs/") ? resolve(repoRoot, mdPath) : "",
          targetLine: 0,
          lineWordDeny: true,
        });
      }
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

// Verify one section-form cite (c.section is set). Returns null when the
// heading exists in the resolved doc.
function sectionViolation(c: Cite, reader: FileContentReader): CiteViolation | null {
  let content: string;
  try {
    content = reader(c.targetPath);
  } catch {
    return { cite: c, reason: "missing-target-file", detail: c.targetPath };
  }
  const section = c.section as string;
  if (verifySectionHeading(content, section)) return null;
  // Self-heal detail: a §-cite usually breaks because the heading was
  // RENAMED — list the doc's current headings (prefix-matched first,
  // else the first few) so the citer's fix is self-serve.
  const headings = listDocHeadings(content);
  const target = normalizeTokenForMatch(section);
  const near = headings.filter((h) => {
    const n = normalizeTokenForMatch(h);
    return n.startsWith(target.slice(0, 6)) || target.startsWith(n.slice(0, 6));
  });
  const suggestions = (near.length > 0 ? near : headings).slice(0, 5);
  return {
    cite: c,
    reason: "section-not-found",
    detail: `heading '§${section}' not found in ${c.targetPath}; nearest headings: ${suggestions.join(" | ") || "(none)"}`,
  };
}

export function checkLabelCiteTargets(
  files: string[],
  reader: FileContentReader = defaultReader,
): CiteViolation[] {
  const repoRoot = getRepoRoot();
  const violations: CiteViolation[] = [];
  const deniedRawCites = new Set<string>();
  for (const f of files) {
    for (const c of extractLabelCitesFrom(f, repoRoot, reader)) {
      if (c.lineWordDeny) {
        const deniedKey = `${c.file}:${c.line}:${c.rawTarget}`;
        if (!deniedRawCites.has(deniedKey)) {
          deniedRawCites.add(deniedKey);
          // A rawTarget that already carries a §-anchor (the durable-cite-
          // plus-appended-locator class) needs only the locator dropped —
          // rebuilding a `§Heading` suffix around the existing anchor would
          // prescribe invalid nesting (Codex, PR #195 round 2).
          const alreadySectioned = c.rawTarget.includes("§");
          const docsPathForm = c.rawTarget.startsWith("docs/");
          const remediation = alreadySectioned
            ? "the §-anchor is already durable — drop the appended line locator"
            : `use the durable section form ${
                docsPathForm
                  ? `\`${c.rawTarget.replace(/(?::\d+|`?\s*\(?\s*lines?[-\s]+.*)$/, "")} §Heading\``
                  : "`Spec-NNN §Heading` (or `docs/<tree>/<file>.md §Heading` for label-less docs)"
              }`;
          violations.push({
            cite: c,
            reason: "line-anchored-cite-in-code",
            detail: `line-word / bare-basename cite '${c.rawTarget}' is gate-invisible and rots silently; ${remediation} (CAT-07 ratchet, 2026-07 sweep)`,
          });
        }
        continue;
      }
      if (c.section !== undefined) {
        const sectionV = sectionViolation(c, reader);
        if (sectionV) violations.push(sectionV);
        continue;
      }
      // Post-sweep ratchet (2026-07-06): zero raw line-cites remain in code, so
      // every raw match is NEW — deny with the durable-form remediation.
      // extractLabelCitesFrom expands range/list cites into one Cite per line
      // number; dedupe on citing line + resolved doc so `Spec-016:81-83` yields
      // ONE violation, not three.
      // Frozen trees keep raw `:NNN` legality (AGENTS.md §Durable-Cite Rule):
      // archive / reference content never shifts after landing, so a line pin
      // there cannot rot — and those docs carry no live headings to anchor.
      // Legality is not blind trust: the pre-ratchet FLOOR still validates the
      // pin (missing file / out-of-range / blank line), so a typo like
      // `docs/reference/foo.md:999` fails loudly instead of vanishing from
      // every check (Codex review, PR #189 round 3). Label tokens never
      // resolve into these trees (TOKEN_DIRS), so the prefix test on the raw
      // docs-path form covers every reachable case.
      if (FROZEN_DOC_PREFIXES.some((prefix) => c.rawTarget.startsWith(prefix))) {
        const floorViolation = checkCite(c, reader);
        if (floorViolation) violations.push(floorViolation);
        continue;
      }
      const deniedKey = `${c.file}:${c.line}:${c.targetPath}`;
      if (!deniedRawCites.has(deniedKey)) {
        deniedRawCites.add(deniedKey);
        // Name the durable form that EXISTS for the target: a docs-path raw
        // cite points at a label-less doc, so recommending `Spec-NNN §Heading`
        // would prescribe a token the target does not have (Codex, PR #189).
        const docsPathForm = c.rawTarget.startsWith("docs/");
        const durableForm = docsPathForm
          ? `\`${c.rawTarget.replace(/:\d+$/, "")} §Heading\``
          : "`Spec-NNN §Heading`";
        violations.push({
          cite: c,
          reason: "raw-line-cite-into-governance-doc",
          detail: `cite the backticked ${durableForm} form instead (AGENTS.md §Durable-Cite Rule) — governance line numbers shift on every amendment`,
        });
      }
    }
  }
  return violations;
}

// Section-anchor verification for MARKDOWN citers. Docs legally carry raw
// label-form line cites in prose (their floor is cite-target-existence's
// beat), so the md lane must NOT route through checkLabelCiteTargets — this
// narrower walk extracts ONLY the backticked `Spec-NNN §Heading` form and
// verifies the heading, closing the docs-to-docs gap the Durable-Cite Rule
// promises (Codex review, PR #188).
export function checkSectionCites(
  files: string[],
  reader: FileContentReader = defaultReader,
): CiteViolation[] {
  const repoRoot = getRepoRoot();
  const violations: CiteViolation[] = [];
  for (const f of files) {
    for (const c of extractLabelCitesFrom(f, repoRoot, reader)) {
      if (c.section === undefined) continue;
      const v = sectionViolation(c, reader);
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
    `label-cite: ${violations.length} violation(s). Raw governance line-cites in code are denied — cite the backticked \`Spec-NNN §Heading\` anchor form (label-less docs: \`docs/<path>.md §Heading\`) instead, and verify §-anchors name a real heading (AGENTS.md §Durable-Cite Rule).`,
  );
  return lines.join("\n");
}
