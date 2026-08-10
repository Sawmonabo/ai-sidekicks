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
// line-cite residual to Subagent D. Post the 2026-07-16 corpus-wide sweep that
// residual SHRANK: docs→docs volatile line cites are now DENIED in md citers
// too (checkMarkdownVolatileCites — every spelling incl. wrap-split pairs),
// leaving Subagent D the plan Tasks-block grammar (Gate-4-owned), the waivered
// illustrative examples, the superpowers provenance logs, and package-relative
// non-docs paths in code. Semantic drift UNDER an intact anchor (a section
// rewritten without renaming its heading) is likewise audit-only: no static
// check can see it without reading content.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import {
  checkCite,
  CITE_SHAPE_EXAMPLE_MARKER,
  type Cite,
  type CiteViolation,
  type FileContentReader,
  MD_DENY_EXEMPT_CITER_PREFIXES,
} from "./cite-target-existence.ts";
import {
  advanceScanState,
  INITIAL_SCAN_STATE,
  type MarkdownScanState,
  stripBlockquotePrefix,
} from "./markdown-fences.ts";
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

// ---- Markdown-lane volatile-cite deny (2026-07 corpus-wide sweep) ----------
//
// Post-sweep the docs corpus carries ZERO volatile doc→doc line cites outside
// the named exemptions, so every new match in an md citer is a fresh line pin
// that rots on the target's next amendment — denied with the durable-form
// remediation, exactly like the code lane (checkMarkdownVolatileCites below).

// The per-line `<!-- cite-shape-example -->` waiver and the exempt citer
// trees (docs/superpowers/ campaign logs — dated design-time records whose
// positional cites are provenance, not live claims — plus the .claude/
// harness tree of rule text dense with illustrative cite shapes) are shared
// with cite-target-existence's malformed-symbol-anchor deny: both constants
// live there (the upstream module) so the two gates can never drift onto
// different spellings or exempt sets. See CITE_SHAPE_EXAMPLE_MARKER and
// MD_DENY_EXEMPT_CITER_PREFIXES in the import above.

// Plan Tasks-block cite grammar stays legal (AGENTS.md §Durable-Cite Rule,
// namespace carve-out (1)): plan-execution preflight Gate 4 parses and
// SEMANTICALLY VERIFIES `**Spec coverage:**` / `**Verifies invariant:**`
// payload line hints (`AC-X (line NN)`). Line-level rule: in a docs/plans/
// citer, ONLY a line carrying either payload marker is exempt — including a
// table row that embeds the marker in a cell (task/coverage matrices). A plan
// table row WITHOUT the marker is ordinary prose to this gate: invariant,
// dependency, decision-log, and progress tables sit outside Gate 4's parse
// surface and must cite durably (Codex, PR #207 — the bare table-row
// disjunct over-exempted every plan table). Payloads are one physical line
// in corpus practice; a wrapped payload would surface as a deny and belongs
// on one line.
const PLAN_GRAMMAR_MARKER_RE = /\*\*(Spec coverage|Verifies invariant):\*\*/;

// Markdown-link form with a trailing line list — `[x](../plans/001-y.md):12`
// plus every valid CommonMark destination spelling of the same pin: the
// fragment (`…y.md#anchor):12`), the angle-bracketed destination
// (`(<../plans/001-y.md>):12`), and the titled destination in all three
// CommonMark title delimiters (`(../plans/001-y.md "title"):12`, `'title'`,
// `(title)`) — a fragment / bracket / title does not durable-ize an appended
// line locator, and the narrow bare-destination grammar let those spellings
// bypass the deny (Codex, PR #207 rounds 1-2; the paren-title delimiter
// closed proactively in round 3 — CommonMark admits it alongside the quote
// forms). The locator digits must sit FLUSH against the colon, the same
// value-vs-locator boundary as the label and docs-path forms
// (`[Limit](x.md): 25 participants` quotes a value and never fires). Target
// resolves relative to the citing file's directory; fragment and title are
// non-capturing and never affect resolution.
const LINK_COLON_CITE_RE =
  /\]\(\s*<?([^)#>"'\s]+\.md)(?:#[^)>"'\s]*)?>?(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)\s*:(\d+(?:\s*[,-]\s*\d+)*)/g;

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

// Legacy label spellings LABEL_CITE_RE's flush colon misses (Codex, PR #207;
// widened in the same PR after the corpus census surfaced the § variants):
//   - spaced colon           `Spec-022 :146`, `Spec-022 §Daemon Master Key :146`
//   - §-bridged tight colon  `Spec-015 §Resolved Questions:355`
//   - §-bridged paren colon  `Spec-008 §Relay Negotiation (:176-183, …)`
//   - paren colon, no §      `Spec-022 (:146`
// Branch A requires the §-bridge and then admits any colon spelling (tight,
// spaced, or parenthesized); branch B has no bridge and requires whitespace
// before the (optionally parenthesized) colon, so LABEL_CITE_RE's flush-colon
// beat (`Spec-022:146`) is never double-reported. The bridge excludes colons,
// backticks, brackets, and newlines, so a durable backticked §-anchor whose
// HEADING contains a colon (`` `Plan-008 §Phase 1: Bootstrap (…)` ``) never
// fires — the digits requirement after the colon rejects prose continuations
// ("…: Bootstrap"). The locator digits must sit FLUSH against the colon: every
// live line-cite spelling is flush (`:355`, ` :146`, `(:176-183`), while prose
// quoting a numeric VALUE out of a section writes colon-space (`§Scheduler
// Limits: 25`, `"Participants per session: 10"`, `timeout: 2 s`) — the flush
// requirement is what keeps those quotes out of a required deny. The tail is
// the same number-list shape as the flush-colon form.
// The §-bridge is UNCAPPED: outside inline-code spans it cannot cross a
// colon, a backtick, a bracket, a second `§`, or the line end, so the scan
// is already bounded by the first such delimiter — a length cap only
// manufactured an escape for long parenthetical bridges (a live 107-char
// instance sat unmatched in the claimed zero-residue corpus; Codex, PR #207
// round 2).
// The bridge DOES cross BALANCED inline-code spans (`` `[^`§]*` ``): corpus
// headings carry inline code (`… translate at \`PtyHost.kill\` …`), and a
// raw cite reproducing one (`Plan-024 §… \`PtyHost.kill\`:47`) slipped both
// lanes when the bridge stopped at the first backtick (Codex, PR #207
// round 3). A span may contain colons — the flush-digit locator is still
// required OUTSIDE the span. Three constraints keep the span crossing from
// gluing UNRELATED text into one match (the first full-tree run at round 4
// glued matches across sentence boundaries into ports (`0.0.0.0:8787`) and
// `chown 0:999` values):
//   - `(?<!\`)` — a label directly preceded by a backtick is the OPENING of
//     a durable anchor; matching from inside inverts tick parity, so the
//     "span" alternative pairs the anchor's closing tick with the next
//     span's OPENER and walks arbitrarily far right. The appended-locator
//     spelling that lookbehind excludes (`` `Spec-021 §Bind Address`:47 ``)
//     is DURABLE_LABEL_ANCHOR_COLON_RE's beat below — parity-correct by
//     construction.
//   - `§` excluded from the bridge char class AND the span interior — a
//     second `§` means any later locator belongs to the LATER §-ref, not
//     this label; label-less §-refs stay audit-layer (CAT-07).
//   - the third branch admits ONE task-coordinate token between label and
//     colon (`Plan-018 T4.5:251` — a live escapee the round-4 full-tree run
//     surfaced); prose task refs (`T3.4: the test`) stay out via the same
//     flush-digit rule.
// The residual: a heading whose UNBACKTICKED text contains a colon still
// cannot be §-bridge-matched in raw form — deliberate (that colon exclusion
// is what protects prose and durable anchors) and audit-layer (CAT-07).
const LABEL_SPACED_COLON_CITE_RE =
  /(?<!`)\b(Spec|Plan|ADR)-(\d{3})(?:\s+§(?:[^:`§\]\n]|`[^`§\n]*`)*?\s*\(?\s*:|\s+\(?\s*:|\s+T[\w.-]*\d\s*\(?\s*:)(\d+(?:\s*[,-]\s*\d+)*)/g;

// A colon locator appended AFTER a complete durable backticked anchor
// (`` `Spec-021 §Bind Address`:47 ``, `` `Spec-003`:12 ``,
// `` `docs/domain/session-model.md §Session Lifecycle`:61 ``) is the same
// rot in another spelling — the anchor half is durable, the appended pin is
// not. Matching the WHOLE anchor keeps tick parity correct (see the
// lookbehind rationale above). Flush digits after the colon preserve the
// value-vs-locator boundary (`` `Spec-025 §Limits`: 25 participants ``
// quotes a value and never fires). Label form carries the same
// (m[1], m[2]) group shape as the other label regexes so every scan site
// resolves the target identically; the path form mirrors
// PATH_SECTION_CITE_RE's docs/-rooted grammar (dot segments cannot parse,
// so no collapse is needed) and floors frozen-tree pins like the raw colon
// form instead of denying them.
const DURABLE_LABEL_ANCHOR_COLON_RE =
  /`(Spec|Plan|ADR)-(\d{3})(?: §[^`\n]+)?`\s*\(?\s*:(\d+(?:\s*[,-]\s*\d+)*)/g;
const DURABLE_PATH_ANCHOR_COLON_RE =
  /`(docs\/(?:[a-z][a-z-]*\/)*[A-Za-z0-9._-]+\.md) §[^`\n]+`\s*\(?\s*:(\d+(?:\s*[,-]\s*\d+)*)/g;

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

// Collapse `.` / `..` segments in a repo-root docs spelling so pass
// ownership and the frozen carve-out judge the RESOLVED target, not the raw
// prefix: `docs/archive/../specs/003-x.md` is a volatile specs/ cite wearing
// a frozen prefix, and DOCS_PATH_CITE_RE can never match a dot segment, so
// the raw-prefix shortcut both skipped the colon deny (assuming pass-2
// coverage that cannot exist) and floored the line-word form as frozen
// (Codex, PR #207 round 3). A `..` walking above the first segment resolves
// outside docs/ and the caller drops it as out of scope.
function collapseDotSegments(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

// Real document headings only: a `## Heading` line inside a ```/~~~ fence is
// example content, not a section — counting it would keep a §-cite "verified"
// after the real section was renamed away (Codex review, PR #188 round 4).
// Fence state comes from the shared tracker, so blockquote-nested fences and
// info-string closer lines are handled exactly like the deny loop; heading
// collection itself stays on the RAW line — a blockquoted `> ## Heading` is
// quoted example prose, not a citable section.
//
// The tracker takes that RAW line too: the blockquote prefix is what carries
// depth, and a pre-stripped line reads as depth 0 forever, so a `> ``` `
// example fence would be recorded at top level and outlive the quote that
// holds it, suppressing every real heading below (PR #273 round 1).
function listDocHeadings(docContent: string): string[] {
  const headings: string[] = [];
  let scanState: MarkdownScanState = INITIAL_SCAN_STATE;
  for (const line of docContent.split("\n")) {
    const advanced = advanceScanState(line, scanState);
    // Assigned on EVERY line, not only delimiters: the state carries the list
    // container stack, which an ordinary marker line is what advances. The
    // fence test reads `openFenceAtLineStart`, never the settled state — a
    // fence dies on the line that leaves its container, and that line's own
    // content is already outside it.
    scanState = advanced.state;
    if (advanced.isDelimiterLine) continue;
    if (advanced.openFenceAtLineStart === null && /^#+\s+/.test(line)) {
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
// uses. An optional non-capturing `#fragment` between `.md` and the colon
// keeps the fragment-bearing spelling (`docs/x.md#anchor:12`) inside the
// match — a fragment does not durable-ize an appended line locator, and
// requiring `.md` flush against the colon let that spelling bypass both the
// deny and the frozen floor (the same evasion class Codex flagged for the
// markdown-link form, PR #207 round 2; closed for the bare-path form in
// round 3). The path capture stays fragment-free so resolution is unchanged.
const DOCS_PATH_CITE_RE =
  /(?<![\w/.-])(docs\/(?:[a-z][a-z-]*\/)*[A-Za-z0-9._-]+\.md)(?:#[^\s:`)\]]*)?:(\d+(?:\s*[,-]\s*\d+)*)/g;

// Passes 5-6 (CODE citers only) — the CAT-07 ratchet closing the line-word and
// bare-basename residual (2026-07 sweep, PR-E of the hardening follow-ups):
// with the swept code trees at zero occurrences, every new match is a fresh
// gate-invisible line anchor and is denied outright with the durable-form
// remediation. Markdown citers get their own deny via
// checkMarkdownVolatileCites (2026-07-16 corpus-wide sweep) — the md corpus no
// longer keeps raw line-cite conventions outside the named exemptions.
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
// The §-bridge crosses BALANCED inline-code spans like the spaced-colon form
// (corpus headings carry inline code; a raw line-word cite reproducing one
// stopped at the first backtick — Codex, PR #207 round 3); the cap counts
// alternation units, so a span costs one unit regardless of length.
// `§` is excluded from the bridge char class AND the span interior — a
// second `§` hands any later `line N` to the LATER §-ref (the round-4
// full-tree run glued one label's bridge across a whole sentence to another
// ref's locator); label-less §-refs stay audit-layer (CAT-07). The `(?<!-)`
// guard keeps the deliberate hyphenated HISTORICAL compound out
// (`then-lines 306-319` records where content sat as-of-then — provenance,
// not a live pin) while the adjectival spelling (`line-48`, hyphen AFTER
// the word) still matches.
const LABEL_LINE_WORD_RE =
  /\b(Spec|Plan|ADR)-(\d{3})(?:\s+§(?:[^\n`§]|`[^`§\n]*`){0,200}?)?`?\s*[,;:]?\s*\(?\s*(?<!-)\blines?[-\s]+\d+(?:\s*[,-]\s*\d+)*/g;

// Pass 6 — `.md` path/basename with a line anchor: bare `session-model.md:61`
// / `api-payload-contracts.md line 120`, and the line-word tail on ANY path
// shape (`docs/domain/session-model.md line 61`) — the colon form on a
// docs/-rooted path is pass 2's (deny via raw-line-cite), so pass 6 skips that
// overlap. The optional closing backtick mirrors pass 5: a line-word tail
// after a durable path cite (`` `docs/….md §Heading` line 61 ``) is still a
// pin and still denied. The lookbehind keeps mid-path fragments from
// matching twice. The `[-\s]+` separator, `[,;:]` punctuation, {0,200}
// bridge, and trailing range/list group mirror pass 5 (hyphen spellings;
// comma variants; long headings; full-anchor rawTarget). The optional
// non-capturing `#fragment` after `.md` mirrors DOCS_PATH_CITE_RE: a
// fragment between path and locator (`x.md#anchor:12`, `x.md#anchor line
// 12`) does not durable-ize the pin, and path-flush grammars let it slip
// (PR #207 round 3, same class as the round-2 link-destination findings).
// The `)`/`]` exclusions keep the fragment from crossing a link's closing
// paren, so link destinations remain LINK_COLON_CITE_RE's beat alone. The
// §-bridge crosses balanced inline-code spans exactly like pass 5's, with
// the same second-`§` exclusion and `(?<!-)` historical-compound guard.
const MD_LINE_ANCHOR_RE =
  /(?<![\w/.-])([A-Za-z0-9._/-]+\.md)(?:#[^\s:`)\]]*)?(:\d+|(?:\s+§(?:[^\n`§]|`[^`§\n]*`){0,200}?)?`?\s*[,;:]?\s*\(?\s*(?<!-)\blines?[-\s]+\d+(?:\s*[,-]\s*\d+)*)/g;

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
): { text: string | null; insideBlockAfter: boolean; commentOnly: boolean } {
  if (line.trimStart().startsWith("--")) {
    // SQL comment line (migration template interiors) — whole line scans.
    return { text: line, insideBlockAfter: insideBlockComment, commentOnly: true };
  }
  // JSDoc/block-comment interior lines carry a `*` leader that would land in
  // the middle of a wrap-scan join (`governed by Spec-003 * line 4`) and
  // dodge every wrap regex — strip the decoration before scanning (Codex,
  // PR #207 round 2). `(?!\/)` leaves a lone `*/` closer intact.
  if (insideBlockComment) {
    line = line.replace(/^\s*\*+(?!\/)\s?/, "");
  }
  let collected = "";
  let sawComment = false;
  let sawCode = false;
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
      sawCode = true;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      sawCode = true;
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
    if (!/\s/.test(ch)) sawCode = true;
    i += 1;
  }
  return {
    text: sawComment ? collected : null,
    insideBlockAfter: inBlock,
    // commentOnly gates WRAP PAIRING only: a mixed code+comment line still
    // scans single-line, but its trailing comment never joins a neighboring
    // comment line — `// See Spec-003` above `const limit = 5; // line 5`
    // must not fuse into a phantom `Spec-003 line 5` cite (Codex, PR #207).
    commentOnly: sawComment && !sawCode,
  };
}

// Route one MD_LINE_ANCHOR_RE match — pass 6 and the wrap-split pair scans
// share this routing so the two entry points cannot drift.
// Colon-form means `:NNN` directly — `.md: line 5` (colon + line-word,
// reachable via the [,;:] separator) is a line-word spelling and must stay
// here, not be misrouted to pass 2 and vanish.
// Scope: bare basenames and repo-root docs/ paths only. Path-y non-corpus
// refs (node_modules/x/docs/y.md:3, src/docs/y.md:5) stay audit-layer — this
// is a required gate and those are the FP guards the pass-2 lookbehind
// already promised (kept green by the test suite's exclusion block).
// Docs-rooted colon forms are pass 2's match (raw-line-cite deny / frozen
// carve-out); firing here too would double-report the line.
// Frozen trees keep their line anchors legal (parity with the raw colon
// carve-out): the content never shifts, so the pin cannot rot. Legal ≠
// unchecked — route the cite through the pre-ratchet FLOOR (no lineWordDeny;
// per-endpoint target lines) so a deleted frozen doc or out-of-range pin
// still fails loudly, exactly like the colon form does in
// checkLabelCiteTargets' frozen branch (Codex, PR #195 — pass 6 previously
// dropped these matches entirely). Anchor numbers are the digits AFTER the
// line-word — a §-segment number (`§RFC 9110 line 20`) is part of the
// heading, not a pin — and every range / list endpoint floors, matching the
// colon form's per-endpoint expansion (Codex, PR #195 round 2).
// Route one DURABLE_PATH_ANCHOR_COLON_RE match — the colon locator appended
// after a durable docs/-rooted path anchor. The path grammar cannot parse dot
// segments (directory segments admit no dots), so no collapse step exists,
// and DOCS_PATH_CITE_RE can never claim the match (the § segment breaks its
// path-flush colon), so there is no pass-2 overlap to skip. Frozen-tree pins
// floor per endpoint exactly like the raw colon form; volatile targets deny.
function pushDurablePathAnchorColonCite(
  cites: Cite[],
  citingFile: string,
  oneBasedLine: number,
  repoRoot: string,
  m: RegExpExecArray,
): void {
  const mdPath = m[1];
  const rawTargetDisplay = m[0].trim().replace(/\s+/g, " ");
  if (FROZEN_DOC_PREFIXES.some((prefix) => mdPath.startsWith(prefix))) {
    for (const endpointMatch of m[2].matchAll(/\d+/g)) {
      cites.push({
        file: citingFile,
        line: oneBasedLine,
        rawTarget: rawTargetDisplay,
        targetPath: resolve(repoRoot, mdPath),
        targetLine: Number(endpointMatch[0]),
      });
    }
    return;
  }
  cites.push({
    file: citingFile,
    line: oneBasedLine,
    rawTarget: rawTargetDisplay,
    targetPath: resolve(repoRoot, mdPath),
    targetLine: 0,
    lineWordDeny: true,
  });
}

function pushMdAnchorCite(
  cites: Cite[],
  citingFile: string,
  oneBasedLine: number,
  repoRoot: string,
  m: RegExpExecArray,
): void {
  let mdPath = m[1];
  const colonForm = /^:\d/.test(m[2]);
  if (mdPath.startsWith("docs/")) {
    // Same dot-segment collapse as the md lane: pass ownership and the
    // frozen carve-out judge the resolved target — `docs/archive/../specs/…`
    // is volatile despite its frozen prefix, and pass 2 can never match a
    // dot segment, so the colon shortcut applies only to the collapsed-
    // equals-raw spelling (Codex, PR #207 round 3).
    const collapsed = collapseDotSegments(mdPath);
    if (!collapsed.startsWith("docs/")) return;
    if (colonForm && collapsed === mdPath) return;
    mdPath = collapsed;
  } else if (mdPath.includes("/")) {
    return;
  }
  // rawTarget is display + dedupe only — collapse the double space the
  // wrap-scan join manufactures (prev text keeps its trailing space, the
  // join adds one, curr keeps its leading space).
  const rawTargetDisplay = m[0].trim().replace(/\s+/g, " ");
  if (FROZEN_DOC_PREFIXES.some((prefix) => mdPath.startsWith(prefix))) {
    const lineWordTail = m[2].slice(m[2].search(/\blines?\b/));
    for (const endpointMatch of lineWordTail.matchAll(/\d+/g)) {
      cites.push({
        file: citingFile,
        line: oneBasedLine,
        rawTarget: rawTargetDisplay,
        targetPath: resolve(repoRoot, mdPath),
        targetLine: Number(endpointMatch[0]),
      });
    }
    return;
  }
  cites.push({
    file: citingFile,
    line: oneBasedLine,
    rawTarget: rawTargetDisplay,
    targetPath: mdPath.startsWith("docs/") ? resolve(repoRoot, mdPath) : "",
    targetLine: 0,
    lineWordDeny: true,
  });
}

function extractLabelCitesFrom(
  citingFile: string,
  repoRoot: string,
  reader: FileContentReader,
): Cite[] {
  // Resolve to absolute before reading: FileContentReader implementations
  // take absolute paths (the index-aware reader converts to a repo-relative
  // `git show :path` internally), while the displayed `file` below keeps the
  // original (relative) path for a clean, clickable message. `resolve()` is
  // idempotent for already-absolute inputs (the test harness passes absolute
  // temp paths), so this is a no-op there.
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
  // Previous line's comment text (null when that line had none) — the
  // wrap-split pair scan joins adjacent comment lines to catch a cite whose
  // label / path half and `line N` locator sit on opposite sides of a comment
  // wrap, the shape every single-line pass is blind to (the CAT-07 wrapped-
  // cite Known Gap, closed by the 2026-07 corpus sweep). Colon forms cannot
  // wrap — `Spec-003:178` has no interior whitespace — so only the line-word
  // regexes join-scan. Spans of 3+ lines (blank comment line between label
  // and locator) stay audit-layer residual.
  let previousCommentText: string | null = null;
  let scanState: MarkdownScanState = INITIAL_SCAN_STATE;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (trackFences) {
      const advanced = advanceScanState(line, scanState);
      // Assigned on EVERY line: the state carries the list container stack,
      // which ordinary marker lines advance. The fence test reads
      // `openFenceAtLineStart`, never the settled state — a fence dies on the
      // line that leaves its container, and that line's own content is
      // already outside it.
      scanState = advanced.state;
      if (advanced.isDelimiterLine) continue;
      if (advanced.openFenceAtLineStart !== null) continue;
    }
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
      if (scanText.text === null) {
        // A non-comment line breaks comment adjacency — a label two lines up
        // is not the antecedent of a locator below intervening code.
        previousCommentText = null;
        continue;
      }
      // Wrap-split pair scan: deny line-word matches that SPAN the join
      // boundary. Matches wholly inside either line are the single-line
      // passes' beat (the boundary test excludes them), so nothing
      // double-reports. The reported line is the pair's FIRST line — where
      // the wrapped cite starts. Pairing requires BOTH sides to be
      // comment-ONLY lines: a trailing comment on a code line never joins
      // (third documented bound — Codex, PR #207).
      if (previousCommentText !== null && scanText.commentOnly) {
        const joined = `${previousCommentText} ${scanText.text}`;
        const boundary = previousCommentText.length;
        for (const wrapRe of [
          LABEL_LINE_WORD_RE,
          LABEL_SPACED_COLON_CITE_RE,
          DURABLE_LABEL_ANCHOR_COLON_RE,
          MD_LINE_ANCHOR_RE,
          DURABLE_PATH_ANCHOR_COLON_RE,
        ]) {
          wrapRe.lastIndex = 0;
          while ((m = wrapRe.exec(joined)) !== null) {
            if (m.index >= boundary || m.index + m[0].length <= boundary + 1) continue;
            if (wrapRe === MD_LINE_ANCHOR_RE) {
              pushMdAnchorCite(cites, citingFile, i, repoRoot, m);
            } else if (wrapRe === DURABLE_PATH_ANCHOR_COLON_RE) {
              pushDurablePathAnchorColonCite(cites, citingFile, i, repoRoot, m);
            } else {
              cites.push({
                file: citingFile,
                line: i,
                rawTarget: m[0].trim().replace(/\s+/g, " "),
                targetPath: resolveLabelTarget(repoRoot, m[1], m[2]),
                targetLine: 0,
                lineWordDeny: true,
              });
            }
          }
        }
      }
      previousCommentText = scanText.commentOnly ? scanText.text : null;
      for (const labelRe of [
        LABEL_LINE_WORD_RE,
        LABEL_SPACED_COLON_CITE_RE,
        DURABLE_LABEL_ANCHOR_COLON_RE,
      ]) {
        labelRe.lastIndex = 0;
        while ((m = labelRe.exec(scanText.text)) !== null) {
          cites.push({
            file: citingFile,
            line: i + 1,
            rawTarget: m[0].trim(),
            targetPath: resolveLabelTarget(repoRoot, m[1], m[2]),
            targetLine: 0,
            lineWordDeny: true,
          });
        }
      }
      MD_LINE_ANCHOR_RE.lastIndex = 0;
      while ((m = MD_LINE_ANCHOR_RE.exec(scanText.text)) !== null) {
        pushMdAnchorCite(cites, citingFile, i + 1, repoRoot, m);
      }
      DURABLE_PATH_ANCHOR_COLON_RE.lastIndex = 0;
      while ((m = DURABLE_PATH_ANCHOR_COLON_RE.exec(scanText.text)) !== null) {
        pushDurablePathAnchorColonCite(cites, citingFile, i + 1, repoRoot, m);
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

// Section-anchor verification for MARKDOWN citers. The md lane still must
// NOT route through checkLabelCiteTargets — its deny copy, docs-path
// handling, and comment lexing are code-lane-specific — so this narrower
// walk extracts ONLY the backticked §-anchor forms and verifies the heading,
// closing the docs-to-docs gap the Durable-Cite Rule promises (Codex review,
// PR #188). Raw volatile line cites in md are checkMarkdownVolatileCites'
// beat (deny, post-sweep); frozen-pin floors stay cite-target-existence's.
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

// Volatile-cite DENY for MARKDOWN citers — the md-lane ratchet (2026-07
// corpus-wide sweep). The sweep converted every doc→doc line cite outside the
// named exemptions to the durable §-anchor form, so — exactly like the code
// lane's post-sweep passes — every new match is a fresh line pin that rots on
// the target's next amendment. Denied spellings: raw label colon
// (`Spec-003:178`, backticked or not), docs-path colon
// (`docs/domain/x.md:61`), markdown-link colon (`[x](../specs/003-y.md):12`),
// label line-word (`Spec-003 line 178`), `.md` path / basename line-word
// (`session-model.md line 61`), and the wrap-split spelling of the line-word
// forms (label / path half at one line's end, `line N` locator opening the
// next). Colon forms cannot wrap — no interior whitespace — so only the
// line-word regexes join-scan.
//
// Exemptions — each deliberate, each visible in review:
//   - EXEMPT CITER TREES (MD_DENY_EXEMPT_CITER_PREFIXES): superpowers
//     campaign logs are dated provenance; .claude/ harness docs are rule text
//     full of cite-shape examples; frozen trees are defense in depth.
//   - PLAN TASKS-BLOCK GRAMMAR: in docs/plans/ citers, payload-marker lines
//     (PLAN_GRAMMAR_MARKER_RE) and `|`-table rows — plan-execution preflight
//     Gate 4 owns and semantically verifies that grammar (AGENTS.md
//     §Durable-Cite Rule, namespace carve-out (1)).
//   - WAIVER MARKER: a line carrying CITE_SHAPE_EXAMPLE_MARKER is an
//     illustrative cite-shape example (failure-mode-catalog rows, rule text).
//   - FENCED BLOCKS: quoted example content, never authoritative cites.
//   - FROZEN TARGETS (docs/archive/, docs/reference/): pins cannot rot.
//     Legal ≠ unchecked — bare docs-path colon and line-word spellings route
//     through the pre-ratchet FLOOR here (extractCites' bare pass is
//     code-extensions-only, so nothing else validates them); backticked and
//     markdown-link spellings are already floored by extractCites (codeRe /
//     linkRe) and are skipped here so a broken pin reports once, not twice.
//
// Label-less bare continuations (`; line 41 (…)` under an earlier line's
// label) and `AC-N:LL` shorthands have no label adjacency for a required
// gate to key on — the sweep converted them and they stay audit-layer
// residual (CAT-07), same as semantic drift under an intact anchor.
export function checkMarkdownVolatileCites(
  files: string[],
  reader: FileContentReader = defaultReader,
): CiteViolation[] {
  const repoRoot = getRepoRoot();
  const violations: CiteViolation[] = [];
  const deniedRawCites = new Set<string>();

  const denyVolatile = (citingFile: string, oneBasedLine: number, rawSpelling: string): void => {
    // Display + dedupe string only — collapse the double space the
    // wrap-scan join manufactures.
    const rawTarget = rawSpelling.replace(/\s+/g, " ");
    const dedupeKey = `${citingFile}:${oneBasedLine}:${rawTarget}`;
    if (deniedRawCites.has(dedupeKey)) return;
    deniedRawCites.add(dedupeKey);
    violations.push({
      cite: { file: citingFile, line: oneBasedLine, rawTarget, targetPath: "", targetLine: 0 },
      reason: "line-anchored-cite-in-docs",
      detail: `volatile line cite '${rawTarget}' in a docs citer rots on the target's next amendment — cite the durable \`Spec-NNN §Heading\` form (label-less docs: \`docs/<tree>/<file>.md §Heading\`) instead (AGENTS.md §Durable-Cite Rule; 2026-07 corpus sweep)`,
    });
  };

  const floorFrozenEndpoints = (
    citingFile: string,
    oneBasedLine: number,
    rawSpelling: string,
    frozenDocsPath: string,
    endpoints: Iterable<number>,
  ): void => {
    for (const targetLine of endpoints) {
      const floorViolation = checkCite(
        {
          file: citingFile,
          line: oneBasedLine,
          rawTarget: rawSpelling,
          targetPath: resolve(repoRoot, frozenDocsPath),
          targetLine,
        },
        reader,
      );
      if (floorViolation) violations.push(floorViolation);
    }
  };

  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const absoluteCiter = resolve(f);
    const repoRelativeCiter = relative(repoRoot, absoluteCiter).split(sep).join("/");
    if (MD_DENY_EXEMPT_CITER_PREFIXES.some((prefix) => repoRelativeCiter.startsWith(prefix))) {
      continue;
    }
    const planGrammarCiter = repoRelativeCiter.startsWith("docs/plans/");
    let content: string;
    try {
      content = reader(absoluteCiter);
    } catch {
      // Deleted-in-index / unreadable citer: nothing staged to scan.
      continue;
    }
    const lines = content.split("\n");

    // Line-word scan shared by the single-line pass and the wrap-split pair
    // scan. spanBoundary null = single-line; otherwise only matches SPANNING
    // the join boundary count (wholly-inside matches are the single-line
    // pass's beat — nothing double-reports).
    const scanLineWordForms = (
      scanText: string,
      oneBasedLine: number,
      spanBoundary: number | null,
    ): void => {
      for (const lineWordRe of [
        LABEL_LINE_WORD_RE,
        LABEL_SPACED_COLON_CITE_RE,
        DURABLE_LABEL_ANCHOR_COLON_RE,
        MD_LINE_ANCHOR_RE,
        DURABLE_PATH_ANCHOR_COLON_RE,
      ]) {
        lineWordRe.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = lineWordRe.exec(scanText)) !== null) {
          if (
            spanBoundary !== null &&
            (match.index >= spanBoundary || match.index + match[0].length <= spanBoundary + 1)
          ) {
            continue;
          }
          if (lineWordRe === DURABLE_PATH_ANCHOR_COLON_RE) {
            // Same frozen-floor / volatile-deny split as the code lane's
            // pushDurablePathAnchorColonCite; the grammar is docs/-rooted and
            // dot-segment-free by construction, so no resolution step exists.
            const mdPath = match[1];
            if (FROZEN_DOC_PREFIXES.some((prefix) => mdPath.startsWith(prefix))) {
              const endpoints = [...match[2].matchAll(/\d+/g)].map((d) => Number(d[0]));
              floorFrozenEndpoints(f, oneBasedLine, match[0].trim(), mdPath, endpoints);
            } else {
              denyVolatile(f, oneBasedLine, match[0].trim());
            }
            continue;
          }
          if (lineWordRe !== MD_LINE_ANCHOR_RE) {
            denyVolatile(f, oneBasedLine, match[0].trim());
            continue;
          }
          // Same scope guards as the code lane's pushMdAnchorCite, plus
          // md-citer RELATIVE-path resolution: `../specs/003-x.md:12` resolves
          // against the citing file's directory exactly like the markdown-link
          // pass, so the relative spelling of a governance target cannot dodge
          // the deny (Codex, PR #207). Only EXPLICITLY relative spellings
          // (`../`, `./`) resolve citer-relative — the corpus cites files by
          // repo-root path, so a bare slashed non-docs path (`packages/x/
          // readme.md line 5`) is a repo-root mention of a non-governance file
          // and out of the docs→docs deny's scope, not a citer-relative path
          // that happens to land inside docs/. Paths resolving outside docs/
          // stay audit-layer. Colon forms on RAW docs-rooted spellings are the
          // docs-path pass's beat above; relative colon spellings are NOT
          // (DOCS_PATH_CITE_RE never matches them), so they route here.
          // Frozen pins floor — colon and line-word tails alike.
          let mdPath = match[1];
          const colonForm = /^:\d/.test(match[2]);
          if (/^\.\.?\//.test(mdPath)) {
            const resolvedTarget = relative(repoRoot, resolve(dirname(absoluteCiter), mdPath))
              .split(sep)
              .join("/");
            if (!resolvedTarget.startsWith("docs/")) continue;
            mdPath = resolvedTarget;
          } else if (mdPath.startsWith("docs/")) {
            // Repo-root docs spelling: judge ownership and freezing on the
            // COLLAPSED path. Only a dot-segment-free colon spelling is the
            // docs-path pass's beat (DOCS_PATH_CITE_RE cannot match `..`) —
            // a dot-segment colon form denies HERE or nowhere (Codex,
            // PR #207 round 3).
            const collapsed = collapseDotSegments(mdPath);
            if (!collapsed.startsWith("docs/")) continue;
            if (colonForm && collapsed === mdPath) continue;
            mdPath = collapsed;
          } else if (mdPath.includes("/")) {
            continue;
          }
          if (FROZEN_DOC_PREFIXES.some((prefix) => mdPath.startsWith(prefix))) {
            const locatorTail = colonForm
              ? match[2]
              : match[2].slice(match[2].search(/\blines?\b/));
            const endpoints = [...locatorTail.matchAll(/\d+/g)].map((d) => Number(d[0]));
            floorFrozenEndpoints(f, oneBasedLine, match[0].trim(), mdPath, endpoints);
            continue;
          }
          denyVolatile(f, oneBasedLine, match[0].trim());
        }
      }
    };

    // Fence tracking via the shared CommonMark tracker (RAW input — it does
    // its own container-relative stripping; delimiter-matched, whitespace-only
    // closers — see advanceScanState). A delimiter line of either kind breaks
    // wrap adjacency: the label half of a wrapped cite cannot sit on the far
    // side of a fence boundary from its locator. `unquoted` below is a
    // SEPARATE, all-levels strip for this loop's own prose parsing, which
    // wants the line's text whatever container holds it.
    let scanState: MarkdownScanState = INITIAL_SCAN_STATE;
    let previousProseLine: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const unquoted = stripBlockquotePrefix(line);
      const advanced = advanceScanState(line, scanState);
      // Assigned on EVERY line: the state carries the list container stack,
      // which ordinary marker lines advance. The fence test reads
      // `openFenceAtLineStart`, never the settled state — a fence dies on the
      // line that leaves its container, and that line's own content is
      // already outside it.
      scanState = advanced.state;
      if (advanced.isDelimiterLine) {
        previousProseLine = null;
        continue;
      }
      if (advanced.openFenceAtLineStart !== null) continue;
      if (line.includes(CITE_SHAPE_EXAMPLE_MARKER)) {
        previousProseLine = null;
        continue;
      }
      if (planGrammarCiter && PLAN_GRAMMAR_MARKER_RE.test(line)) {
        previousProseLine = null;
        continue;
      }
      let m: RegExpExecArray | null;

      // Raw label colon — targets resolve under TOKEN_DIRS, never frozen.
      // (The spaced-colon spelling — `Spec-022 §Daemon Master Key :146` —
      // is LABEL_SPACED_COLON_CITE_RE's beat inside scanLineWordForms, which
      // runs on every prose line below.)
      LABEL_CITE_RE.lastIndex = 0;
      while ((m = LABEL_CITE_RE.exec(line)) !== null) {
        denyVolatile(f, i + 1, m[0].trim());
      }

      // Docs-path colon. Frozen: bare spellings floor here; backticked PLAIN
      // spellings are codeRe-floored by extractCites — skipped to avoid
      // reporting the same broken pin twice. The skip is conditioned on what
      // extractCites can actually parse: codeRe's path class has no `#`, so
      // a fragment-bearing backticked pin (`` `docs/archive/x.md#a:12` ``)
      // floors HERE or nowhere — the same parseability trap Codex flagged
      // for the link form (PR #207 round 2; fragment analog closed in
      // round 3). The path capture is fragment-free, so any `#` in the
      // match text is the fragment.
      DOCS_PATH_CITE_RE.lastIndex = 0;
      while ((m = DOCS_PATH_CITE_RE.exec(line)) !== null) {
        const docsPath = m[1];
        if (FROZEN_DOC_PREFIXES.some((prefix) => docsPath.startsWith(prefix))) {
          const backtickedSpelling = m.index > 0 && line[m.index - 1] === "`";
          const fragmentBearing = m[0].includes("#");
          if (!backtickedSpelling || fragmentBearing) {
            floorFrozenEndpoints(f, i + 1, m[0], docsPath, expandLineSpec(m[2]));
          }
          continue;
        }
        denyVolatile(f, i + 1, m[0].trim());
      }

      // Markdown-link colon — the target resolves citer-relative, exactly
      // like extractCites' linkRe (which already floors every endpoint,
      // frozen included — the deny adds the ratchet for volatile targets).
      LINK_COLON_CITE_RE.lastIndex = 0;
      while ((m = LINK_COLON_CITE_RE.exec(line)) !== null) {
        const linkTarget = m[1].trim();
        if (/^https?:/.test(linkTarget)) continue;
        const targetRepoRelative = relative(repoRoot, resolve(dirname(absoluteCiter), linkTarget))
          .split(sep)
          .join("/");
        // Same scope as every other pass: the deny covers governance targets
        // under docs/ — a linked line pin into a non-docs .md is outside the
        // docs→docs rule and stays audit-layer.
        if (!targetRepoRelative.startsWith("docs/")) continue;
        if (FROZEN_DOC_PREFIXES.some((prefix) => targetRepoRelative.startsWith(prefix))) {
          // extractCites' linkRe floors only the PLAIN spelling — a
          // destination ending `.md` flush against the closing paren, no
          // fragment / angle bracket / title — so frozen pins in every other
          // spelling floor HERE or nowhere (Codex, PR #207 round 2). The
          // discriminator tests that structure directly rather than sniffing
          // for marker characters, so a spelling the character sniff missed
          // (the paren-delimited title carries none of `<#"'`) cannot slip
          // between the two floors (round 3).
          const plainLinkSpelling = /\]\([^)]*\.md\)\s*:/.test(m[0]);
          if (!plainLinkSpelling) {
            floorFrozenEndpoints(f, i + 1, m[0].trim(), targetRepoRelative, expandLineSpec(m[2]));
          }
          continue;
        }
        denyVolatile(f, i + 1, m[0].trim());
      }

      scanLineWordForms(line, i + 1, null);
      // Wrap pairing joins the UNQUOTED forms: an ordinary blockquoted cite
      // split as `> governed by Spec-003` / `> line 4` would otherwise keep
      // the second `>` between label and locator and dodge every wrap regex
      // (Codex, PR #207 round 2). Blockquoted prose is NOT exempt — only
      // fenced blocks are — and single-line scans are unaffected (a leading
      // `>` never interrupts an in-line match).
      if (previousProseLine !== null) {
        scanLineWordForms(`${previousProseLine} ${unquoted}`, i, previousProseLine.length);
      }
      previousProseLine = unquoted;
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
    `label-cite: ${violations.length} violation(s). Raw governance line-cites in code and docs are denied — cite the backticked \`Spec-NNN §Heading\` anchor form (label-less docs: \`docs/<path>.md §Heading\`) instead, and verify §-anchors name a real heading (AGENTS.md §Durable-Cite Rule).`,
  );
  return lines.join("\n");
}
