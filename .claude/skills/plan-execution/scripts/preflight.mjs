#!/usr/bin/env node
// preflight.mjs — plan-execution skill mechanical gate runner.
// Authoritative contract: ../references/preflight-contract.md.
//
// Exit codes:
//   0 — all gates pass; stdout = selected phase number on a single line.
//   1 — gate failed; stdout = self-contained halt message (orchestrator
//       surfaces verbatim).
//   2 — internal error (malformed input); stderr describes; stdout empty.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { parseManifestBlock, validateEntry, MANIFEST_SCHEMA_VERSION } from "./lib/manifest.mjs";

// ---------- paths ----------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, "..");
const SKILL_MD = resolve(SKILL_ROOT, "SKILL.md");
const REPO_ROOT = resolve(SKILL_ROOT, "..", "..", "..");

// ---------- pure helpers (exported for tests) ----------

export function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const lines = match[1].split("\n");
  const result = {};
  let inList = null;
  for (const line of lines) {
    const listKeyMatch = line.match(/^([a-zA-Z_][\w]*)\s*:\s*$/);
    if (listKeyMatch) {
      inList = listKeyMatch[1];
      result[inList] = [];
      continue;
    }
    if (inList) {
      const item = line.match(/^\s+-\s+(.+?)\s*$/);
      if (item) {
        result[inList].push(item[1].trim());
      } else if (/^\S/.test(line)) {
        inList = null;
      }
    }
  }
  return result;
}

// Accept "—" (em-dash, plan-template canonical), ":" (Plan-007/008/023 style),
// or "-" (hyphen-minus) as the Phase-heading separator. Plan-007's mid-execution
// status makes a corpus-wide rename out of scope; tolerating both forms in the
// parser keeps the tool usable across the existing corpus without authorising
// drift in new plans (plan-template still documents em-dash as the convention).
export function walkPhases(planSource) {
  const re = /^### Phase (\d+)\s*(?:—|:|-)\s*(.+?)\s*$/gm;
  const phases = [];
  let m;
  while ((m = re.exec(planSource)) !== null) {
    phases.push({ number: Number(m[1]), title: m[2].trim() });
  }
  return phases;
}

export function extractPhaseSection(planSource, phaseNumber) {
  const startRe = new RegExp(`^### Phase ${phaseNumber}\\s*(?:—|:|-)\\s*.+$`, "m");
  const startMatch = startRe.exec(planSource);
  if (!startMatch) return null;
  const startIdx = startMatch.index;
  const bodyStart = startIdx + startMatch[0].length;
  // Bound the section at the next phase heading (`### Phase N`) OR the next
  // level-2 `## ` sibling section (Rollout Order / Risks / Progress Log / Done
  // Checklist), whichever comes first. The `## ` boundary is load-bearing:
  // without it the LAST phase ran to EOF and swallowed the Progress Log's
  // Shipment Manifest ```yaml block (and Done Checklist) into its section —
  // which (a) let parsePreconditionsBlock mistake the manifest for an empty
  // preconditions block and silently skip the prose **Precondition:** gate
  // (last-phase gate no-op), and (b) risked Gate-3 task-id / Gate-4 cite tokens
  // bleeding in from trailing prose. `## ` (two hashes + space) matches neither
  // `### Phase` nor `#### Tasks` (three / four hashes).
  //
  // The boundary scan is fence-aware (findSectionBoundary): a `### Phase N` or
  // `## ` line INSIDE a fenced code block — a shell `## comment`, a markdown
  // example heading — is phase body, not a section boundary, so a phase that
  // carries such an example is no longer severed from its `#### Tasks` block.
  const endRel = findSectionBoundary(planSource.slice(bodyStart));
  const endIdx = endRel === -1 ? planSource.length : bodyStart + endRel;
  return planSource.slice(startIdx, endIdx);
}

// Byte offset within `body` of the first `### Phase N` / `## ` heading that sits
// OUTSIDE any fenced code block, or -1 if none. Split out of extractPhaseSection
// so the fence state machine is unit-testable on its own. Fence tracking follows
// CommonMark: an opening ``` / ~~~ run of length N opens a block that only a
// closing run of the same character and length >= N — with no trailing info
// string — closes, so a longer outer run contains shorter inner runs (a
// 4-backtick fence wraps 3-backtick lines), matching the nesting plans use.
// Indented code needs no handling: its lines carry leading whitespace and never
// match `^### `/`^## `.
export function findSectionBoundary(body) {
  let offset = 0;
  let fenceChar = ""; // "" when outside a fence; "`" or "~" while inside one
  let fenceLen = 0;
  for (const line of body.split("\n")) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const runChar = fence[1][0];
      const bareClose = /^\s*$/.test(line.slice(fence[0].length));
      if (fenceChar === "") {
        fenceChar = runChar;
        fenceLen = fence[1].length;
      } else if (runChar === fenceChar && fence[1].length >= fenceLen && bareClose) {
        fenceChar = "";
        fenceLen = 0;
      }
    } else if (fenceChar === "" && (/^### Phase \d+/.test(line) || /^## /.test(line))) {
      return offset;
    }
    offset += line.length + 1; // +1 restores the "\n" consumed by split
  }
  return -1;
}

export function countCites(phaseSection) {
  return {
    spec_coverage: (phaseSection.match(/Spec coverage/g) || []).length,
    verifies_invariant: (phaseSection.match(/Verifies invariant/g) || []).length,
  };
}

export function extractAuditCheckbox(planSource) {
  return /^- \[x\] \*\*Plan-readiness audit complete/m.test(planSource);
}

export function parseFlowMapping(line) {
  const inner = line.match(/\{(.+?)\}/)?.[1];
  if (!inner) return null;
  const obj = {};
  for (const pair of inner.split(",")) {
    const colonIdx = pair.indexOf(":");
    if (colonIdx === -1) continue;
    const k = pair.slice(0, colonIdx).trim();
    let v = pair.slice(colonIdx + 1).trim();
    if (!k) continue;
    if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    else if (/^"[^"]*"$|^'[^']*'$/.test(v)) v = v.slice(1, -1);
    obj[k] = v;
  }
  return obj;
}

export function parsePreconditionsBlock(phaseSection) {
  // Accept both ```yaml and ```yml — markdown writers use either; treating
  // them differently produces silent gate-skips when a plan author picks the
  // shorter fence.
  //
  // A yaml block is only a *preconditions* block if it contains a top-level
  // `preconditions:` key. Select that block specifically — other yaml blocks in
  // a phase section (a schema/data example in a task body, or the Progress Log
  // Shipment Manifest if it lands in the section) are NOT preconditions blocks.
  // Returning [] for them conflated "no preconditions block" with "empty
  // preconditions list", which made gatePreconditions skip the prose
  // **Precondition:** fallback and vacuously pass — the silent gate-disable seen
  // on the last phase of every manifested plan (Plan-001 P5, Plan-002 P6,
  // Plan-003 P5) and on Plan-002 Phase 2's in-body example. Return null (no
  // preconditions block) so the prose fallback runs.
  let blockBody = null;
  for (const m of phaseSection.matchAll(/```ya?ml\s*\n([\s\S]*?)\n```/g)) {
    if (/^\s*preconditions\s*:/m.test(m[1])) {
      blockBody = m[1];
      break;
    }
  }
  if (blockBody === null) return null;
  const lines = blockBody.split("\n");
  // Track the column at which `preconditions:` was found (-1 means we're not
  // inside the block). The first list item after the key locks `itemIndent`;
  // subsequent items must match that exact indent. Both YAML block-sequence
  // forms are accepted: compact (`indent === preIndent`, e.g.
  // `preconditions:\n- {…}`) and expanded (`indent > preIndent`, e.g.
  // `preconditions:\n  - {…}`). Locking on the first item prevents a sibling
  // list at the parent key's indent from being falsely absorbed in expanded
  // mode. De-indenting back to the key's column or shallower with a non-list,
  // non-comment-only line exits the block; comments are metadata and never
  // change parser state. Re-arming on a subsequent `preconditions:` key keeps
  // the parser forgiving against malformed YAML.
  let preIndent = -1;
  let itemIndent = -1;
  const entries = [];
  for (const line of lines) {
    // Accept trailing whitespace and an optional YAML line-comment after the
    // colon (e.g. `preconditions: # gated by ADR-023`). Reject inline values
    // (`preconditions: foo` or `preconditions: []`) so an inline-empty list
    // doesn't falsely enter block mode and silently swallow following lines.
    const keyMatch = line.match(/^(\s*)preconditions\s*:\s*(#.*)?$/);
    if (keyMatch) {
      preIndent = keyMatch[1].length;
      itemIndent = -1;
      continue;
    }
    if (preIndent < 0) continue;
    const itemMatch = line.match(/^(\s*)-\s+/);
    if (itemMatch) {
      const indent = itemMatch[1].length;
      if (itemIndent < 0 && indent >= preIndent) itemIndent = indent;
      if (indent === itemIndent) {
        const entry = parseFlowMapping(line);
        if (entry) entries.push(entry);
        continue;
      }
      // List item at unexpected indent (e.g., a sibling list outside the
      // preconditions block in expanded mode) — fall through to exit logic.
    }
    // Comments are metadata — never trigger block exit, regardless of their
    // indent. In compact form (`indent === preIndent`) a comment-only line at
    // the parent indent would otherwise satisfy the de-indent exit check and
    // silently drop subsequent items, producing a gate-skip on later
    // preconditions. Match `# foo` or `   # foo` but not `key: # trailing`,
    // which is a key-with-trailing-comment.
    if (/\S/.test(line) && !/^\s*#/.test(line)) {
      const lineIndent = line.match(/^\s*/)[0].length;
      if (lineIndent <= preIndent) {
        preIndent = -1;
        itemIndent = -1;
      }
    }
  }
  return entries;
}

export function regexParsePreconditionsLine(line, localPlanNumber) {
  const entries = [];
  for (const m of line.matchAll(/PR\s*#(\d+)\s+merged/gi)) {
    entries.push({ type: "pr_merged", ref: Number(m[1]) });
  }
  for (const m of line.matchAll(/ADR-(\d{3})\s+accepted/gi)) {
    entries.push({ type: "adr_accepted", ref: Number(m[1]) });
  }
  for (const m of line.matchAll(/Plan-(\d{3})\s+Phase\s*(\d+)\s+(?:approved|merged)/gi)) {
    entries.push({ type: "plan_phase", plan: Number(m[1]), phase: Number(m[2]), status: "merged" });
  }
  // Cross-tier deferral on an un-decomposed upstream plan. The corpus convention
  // for a precondition gated on a plan that has NOT yet been decomposed into
  // phases (no `### Phase` sections, no shipment manifest) is the prose form
  // `Plan-NNN Tier M (merged|complete|ships) …` — distinct from the
  // `Plan-NNN Phase N merged` form above (resolved against the upstream's
  // per-phase manifest by the plan_phase case). Corpus examples: Plan-002
  // Phase 4 (`[Plan-021](…) Tier 6 ships the rateLimitProcedure …`), Plan-002
  // Phase 2 (`[Plan-025 Tier 1 Partial](…) merged`), Plan-002 Phase 6
  // (`Plan-023 Tier 1 Partial complete`). Without this branch the line falls
  // through to gatePreconditions' "unparseable prose → legacy free-form →
  // silent pass", which lets a phase whose ONLY other precondition token is
  // already satisfied (e.g. a local `Phase 2 merged`) resolve eligible while
  // its cross-tier substrate is still absent — the Plan-002 Phase 4
  // false-eligible the auto-walk hit before this fix. The optional `](url)`
  // groups absorb the markdown link whether the plan number sits in the link
  // TARGET (`[Plan-021](url) Tier 6 ships`) or inside the link TEXT
  // (`[Plan-025 Tier 1 Partial](url) merged`).
  for (const m of line.matchAll(
    /Plan-(\d{3})(?:\]\([^)]*\))?\s+Tier\s+\d+(?:\s+Partial)?(?:\]\([^)]*\))?\s+(?:merged|complete|ships)\b/gi,
  )) {
    entries.push({ type: "plan_unshipped", plan: Number(m[1]) });
  }
  // Bare-form `Phase N merged` resolves to the local plan. The corpus convention
  // for same-plan precondition prose is the bare form (Plan-001/003/007/024
  // all use it); without this branch the Gate 5 regex drops the dependency
  // and `gatePreconditions` falls to "unparseable prose; treat as legacy
  // free-form" → silent pass. Negative lookbehind prevents double-counting
  // the `Phase N merged` inside a `Plan-NNN Phase N merged` already captured
  // by the regex above. Callers that omit `localPlanNumber` get the
  // pre-extension behavior (used by the legacy unit-test surface).
  if (Number.isInteger(localPlanNumber)) {
    for (const m of line.matchAll(/(?<!Plan-\d{3}\s+)\bPhase\s*(\d+)\s+(?:approved|merged)/gi)) {
      entries.push({
        type: "plan_phase",
        plan: localPlanNumber,
        phase: Number(m[1]),
        status: "merged",
      });
    }
  }
  return entries;
}

export function extractPlanNumber(planFile) {
  const base = basename(planFile);
  const match = base.match(/^(\d{1,4})-/);
  return match ? Number(match[1]) : null;
}

// Returns ALL files matching `NNN-*.md`. Callers fail-closed when a numeric
// prefix collides (botched rename / bad merge / duplicate doc). Sorted by
// filename for deterministic test output (Codex P2 on PR #96 line 1364).
export function findPaddedFiles(dir, ref) {
  const padded = String(ref).padStart(3, "0");
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(`${padded}-`) && f.endsWith(".md"))
      .sort()
      .map((f) => resolve(dir, f));
  } catch {
    return [];
  }
}

// Returns ALL paths under `dir` whose basename matches `filename`, recursing
// through `contracts/` / `schemas/` subdirs the cites omit. Callers fail-closed
// when a filename collides across subdirs (Codex P2 on PR #96 line 1364).
export function findArchDocFiles(dir, filename) {
  const out = [];
  function walk(d) {
    try {
      const entries = readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) walk(resolve(d, e.name));
        else if (e.name === filename) out.push(resolve(d, e.name));
      }
    } catch {
      /* ignore unreadable subdirs */
    }
  }
  walk(dir);
  return out.sort();
}

export function extractAdrStatus(source) {
  // Markdown table cell:  | **Status** | accepted |  (or `accepted`)
  const tableMatch = source.match(/\|\s*\*?\*?Status\*?\*?\s*\|\s*`?([\w-]+)`?\s*\|/i);
  if (tableMatch) return tableMatch[1].toLowerCase();
  // Bold-field forms: `**Status:** accepted` (colon inside markers) or
  // `**Status**: accepted` (colon outside). The `Status:?\*\*` allows either.
  const fieldMatch = source.match(/\*\*Status:?\*\*\s*:?\s*`?([\w-]+)`?/i);
  if (fieldMatch) return fieldMatch[1].toLowerCase();
  return null;
}

// Extract the `#### Tasks` block content (without the heading) from a phase
// section. Returns null when the phase has no Tasks block. Factored out so
// extractDeclaredTaskIds and the audit_status:substrate_exempt resolver can
// both slice the same region without re-implementing the heading boundary
// logic.
export function extractTasksBlock(phaseSection) {
  const tasksMatch = phaseSection.match(/####\s*Tasks\s*\n([\s\S]*?)(?=\n####\s|\n###\s|$)/);
  return tasksMatch ? tasksMatch[1] : null;
}

// Extract declared task ids from a phase's `#### Tasks` block. Returns a
// sorted unique array. Handles both audit-Tasks-block layouts:
//   Pattern A: sub-header form     `##### T1.1 — title`
//   Pattern B: bullet+bold inline  `- **T-007p-1-1** (Files: ...)`
// Both patterns coexist across the corpus (Plan-001 phases use A;
// Plan-007 partial phases use B); the audit runbook treats them as
// equivalent and Gate 3's set-comparison must accept both.
export function extractDeclaredTaskIds(phaseSection) {
  const block = extractTasksBlock(phaseSection);
  if (block === null) return [];
  const ids = new Set();
  // (?=[-\d]) pins the task-id SHAPE: a digit (T1.1) or hyphen (T-100-1.1)
  // must follow T — otherwise prose bolds/headings starting with T ("Test",
  // "Testing") phantom-match, and a phantom declared id makes Gate 3 see the
  // phase as never fully shipped (auto-walk re-enters shipped work — Codex P1,
  // PR #190, reproduced on Plan-003 Phase 1).
  for (const m of block.matchAll(/^#####\s+(T(?=[-\d])[-a-zA-Z0-9.]+)\b/gm)) ids.add(m[1]);
  // Two bullet shapes: `- **T-100-1.1** — title` (bold closes after the id)
  // and `- **T1.1 — title**` (em-dash + title INSIDE the bold — the shape
  // audited plans like Plan-009/016 use). [^*\n]* spans the intra-bold tail.
  // Optional GFM checkbox (`- [ ] **T21.1-1 — …**`) — Plan-021's row shape.
  for (const m of block.matchAll(
    /^-\s+(?:\[[ xX]\]\s+)?\*\*(T(?=[-\d])[-a-zA-Z0-9.]+)\b[^*\n]*\*\*/gm,
  ))
    ids.add(m[1]);
  return [...ids].sort();
}

// --- Size classification (design memo §5, 2026-07-06 refinement) ---
// S: ≤1 declared task. M: 2-3 tasks whose Files: paths sit in one top-level
// packages/<name> | apps/<name> root (non-code paths don't count against it).
// L: everything else. Drives G4 strictness here and the ceremony map in
// SKILL.md § Size-Classed Ceremony; Codex + CI are invariant across classes.
export function classifyPhaseSize(declaredTaskIds, targetPaths) {
  // FAIL CLOSED on zero parsed IDs: an empty list means the extractor did not
  // recognize the Tasks-block shape (not that the phase is small) — classify L
  // so an unrecognized future shape gets the FULL ceremony, never a skipped
  // reviewer set + demoted G4 (Codex P1, PR #190).
  if (declaredTaskIds.length === 0) return "L";
  if (declaredTaskIds.length <= 1) return "S";
  if (declaredTaskIds.length <= 3) {
    // FAIL CLOSED on zero parsed paths (mirror of the zero-IDs rule above):
    // with no Files: targets parsed, single-root confinement is UNPROVEN —
    // M is earned only by parsed paths sitting in at most one code root
    // (docs-only phases keep M: paths parsed, none code). Codex, PR #190:
    // Plan-021 Phase 4 has three task rows with no Files: fields.
    if (targetPaths.length === 0) return "L";
    const roots = new Set();
    for (const p of targetPaths) {
      const m = /^(packages\/[^/]+|apps\/[^/]+)\//.exec(p);
      if (m) roots.add(m[1]);
    }
    if (roots.size <= 1) return "M";
  }
  return "L";
}

// Files: extractor over both audit-Tasks-block layouts (sub-header bold field
// + parenthesized inline). Path-shaped tokens only; dedup, order-stable.
export function extractDeclaredFilePaths(phaseSection) {
  const paths = [];
  // Capture to the next task-metadata separator (`;`) or end of line — NOT the
  // first `)`: inline annotations like `a.ts (CREATE) + b.ts` would truncate
  // the clause and drop the second root (Codex, PR #190).
  const fieldRe = /\bFiles:\s*([^\n;]+)/g;
  let m;
  while ((m = fieldRe.exec(phaseSection)) !== null) {
    for (const token of m[1].split(/[,\s]+/)) {
      // Trailing sentence punctuation (`pty-host.ts\`.`) would fail the path
      // regex and silently drop the package root from classification. Markup
      // strip is EDGE-anchored so glob stars inside a path survive.
      const cleaned = token
        .replace(/^[`*([]+/, "")
        .replace(/[`*.,;:!?)\]]+$/, "")
        .trim();
      // Path-shaped = 2+ slash-joined segments; files, directories (trailing
      // slash), and globs all count — a directory target like
      // `packages/runtime-daemon/src/ipc/handlers/` is root-bearing evidence
      // for classification even without a filename extension (Codex, PR #190).
      if (/^[\w.@-]+(\/[\w.@*-]+)+\/?$/.test(cleaned) && !paths.includes(cleaned))
        paths.push(cleaned);
    }
  }
  return paths;
}

// Extract §5 (Canonical Build Order) from cross-plan-dependencies.md. Used by
// the cross_plan_carve_out and audit_status:substrate_exempt resolvers to
// scope membership checks to §5 only — pre-fix cross_plan_carve_out used a
// bare `source.includes(ref)` substring match, which passed when the ref
// appeared anywhere in the file (e.g., §3 prose, §6 NS-rows) even if §5 had
// no entry. Returns the §5 slice (from its heading line through the
// character before the next `^## ` heading), or null when §5 is missing.
//
// Heading shape supports both `## 5. Canonical Build Order` (dot-then-space
// form — the current shape) and `## Section 5 — ...` (defensive alternative).
// The `\b` lives inside the `Section 5` alternative only: putting it after
// `5\.` would look for a word boundary between `.` (non-word) and ` `
// (non-word) and fail to match.
export function extractSection5(xplanSource) {
  const startRe = /^##\s+(?:5\.\s|Section\s+5\b).*$/m;
  const startMatch = startRe.exec(xplanSource);
  if (!startMatch) return null;
  const startIdx = startMatch.index;
  const after = xplanSource.slice(startIdx + startMatch[0].length);
  const nextRe = /^##\s+/m;
  const nextMatch = nextRe.exec(after);
  const endIdx = nextMatch ? startIdx + startMatch[0].length + nextMatch.index : xplanSource.length;
  return xplanSource.slice(startIdx, endIdx);
}

// Extract a single backlog item's section — its `### BL-NNN` / `#### BL-NNN`
// heading (active backlog uses h3, the archive uses h4) through the line before
// the next ATX heading or `---` horizontal rule — or null if the item heading
// is absent. Heading-anchored (not a bare substring) with the same
// scoped-not-loose rigor as extractSection5: a `[BL-NNN](…)` cross-reference or
// a mention inside a neighbor item's prose must not be mistaken for the item
// itself, so the Status read in the bl_closed resolver comes only from the
// item's own block. `\b` after the id rejects longer-number collisions
// (BL-140 must not match a BL-1400 heading).
export function extractBacklogItemSection(source, blId) {
  const lines = source.split("\n");
  const headingRe = new RegExp(`^#{2,4}\\s+${blId}\\b`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+\S/.test(lines[i]) || /^---\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// Judge whether a backlog item's section (as returned by
// extractBacklogItemSection) represents work that actually landed: its Status
// line must read `completed`. Returns { ok: true } or { ok: false, reason }
// where reason is "unparseable" or the lowercased non-completed status. Shared
// by the bl_closed resolver's active-backlog AND archive paths so the two
// cannot drift — the archive is NOT a completed-only location (e.g. BL-136 is
// `withdrawn` there), so heading presence in the archive must never by itself
// imply the dependency closed (Codex P2 on PR #138).
function judgeBacklogCompletion(section) {
  const statusMatch = section.match(/^[-*]\s*Status:\s*`?(\w+)`?/m);
  if (!statusMatch) return { ok: false, reason: "unparseable" };
  const status = statusMatch[1].toLowerCase();
  if (status === "completed") return { ok: true };
  return { ok: false, reason: status };
}

// Extract the set of task ids shipped for a given phase from the parsed
// manifest. Single-string `task` and array-form `task` (legacy multi-task
// PRs predating NS-02) both contribute their ids. Returns a Set.
export function shippedTaskIdsForPhase(manifest, phaseNumber) {
  const out = new Set();
  if (!manifest || !manifest.ok) return out;
  for (const e of manifest.shipped) {
    if (e.phase !== phaseNumber) continue;
    if (Array.isArray(e.task)) for (const t of e.task) out.add(t);
    else if (typeof e.task === "string" && e.task.trim() !== "") out.add(e.task);
  }
  return out;
}

// ---------- IO layer (stubbable) ----------

let _ghImpl = (cmd) => execSync(cmd, { encoding: "utf8", cwd: REPO_ROOT });

export function setGhImpl(impl) {
  _ghImpl = impl;
}
export function resetGhImpl() {
  _ghImpl = (cmd) => execSync(cmd, { encoding: "utf8", cwd: REPO_ROOT });
}

function runGh(cmd) {
  try {
    return { ok: true, out: _ghImpl(cmd) };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// ---------- gates ----------

export function gateProjectLocality({ repoRoot = REPO_ROOT, skillMd = SKILL_MD } = {}) {
  let skillSource;
  try {
    skillSource = readFileSync(skillMd, "utf8");
  } catch (e) {
    return {
      ok: false,
      halt: `## Preflight halt: skill SKILL.md unreadable\n\n${skillMd}: ${e.message}`,
    };
  }
  const fm = parseFrontmatter(skillSource);
  const required = fm.requires_files || [];
  if (required.length === 0) return { ok: true };
  const missing = required.filter((p) => !existsSync(resolve(repoRoot, p)));
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    halt: [
      "## Preflight halt: project-locality",
      "",
      "The plan-execution skill expects an ai-sidekicks-shaped repo with these files:",
      ...required.map((p) => `  - ${p}`),
      "",
      "Missing from this repo:",
      ...missing.map((p) => `  - ${p}`),
      "",
      "Re-run from a repo with these surfaces, or fork the skill and amend the",
      "`requires_files:` frontmatter at .claude/skills/plan-execution/SKILL.md.",
    ].join("\n"),
  };
}

// Top-level audit-completeness gate. Lenient by design: passes when EITHER
// the plan-level checkbox is ticked OR any phase declares per-phase
// audit_status (the substrate-vs-namespace carve-out path). The strict
// per-phase enforcement happens inside _checkPhase via gatePhaseAuditCheckbox
// after the target phase is resolved — top-level lenience is what lets
// Plan-023's Phase 1 dispatch even though Tier 8 remainder phases haven't
// been authored with audit_status YAML yet. See docs/operations/
// plan-implementation-readiness-audit-runbook.md §Per-Phase Audit Semantics.
export function gateAuditCheckbox(planSource, planFile) {
  if (extractAuditCheckbox(planSource)) return { ok: true };
  if (/type:\s*audit_status\b/.test(planSource)) return { ok: true };
  return {
    ok: false,
    halt: [
      "## Preflight halt: audit-complete gate failed",
      "",
      `Plan ${planFile} has no plan-level audit-complete checkbox AND no phase`,
      `declares a per-phase \`audit_status\` precondition. The Status Promotion`,
      `Gate from docs/operations/plan-implementation-readiness-audit-runbook.md`,
      `blocks code-execution dispatch on un-audited plans.`,
      "",
      "Either complete the plan-readiness audit (runbook procedure) and tick the",
      "checkbox, OR declare an `audit_status` precondition entry on the phase",
      "being dispatched (runbook §Per-Phase Audit Semantics).",
    ].join("\n"),
  };
}

// Gate 6 — manifest freshness. Plan-level: numbered by accretion order (Gates
// 1-5 keep their historical numbers — docs, tests, and halt messages reference
// them by number), but EXECUTED between Gate 2 and the per-phase walk, because
// a stale manifest corrupts Gate 3's declared-vs-shipped set comparison (a
// merged-but-unrecorded shipment re-opens an already-shipped phase).
//
// This is NOT a return to the pre-Commit-3 gh-search shipment inference that
// the manifest refactor removed (see preflight-contract.md §Gate 3 "Why
// manifest set-comparison, not gh search"). The manifest remains the sole
// authority for phase selection; gh is consulted only to cross-check manifest
// COMPLETENESS — the BL-110 doctrine that ground truth stays git and the
// manifest is a cache. Three deliberate narrowings keep the old false-match
// classes out: (1) `in:title` only — never `in:title,body` (PR bodies cite
// plans in passing constantly; titles cite the plan they ship for — empirical
// sweep 2026-07-06: title-search precision was exact across all 27 plans);
// This recall trade IS the enhancement-lane boundary (CONTRIBUTING.md §How Code
// Lands): lane-2 enhancement and lane-3 tooling PRs deliberately omit the token,
// so they are invisible to this gate BY DESIGN — only lane-1 plan-task shipments
// participate in manifest freshness.
// (2) only PRs whose diff touches a MATERIAL_PATH_PREFIXES path count —
// packages/ + apps/ are the ownership map's code families, and .github/ covers
// workflow-only shipments (Plan-024 T-024-4-1 ships sidecar-build.yml alone;
// Codex P2 on PR #182). The inverted form (material = anything outside docs/)
// was rejected on corpus evidence: governance PRs whose titles cite plans also
// touch root files (PR #1 ships .gitignore/README.md/AGENTS.md under a
// Plan-001 title), so exclude-docs would permanently false-halt Plan-001;
// (3) a missing entry HALTS
// with the rebuild tool as remediation — the gate never derives or writes
// manifest entries itself (rebuild's operator-confirmation model owns phase /
// task attribution ambiguity).
//
// Fail-closed contract (ADR-023 gate-vs-detector discipline: gates fail
// closed, detectors warn): gh unreachable, malformed output, fetch
// saturation, and file-list truncation all HALT rather than pass. The
// explicit CLI escape is --allow-stale-manifest (skip is logged to stderr).
export const FRESHNESS_FETCH_LIMIT = 100;
export const MATERIAL_PATH_PREFIXES = ["packages/", "apps/", ".github/"];

export function gateManifestFreshness(planSource, planNumber) {
  const manifest = parseManifestBlock(planSource);
  // Structural manifest defects halt in Gate 3 with richer remediation text;
  // freshness only cross-checks a manifest that already parses. Future-schema
  // manifests stay opaque per the lib/manifest.mjs fail-open policy.
  if (!manifest.ok) return { ok: true, reason: "deferred_to_gate3" };
  if (manifest.version > MANIFEST_SCHEMA_VERSION) {
    return { ok: true, reason: "manifest_future_schema" };
  }
  const manifestPrs = new Set(manifest.shipped.map((entry) => entry.pr));
  const paddedPlan = String(planNumber).padStart(3, "0");
  const listRun = runGh(
    `gh pr list --state merged --search "Plan-${paddedPlan} in:title" ` +
      `--json number,title,mergedAt --limit ${FRESHNESS_FETCH_LIMIT}`,
  );
  if (!listRun.ok) return ghUnreachableHalt(paddedPlan, listRun.error);
  let merged;
  try {
    merged = JSON.parse(listRun.out);
  } catch (e) {
    return ghMalformedHalt(paddedPlan, `gh pr list output is not JSON: ${e.message}`);
  }
  if (!Array.isArray(merged)) {
    return ghMalformedHalt(paddedPlan, "gh pr list output is not a JSON array");
  }
  if (merged.length === FRESHNESS_FETCH_LIMIT) {
    return {
      ok: false,
      kind: "freshness_fetch_saturated",
      halt: [
        "## Preflight halt: manifest-freshness fetch saturated (Gate 6)",
        "",
        `gh pr list returned exactly ${FRESHNESS_FETCH_LIMIT} matches for`,
        `"Plan-${paddedPlan} in:title" — the result MAY be truncated, so manifest`,
        "completeness cannot be cross-checked. Raise FRESHNESS_FETCH_LIMIT in",
        "preflight.mjs (mirroring rebuild-shipment-manifest.mjs's FETCH_LIMIT",
        "anti-silent-truncation discipline) and re-run.",
      ].join("\n"),
    };
  }
  const stale = [];
  for (const pullRequest of merged) {
    if (manifestPrs.has(pullRequest.number)) continue;
    const viewRun = runGh(`gh pr view ${pullRequest.number} --json files,changedFiles`);
    if (!viewRun.ok) return ghUnreachableHalt(paddedPlan, viewRun.error);
    let details;
    try {
      details = JSON.parse(viewRun.out);
    } catch (e) {
      return ghMalformedHalt(
        paddedPlan,
        `gh pr view ${pullRequest.number} output is not JSON: ${e.message}`,
      );
    }
    const files = Array.isArray(details.files) ? details.files : [];
    if (typeof details.changedFiles === "number" && files.length < details.changedFiles) {
      return {
        ok: false,
        kind: "freshness_files_truncated",
        halt: [
          "## Preflight halt: manifest-freshness file list truncated (Gate 6)",
          "",
          `gh pr view ${pullRequest.number} returned ${files.length} of`,
          `${details.changedFiles} changed files — the GraphQL files(first: 100)`,
          "ceiling truncated the list, so the material-path classification for",
          `PR #${pullRequest.number} cannot be trusted (mirrors`,
          "rebuild-shipment-manifest.mjs exit-7 discipline). Classify the PR",
          "manually, reconcile the manifest, and re-run — or bypass explicitly",
          "with --allow-stale-manifest.",
        ].join("\n"),
      };
    }
    const materialFileCount = files.filter(
      (f) =>
        typeof f.path === "string" &&
        MATERIAL_PATH_PREFIXES.some((prefix) => f.path.startsWith(prefix)),
    ).length;
    if (materialFileCount > 0) {
      stale.push({
        number: pullRequest.number,
        title: pullRequest.title,
        mergedAt: pullRequest.mergedAt,
        materialFileCount,
      });
    }
  }
  if (stale.length === 0) return { ok: true };
  return {
    ok: false,
    kind: "manifest_stale",
    stale,
    halt: [
      "## Preflight halt: shipment manifest is stale (Gate 6 — manifest freshness)",
      "",
      `Plan-${paddedPlan}'s ### Shipment Manifest has no entry for ${stale.length} merged`,
      `material PR(s) whose title cites Plan-${paddedPlan} (diff touches`,
      `${MATERIAL_PATH_PREFIXES.join(" / ")}):`,
      "",
      ...stale.map(
        (p) =>
          `  - PR #${p.number} (merged ${String(p.mergedAt ?? "").split("T")[0]}, ` +
          `${p.materialFileCount} material file(s)): ${p.title}`,
      ),
      "",
      "Gate 3 selects the next phase by comparing declared tasks against this",
      "manifest; a missing entry can re-open an already-shipped phase and",
      "re-dispatch completed work. Ground truth stays git — the manifest is the",
      "cache (BL-110). Reconcile, then re-run preflight:",
      "",
      "  node --experimental-strip-types \\",
      "    .claude/skills/plan-execution/scripts/rebuild-shipment-manifest.mjs \\",
      `    --plan ${paddedPlan} --dry-run`,
      "",
      "Inspect the emitted entries, resolve operator-confirmation ambiguities",
      "(phase/task attribution), apply them to the plan file, and land the",
      "manifest edit through a PR. Emergency bypass (gh outage / offline):",
      "re-run preflight with --allow-stale-manifest (skip is logged to stderr).",
    ].join("\n"),
  };
}

function ghUnreachableHalt(paddedPlan, error) {
  return {
    ok: false,
    kind: "freshness_gh_unreachable",
    halt: [
      "## Preflight halt: manifest-freshness cross-check unavailable (Gate 6)",
      "",
      `gh failed while cross-checking Plan-${paddedPlan}'s manifest against merged`,
      `PRs: ${error}`,
      "",
      "Gate 6 fails closed (ADR-023 gate discipline): a manifest that cannot be",
      "cross-checked is treated as potentially stale rather than silently",
      "trusted. Fix gh (auth/network) and re-run, or bypass explicitly with",
      "--allow-stale-manifest (skip is logged to stderr).",
    ].join("\n"),
  };
}

function ghMalformedHalt(paddedPlan, detail) {
  return {
    ok: false,
    kind: "freshness_gh_malformed",
    halt: [
      "## Preflight halt: manifest-freshness cross-check unavailable (Gate 6)",
      "",
      `Unexpected gh output while cross-checking Plan-${paddedPlan}'s manifest:`,
      detail,
      "",
      "Gate 6 fails closed. Investigate the gh installation / API response and",
      "re-run, or bypass explicitly with --allow-stale-manifest.",
    ].join("\n"),
  };
}

// Strict per-phase audit gate, called inside _checkPhase after the target
// phase has been resolved. Passes when EITHER the plan-level checkbox is
// ticked OR THIS phase declares `type: audit_status` in its preconditions
// block. Pre-this-PR Gate 2 was plan-scoped (any checkbox anywhere); after
// the per-phase migration, a phase shipping under a substrate carve-out
// must carry its own audit_status YAML to admit itself for dispatch — a
// plan-level fail-open path would let Plan-023 Phase 2+ (Tier 8 remainder,
// not yet authored) dispatch through the lenient top-level OR-check.
export function gatePhaseAuditCheckbox(planSource, phaseSection, planFile, phaseNumber) {
  if (extractAuditCheckbox(planSource)) return { ok: true };
  if (/type:\s*audit_status\b/.test(phaseSection ?? "")) return { ok: true };
  return {
    ok: false,
    halt: [
      "## Preflight halt: per-phase audit declaration missing",
      "",
      `Plan ${planFile} has no plan-level audit-complete checkbox AND Phase`,
      `${phaseNumber} declares no \`audit_status\` precondition entry. The Status`,
      `Promotion Gate requires every dispatched phase to carry either the`,
      `plan-level audit-complete checkbox OR an explicit per-phase`,
      `\`audit_status\` declaration (runbook §Per-Phase Audit Semantics).`,
      "",
      "Either complete the plan-readiness audit and tick the plan-level checkbox,",
      "OR declare an `audit_status` precondition entry on this phase. Two values",
      "are permitted: `complete` (with evidence_pr + baseline_tag) or",
      "`substrate_exempt` (with carve_out_ref pointing to a §5 carve-out entry in",
      "docs/architecture/cross-plan-dependencies.md).",
    ].join("\n"),
  };
}

// Classify whether a phase has fully shipped. Shared by Gate 3 (this plan)
// and Gate 5 plan_phase resolver (upstream plan). Ordering is load-bearing:
// the manifest parse + version-future check fire BEFORE any structural
// inspection of the phase section, so a future v2 manifest that reshapes
// phase headings still fail-opens (treat-as-opaque semantic) instead of
// halting with "section not found".
//
// Result kinds:
//   - manifest_unparseable: parseManifestBlock returned !ok. Halt; this is
//     the loud-failure replacement for the silent-pass behavior Codex
//     flagged on PR #35 round 7 (a malformed manifest would otherwise
//     re-open Gate 3 and re-dispatch already-shipped phases).
//   - manifest_invalid_entries: parseManifestBlock returned ok but at least
//     one shipped[] entry fails validateEntry. Halt; pre-round-8 the
//     classifier trusted parseManifestBlock and read fields directly, so
//     type/shape errors (e.g. `phase: "5"` as string, missing `task`,
//     unknown field names) silently produced an incomplete shipped-tasks
//     set and re-opened Gate 3 (Codex P2 finding on PR #35 round 8).
//   - manifest_future_schema: version > MANIFEST_SCHEMA_VERSION. Fail open
//     per lib/manifest.mjs schema-version policy.
//   - no_phase_section: the requested phase isn't declared in the plan.
//   - no_declared_tasks: phase exists but its #### Tasks block has no task
//     ids in either the sub-header (`##### T1.1`) or bullet+bold
//     (`- **T-007p-1-1**`) form.
//   - partially_shipped: at least one declared task isn't in the shipped
//     set. Carries `missing` so callers can render diagnostics.
//   - fully_shipped: every declared task appears in the shipped set.
export function classifyPhaseShipment(planSource, phaseNumber) {
  const manifest = parseManifestBlock(planSource);
  if (!manifest.ok) return { kind: "manifest_unparseable", reason: manifest.reason };
  if (manifest.version > MANIFEST_SCHEMA_VERSION) {
    return { kind: "manifest_future_schema", version: manifest.version, manifest };
  }
  // Schema-validate every shipped[] entry before reading fields. Skipping this
  // would let `phase: "5"` (string) silently miss the `e.phase === phaseNumber`
  // check, dropping that entry from the shipped-tasks set and re-opening
  // Gate 3 for an already-shipped phase. Halt loudly with a per-index error
  // list instead.
  const entryErrors = [];
  for (let i = 0; i < manifest.shipped.length; i++) {
    const v = validateEntry(manifest.shipped[i]);
    if (!v.ok) entryErrors.push({ index: i, errors: v.errors });
  }
  if (entryErrors.length > 0) {
    return { kind: "manifest_invalid_entries", entryErrors, manifest };
  }
  const sec = extractPhaseSection(planSource, phaseNumber);
  if (!sec) return { kind: "no_phase_section", manifest };
  const declared = extractDeclaredTaskIds(sec);
  const phaseHasManifestEntry = manifest.shipped.some((e) => e.phase === phaseNumber);
  if (declared.length === 0) {
    return { kind: "no_declared_tasks", manifest, phaseHasManifestEntry };
  }
  const shipped = shippedTaskIdsForPhase(manifest, phaseNumber);
  const missing = declared.filter((t) => !shipped.has(t));
  if (missing.length === 0) {
    return { kind: "fully_shipped", declared, shipped: [...shipped], manifest };
  }
  return { kind: "partially_shipped", declared, shipped: [...shipped], missing, manifest };
}

// Gate 3 — phase un-shipped. Halts when the phase is fully shipped, or when
// the manifest can't be parsed (per Codex P1 finding on PR #35 round 7:
// silent fail-open on parse failure was a correctness regression in
// auto-walk mode — already-shipped phases would look unshipped after any
// manifest formatting error). Schema-version forward-compat (unknown future
// versions) remains the only intentional fail-open.
export function gatePhaseUnshipped(planSource, planNumber, phase) {
  const result = classifyPhaseShipment(planSource, phase.number);
  if (result.kind === "manifest_unparseable") {
    return {
      ok: false,
      kind: "manifest_unparseable",
      halt: [
        "## Preflight halt: shipment manifest unparseable",
        "",
        `Plan-${planNumber} has a malformed or missing ### Shipment Manifest block`,
        `(reason: ${result.reason}). Gate 3 cannot determine whether Phase ${phase.number}`,
        `("${phase.title}") is already shipped, so it halts rather than risk re-dispatching`,
        `a completed phase (Codex P1 finding on PR #35 round 7).`,
        "",
        "Reasons returned by parseManifestBlock:",
        "  - no_section: ### Shipment Manifest heading missing — plan was likely created",
        "    before the template update. Add the section per docs/plans/000-plan-template.md.",
        "  - no_yaml_fence: section exists but the ```yaml fenced block is missing or",
        "    truncated.",
        "  - missing_schema_version: fenced block exists but `manifest_schema_version: 1`",
        "    is absent.",
        "  - missing_shipped: schema-version present but the `shipped:` top-level key is",
        "    absent. Add `shipped: []` for an empty manifest, or list entries under it.",
      ].join("\n"),
    };
  }
  if (result.kind === "manifest_invalid_entries") {
    return {
      ok: false,
      kind: "manifest_invalid_entries",
      halt: [
        "## Preflight halt: shipment manifest entries fail schema validation",
        "",
        `Plan-${planNumber} ### Shipment Manifest YAML parses, but ${result.entryErrors.length}`,
        `entries fail validateEntry. Type/shape errors (e.g. \`phase: "5"\` as string,`,
        `missing \`task\`, unknown field names) silently produce an incomplete shipped-`,
        `tasks set, so Gate 3 halts to prevent re-dispatching an already-shipped phase`,
        `(Codex P2 finding on PR #35 round 8).`,
        "",
        "Per-entry errors:",
        ...result.entryErrors.flatMap((e) => [
          `  shipped[${e.index}]:`,
          ...e.errors.map((m) => `    - ${m}`),
        ]),
        "",
        "Fix the failing entries (schema authoritative in lib/manifest.mjs §validateEntry)",
        "and re-run preflight.",
      ].join("\n"),
    };
  }
  if (result.kind === "fully_shipped") {
    return {
      ok: false,
      kind: "fully_shipped",
      halt: [
        "## Preflight halt: phase already shipped",
        "",
        `Plan-${planNumber} Phase ${phase.number} ("${phase.title}") declared tasks`,
        `[${result.declared.join(", ")}] all appear in the shipment manifest. Pick the next`,
        `un-shipped phase, or override-supply a phase number for explicit-phase mode.`,
      ].join("\n"),
    };
  }
  return { ok: true };
}

// ---------- Gate 4 cite-anchor semantic verification ----------
//
// Layered on top of the existing token-presence Gate 4. The token check
// remains the floor (counts.spec_coverage / counts.verifies_invariant must
// each be ≥ 1); when present, the semantic check then parses each emitted
// cite and verifies its anchor against the named spec. Closes the
// verification side of the cite-discipline contract authored on the
// dispatch side in `docs/operations/plan-implementation-readiness-audit-runbook.md`
// §Subagent Prompt Template (post-mortem 51ca5f3d).
//
// Pipeline order is load-bearing: Unicode dashes (en-dash U+2013 `–`,
// em-dash U+2014 `—`) are normalised to ASCII `-` BEFORE tokenisation or
// pattern-match. Without this the compound-range rejection rule misses
// `lines 85–86`-shape defects (Plan-002 T3.3 form).

const UNICODE_DASH_RE = /[–—]/g;

export function normalizeCitePayload(text) {
  return text.replace(UNICODE_DASH_RE, "-");
}

// Identifier-token: CamelCase (`PresenceUpdate`), dotted (`presence.heartbeat`),
// or all-caps acronym joined via hyphen (`JSON-RPC` is matched as two tokens
// `JSON` + `RPC`, which is fine for compound-range multi-subject detection
// because we count distinct CamelCase identifiers, not acronym fragments).
const IDENTIFIER_TOKEN_RE =
  /\b([A-Z][a-zA-Z]+(?:[A-Z][a-zA-Z]*)*|[a-z][a-zA-Z]+\.[a-zA-Z][a-zA-Z.]*)\b/g;

// Plan-local row IDs span simple (`C5`, `P1`, `I1`), structured
// (`I-024-3`, `Pr-1`), and multi-invariant range (`I-024-1..5`) forms per
// Pre-3 implication 6 of the post-mortem fix plan. Used both for detecting
// Plan-local-ID-as-Spec-anchor defects AND for filtering subject candidates
// extracted from descriptors.
const PLAN_LOCAL_ID_RE = /^(?:C|P|Pr|I)-?\d+(?:\.\.\d+)?(?:-\d+(?:\.\.\d+)?)*$/;

// Plan-NNN:LLL — colon-line-number form. The discriminator from Pre-3
// implication 3: this shape is the namespace-violation defect when it
// appears inside a Spec-NNN parenthetical. `Plan-NNN §Section` (no colon)
// is the legitimate cross-plan-context shape and is NOT flagged.
const PLAN_LINE_CITE_RE = /\bPlan-\d+:\d+\b/;

export function extractIdentifierTokens(text) {
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(IDENTIFIER_TOKEN_RE)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

// Namespace prefixes (`Plan-021`, `Spec-002`, `ADR-018`) are cross-reference
// markers, not contract subjects. Strip them before identifier extraction so
// `Plan` doesn't surface as a false-positive subject when a descriptor cites
// another doc (e.g., `... per Plan-021 §RateLimitResponse canonical shape`).
const NAMESPACE_PREFIX_RE = /\b(?:Plan|Spec|ADR)-\d+\b/g;

// Subject tokens are identifier-tokens with namespace-prefix markers stripped
// (Plan-NNN/Spec-NNN/ADR-NNN) and Plan-local row IDs filtered out. Used to
// pick the "what does this anchor point at" subject from a paren descriptor
// like `(I3 — ChannelList bootstrap projection)` → ChannelList.
function nonPlanLocalSubjects(text) {
  const stripped = text.replace(NAMESPACE_PREFIX_RE, "");
  return extractIdentifierTokens(stripped).filter((t) => !PLAN_LOCAL_ID_RE.test(t));
}

// Paren-aware split on top-level segment boundaries. Two boundaries:
//   - `;` at depth 0 (canonical cross-namespace separator,
//     `Spec-001 AC8; ADR-018 §Decision #4`)
//   - `,` at depth 0 followed by another recognized namespace prefix.
//     Recognized starts: `Spec-NNN`, `ADR-NNN`, plan-local-id (`Cn`/`Pn`/
//     `Pr-n`/`In` or structured `I-NNN-N`), `none` literal, `<file>.md`,
//     `cross-plan-deps`. Without the plan-local-id branch, comma-separated
//     invariant lists (`Verifies invariant: I-024-1, I-024-2, ...` or
//     `; P1, P2, P3`) fold into a single anchor whose descriptor swallows
//     the trailing IDs and silently passes the gate (Codex P1 on PR #96
//     line 620). Longer alternations precede shorter ones so `Pr` is
//     tried before `P`.
const TOP_LEVEL_NS_LOOKAHEAD =
  /^,\s+(?:Spec-\d+|ADR-\d+|(?:Pr|C|P|I)-?\d+|none\b|[a-z][\w-]*\.md|cross-plan-deps)\b/;

// Depth tracking covers parens, square brackets, AND curly braces. The brace
// case is load-bearing because TS-object-literal descriptors like
// `{deviceType, focusedSessionId, lastActivityAt}` carry top-level commas
// that would otherwise be treated as anchor separators (Codex P1 on PR #96
// line 873; Plan-002 T1.3 regression).
function bracketDelta(ch) {
  if (ch === "(" || ch === "[" || ch === "{") return 1;
  if (ch === ")" || ch === "]" || ch === "}") return -1;
  return 0;
}

function splitOnSemicolon(payload) {
  const out = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i];
    const d = bracketDelta(ch);
    if (d !== 0) {
      depth += d;
      buf += ch;
    } else if (depth === 0 && ch === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    } else if (depth === 0 && ch === "," && TOP_LEVEL_NS_LOOKAHEAD.test(payload.slice(i))) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// Bracket-aware split on `,` and whitespace-bounded ` + ` at depth 0. Tracks
// `()`, `[]`, AND `{}` so TS-object-literal descriptors (`{deviceType, ...}`)
// don't break sub-anchor splitting. Applied after the namespace prefix is
// stripped so commas/pluses inside the remainder become sub-anchor
// separators (`AC1 (line 178), AC2 (line 179)` → two anchors; `line 87 +
// AC1` → two anchors).
function splitWithinNamespace(text) {
  const out = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const d = bracketDelta(ch);
    if (d !== 0) {
      depth += d;
      buf += ch;
    } else if (depth === 0 && ch === ",") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    } else if (depth === 0 && ch === "+") {
      const prev = i > 0 ? text[i - 1] : "";
      const next = i + 1 < text.length ? text[i + 1] : "";
      if (/\s/.test(prev) || /\s/.test(next)) {
        if (buf.trim()) out.push(buf.trim());
        buf = "";
      } else {
        buf += ch;
      }
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// Gate 4 failures carry a severity. `error` blocks the gate (the seven
// post-mortem defect classes — subject mismatch, compound-range, namespace
// violation, Plan-local-ID-as-Spec-anchor, phantom section, file missing,
// out-of-range line). `warn` is informational and never blocks; it covers
// shapes the parser cannot recognize without falsely rejecting legitimate
// cite shapes in already-approved plans. The mandate is to catch the seven
// known defect classes, not to police every cite shape.
function makeFailure(kind, raw, message, remediation, severity = "error") {
  return { kind, raw, message, remediation, severity };
}

// Parse one Spec-NNN segment (after the top-level `;` split). Returns
// {anchors: [...], failures: [...]}. The segment may contain a §Section
// prefix, multiple sub-anchors (line / AC / line+AC / lines-range /
// lines-list), and trailing descriptors in parens. The four mechanism
// rejection classes from the runbook strengthened template fire here:
// compound-range with multi-subject descriptor, Plan-NNN:LLL inside
// descriptor, Plan-local-ID at first anchor position, phantom-section
// (verified later by verifyAnchorAgainstSpec).
function parseSpecSegment(segment) {
  const nsMatch = segment.match(/^Spec-(\d+)\b\s*(.*)$/s);
  if (!nsMatch) {
    return {
      anchors: [],
      failures: [
        makeFailure(
          "spec-namespace-malformed",
          segment,
          `Spec namespace prefix malformed in '${segment}'.`,
          "Use the shape `Spec-NNN ...` where NNN is the 3-digit spec id.",
        ),
      ],
    };
  }
  const spec = Number(nsMatch[1]);
  const rest = nsMatch[2].trim();

  // Sweep the entire segment for the namespace-violation defect (Plan-NNN:LLL
  // inside any descriptor or position). Applies regardless of which sub-anchor
  // the violation sits within.
  const failures = [];
  if (PLAN_LINE_CITE_RE.test(segment)) {
    const match = segment.match(/\bPlan-\d+:\d+\b/);
    failures.push(
      makeFailure(
        "namespace-violation",
        segment,
        `'${match[0]}' is a Plan-NNN line cite inside a Spec-${spec} cite. Cross-plan line-anchors do not belong in Spec coverage.`,
        "Move cross-plan context into Files / Goal / Implementation Notes. Plan-NNN §Section (no colon-line-number) is the legitimate cross-plan parenthetical shape.",
      ),
    );
  }

  // Section-prefix detection. `§<Heading>` after the namespace and before the
  // first `line/lines/AC` keyword. The greedy boundary makes the section
  // capture stop at the keyword.
  let section = null;
  let body = rest;
  const sectionMatch = body.match(/^§([^,;+]+?)(?=\s+(?:lines?|AC\d)|\s*$|\s*\()/);
  if (sectionMatch) {
    section = sectionMatch[1].trim();
    body = body.slice(sectionMatch[0].length).trim();
  }

  // Section-only form: `Spec-NNN §Section` (no lines / AC after).
  // Optionally followed by `(<descriptor>)`. Pass with a WARN — line anchor
  // is recommended but not required.
  if (section && (body === "" || /^\(/.test(body))) {
    return {
      anchors: [
        {
          type: "section-only",
          spec,
          section,
          descriptor: body,
          warn: "line anchor recommended for §Section-only cite",
          raw: segment,
        },
      ],
      failures,
    };
  }

  // First-anchor-position Plan-local-ID defect: bare token immediately after
  // `Spec-NNN ` (no `line`/`lines`/`AC`/`§` keyword) that matches a Plan-local
  // pattern (Cn / Pn / Pr-n / In). Discriminator vs pass case 10 (C5 (Spec-002 ...)):
  // here the Plan-local-ID sits in the namespace-prefix position; in pass case
  // 10 the segment STARTS with the Plan-local-ID and Spec lives inside a paren.
  const firstToken = body.match(/^([\w-]+)\b/);
  if (
    !section &&
    firstToken &&
    PLAN_LOCAL_ID_RE.test(firstToken[1]) &&
    !/^(AC\d|line|lines)/.test(body)
  ) {
    failures.push(
      makeFailure(
        "plan-local-id-as-spec-anchor",
        segment,
        `Plan-local row ID '${firstToken[1]}' cited as a Spec-${spec} anchor.`,
        `Reverse the framing: '${firstToken[1]} (Spec-${spec} line YY — descriptor)'. Plan-local row IDs (Cn / Pn / Pr-n / In) are not Spec anchors.`,
      ),
    );
    return { anchors: [], failures };
  }

  // Multi-line list (bare with optional shared trailing descriptor):
  // `lines N1, N2, N3` or `lines N1, N2, N3 (shared-descriptor)`. Detected
  // before the generic comma-split so we keep the `lines` keyword attached
  // to each emitted anchor and preserve the shared-descriptor semantics
  // for `RateLimitResponse canonical shape` and friends.
  const bareMultiLineMatch = body.match(/^lines\s+(\d+(?:\s*,\s*\d+)+)\s*(?:\((.*)\))?$/);
  if (bareMultiLineMatch) {
    const lineNums = bareMultiLineMatch[1].split(/\s*,\s*/).map((n) => Number(n));
    const descriptor = bareMultiLineMatch[2] ?? "";
    const subjects = nonPlanLocalSubjects(descriptor);
    const anchors = lineNums.map((line) => ({
      type: "line",
      spec,
      line,
      section,
      subject: subjects.length === 1 ? subjects[0] : null,
      descriptor,
      raw: segment,
    }));
    return { anchors, failures };
  }

  // Multi-line list with per-line descriptors: `lines N1 (desc1), N2
  // (desc2), N3 (desc3)`. Required to accept Plan-002 T2.1 / T2.2 shapes
  // already on develop — `Spec-002 §Token Security Properties lines 110
  // (Entropy/CSPRNG), 111 (hash storage), 113 (Token payload structure)`
  // (Codex P1 on PR #96 line 873). Brace-aware splitWithinNamespace
  // handles TS-object-literal descriptors. Requires ≥2 entries so we
  // don't conflict with `lines N (subject)` typo cases for single lines.
  const linesKeywordMatch = body.match(/^lines\s+(.+)$/);
  if (linesKeywordMatch) {
    const tailTokens = splitWithinNamespace(linesKeywordMatch[1].trim());
    if (tailTokens.length >= 2) {
      const entries = [];
      let allParseable = true;
      for (const tok of tailTokens) {
        const m = tok.match(/^(\d+)(?:\s*\((.*)\))?\s*$/);
        if (!m) {
          allParseable = false;
          break;
        }
        entries.push({ line: Number(m[1]), descriptor: (m[2] ?? "").trim() });
      }
      if (allParseable) {
        const anchors = entries.map(({ line, descriptor }) => {
          const subjects = nonPlanLocalSubjects(descriptor);
          return {
            type: "line",
            spec,
            line,
            section,
            subject: subjects[0] ?? null,
            descriptor,
            raw: segment,
          };
        });
        return { anchors, failures };
      }
    }
  }

  // General split on `,` and ` + ` for everything else (AC, line, line+AC).
  // Descriptor forms accepted: `(parens)` OR ` - dash-separated` (the latter
  // appears inside nested plan-local-id paren wrappers like `C5 (Spec-002
  // line 15 — ChannelList)` where the inner em-dash normalizes to `-` and
  // the wrapping paren is already consumed by the plan-local-id parser).
  //
  // Section context tracking: `currentSection` starts at the top-level
  // `section` (from `§<Heading>` prefix before the keyword) and updates
  // whenever a sub-token begins with its own `§<Section>` qualifier.
  // `inLinesList` admits bare-digit continuation tokens (`111 (hash
  // storage)`) immediately after a `§Section lines <N> (desc)` sub-token —
  // required for Plan-002 T2.2-shape cites (Codex P1 on PR #96 line 873).
  const subTokens = splitWithinNamespace(body);
  const anchors = [];
  let currentSection = section;
  let inLinesList = false;
  for (const token of subTokens) {
    const acMatch = token.match(/^AC(\d+)(?:\s*\((.+)\)|\s+-\s+(.+?))?\s*$/);
    if (acMatch) {
      const ac = Number(acMatch[1]);
      const descriptor = (acMatch[2] ?? acMatch[3] ?? "").trim();
      const lineHint = descriptor.match(/\bline\s+(\d+)\b/);
      const subjects = nonPlanLocalSubjects(descriptor);
      anchors.push({
        type: "ac",
        spec,
        ac,
        lineHint: lineHint ? Number(lineHint[1]) : null,
        section: currentSection,
        subject: subjects.length === 1 ? subjects[0] : null,
        descriptor,
        warn: lineHint ? null : "line hint recommended (`AC-X (line NN)`)",
        raw: segment,
      });
      inLinesList = false;
      continue;
    }
    const lineMatch = token.match(/^line\s+(\d+)(?:\s*\((.+)\)|\s+-\s+(.+?))?\s*$/);
    if (lineMatch) {
      const line = Number(lineMatch[1]);
      const descriptor = (lineMatch[2] ?? lineMatch[3] ?? "").trim();
      const subjects = nonPlanLocalSubjects(descriptor);
      anchors.push({
        type: "line",
        spec,
        line,
        section: currentSection,
        subject: subjects[0] ?? null,
        descriptor,
        raw: segment,
      });
      inLinesList = false;
      continue;
    }
    // Range sub-token: `lines N1-N2 [(descriptor)]`, optionally re-sectioned
    // (`§<Section> lines N1-N2 (...)`). Sole range parser: a standalone
    // range body arrives here as one sub-token (splitWithinNamespace only
    // breaks on depth-0 commas), and mid-list ranges split correctly. A
    // former whole-body `^lines N1-N2 (.*)$` handler both missed mid-list
    // ranges (they halted as unparseable while the fallback message
    // advertised the shape as accepted) and greedy-swallowed list tails —
    // `lines 39-40 (a), 41 (b)` parsed as one range with descriptor
    // `a), 41 (b`, silently dropping line 41's coverage. Must precede the
    // single-line re-section branch: that branch's ` - dash-descriptor`
    // alternative would claim a spaced range (`§A lines 12 - 15`) as
    // line 12 with descriptor "15". Carries the compound-range
    // multi-subject rejection so one-anchor-per-behavior holds for every
    // range position.
    const rangeTokenMatch = token.match(
      /^(?:§([^()]+?)\s+)?lines\s+(\d+)\s*-\s*(\d+)\s*(?:\((.*)\))?$/,
    );
    if (rangeTokenMatch) {
      if (rangeTokenMatch[1]) {
        currentSection = rangeTokenMatch[1].trim();
      }
      const start = Number(rangeTokenMatch[2]);
      const end = Number(rangeTokenMatch[3]);
      const descriptor = (rangeTokenMatch[4] ?? "").trim();
      const subjects = nonPlanLocalSubjects(descriptor);
      if (subjects.length >= 2) {
        failures.push(
          makeFailure(
            "compound-range-multi-subject",
            token,
            `Compound range 'lines ${start}-${end}' covers distinct subjects (${subjects.join(", ")}); one-anchor-per-behavior is required.`,
            `Write 'line ${start} (${subjects[0]}), line ${end} (${subjects[1]})' instead of a range. Each Spec line that names a distinct contract gets its own anchor.`,
          ),
        );
        inLinesList = false;
        continue;
      }
      anchors.push({
        type: "line-range",
        spec,
        start,
        end,
        section: currentSection,
        subject: subjects[0] ?? null,
        descriptor,
        raw: segment,
      });
      inLinesList = true;
      continue;
    }
    // Re-section sub-anchor: `§<Section> line[s] YY[ (descriptor)]` inside a
    // comma-separated multi-section Spec cite (e.g., `Spec-002 §A line 12,
    // §B line 13` or `Spec-002 §A lines 12 (x), 13 (y), §B lines 20 (z)`).
    // Without this branch the second sub-token falls into the unparseable
    // fallback and the gate halts on shapes already in approved plans.
    const reSectionLineMatch = token.match(
      /^§([^()]+?)\s+(lines?)\s+(\d+)(?:\s*\((.+)\)|\s+-\s+(.+?))?\s*$/,
    );
    if (reSectionLineMatch) {
      currentSection = reSectionLineMatch[1].trim();
      const keyword = reSectionLineMatch[2];
      const line = Number(reSectionLineMatch[3]);
      const descriptor = (reSectionLineMatch[4] ?? reSectionLineMatch[5] ?? "").trim();
      const subjects = nonPlanLocalSubjects(descriptor);
      anchors.push({
        type: "line",
        spec,
        line,
        section: currentSection,
        subject: subjects[0] ?? null,
        descriptor,
        raw: segment,
      });
      inLinesList = keyword === "lines";
      continue;
    }
    // Bare-digit list continuation: only valid immediately after a
    // `§Section lines <N>` sub-token (`inLinesList === true`). Emits a line
    // anchor under the current section context. Without this, T2.2-shape
    // `§A lines 109 (x), 111 (y), 112 (z)` halts on the trailing entries.
    const bareLineMatch = token.match(/^(\d+)(?:\s*\((.+)\)|\s+-\s+(.+?))?\s*$/);
    if (inLinesList && bareLineMatch) {
      const line = Number(bareLineMatch[1]);
      const descriptor = (bareLineMatch[2] ?? bareLineMatch[3] ?? "").trim();
      const subjects = nonPlanLocalSubjects(descriptor);
      anchors.push({
        type: "line",
        spec,
        line,
        section: currentSection,
        subject: subjects[0] ?? null,
        descriptor,
        raw: segment,
      });
      continue;
    }
    failures.push(
      makeFailure(
        "unparseable-spec-subanchor",
        token,
        `Cannot parse '${token}' as a Spec-${spec} sub-anchor.`,
        "Accepted sub-shapes: `AC-N`, `AC-N (line MM)`, `line N`, `line N (subject)`, `line N - subject`, `lines N1, N2, N3`, `lines N1-N2 (single-subject)`, `§Section line N`, `§Section lines N1-N2 (single-subject)`.",
        "error",
      ),
    );
  }
  return { anchors, failures };
}

// ADR cite parser. Accepts `ADR-NNN`, `ADR-NNN §Section`, `ADR-NNN §Section
// item N`, `ADR-NNN §Section row N`, and any of these followed by a paren
// descriptor and/or trailing prose. Trailing prose is captured as-is; the
// recognized portion is the namespace + §Section + (optional) row/item.
function parseAdrSegment(segment) {
  // Capture: ADR-N, optional §Section (up to first `(` / EOL / row|item keyword),
  // optional row/item N, optional paren descriptor, ignore trailing prose.
  const m = segment.match(
    /^ADR-(\d+)\b(?:\s+§([^()]+?))?(?:\s+(?:row|item)\s+(\d+))?(?:\s*\(([^)]*)\))?(.*)$/,
  );
  if (!m) {
    return {
      anchors: [],
      failures: [
        makeFailure(
          "adr-unparseable",
          segment,
          `Cannot parse ADR cite '${segment}'.`,
          "Accepted: `ADR-NNN`, `ADR-NNN §Section`, `ADR-NNN §Section row N`, `ADR-NNN §Section item N`.",
          "warn",
        ),
      ],
    };
  }
  let section = (m[2] ?? "").trim() || null;
  // Strip the row|item phrase off the section capture if the section regex
  // absorbed it (e.g. `§Success Criteria row 2` may match the section as
  // `Success Criteria row 2` if the inner alternation didn't take effect).
  if (section) {
    const rowOrItem = section.match(/^(.+?)\s+(row|item)\s+(\d+)\s*$/);
    if (rowOrItem) section = rowOrItem[1].trim();
  }
  return {
    anchors: [
      {
        type: "adr-section",
        adr: Number(m[1]),
        section,
        row: m[3] ?? null,
        descriptor: m[4] ?? "",
        trailingProse: m[5]?.trim() ?? "",
        raw: segment,
      },
    ],
    failures: [],
  };
}

function parseArchDocSegment(segment) {
  // Accept trailing prose after the closing paren — legitimate descriptors
  // in approved plans include sentences after the anchor.
  const m = segment.match(/^([\w-]+\.md)(?:\s+§([^()]+?))?(?:\s*\(([^)]*)\))?(.*)$/);
  if (!m) {
    return {
      anchors: [],
      failures: [
        makeFailure(
          "arch-doc-unparseable",
          segment,
          `Cannot parse architecture-doc cite '${segment}'.`,
          "Accepted: `<file>.md`, `<file>.md §Section`, `<file>.md (descriptor)`.",
          "warn",
        ),
      ],
    };
  }
  const section = (m[2] ?? "").trim() || null;
  return {
    anchors: [
      {
        type: "arch-doc",
        file: m[1],
        section,
        descriptor: m[3] ?? "",
        trailingProse: m[4]?.trim() ?? "",
        warn: section ? null : "section anchor recommended",
        raw: segment,
      },
    ],
    failures: [],
  };
}

function parseCrossPlanDepsSegment(segment) {
  // Accept multi-row form: `cross-plan-deps §N row M + §K row L` (Plan-024
  // T-024-5-5 uses this for joint cross-plan-deps anchors). The base
  // namespace prefix `cross-plan-deps` appears once; subsequent §-clauses
  // join via `+` and may carry their own row.
  const m = segment.match(
    /^cross-plan-deps\s+§(\d+)(?:\s+row\s+(\d+))?((?:\s*\+\s*§\d+(?:\s+row\s+\d+)?)*)(?:\s*\(([^)]*)\))?(.*)$/,
  );
  if (!m) {
    return {
      anchors: [],
      failures: [
        makeFailure(
          "cross-plan-deps-unparseable",
          segment,
          `Cannot parse cross-plan-deps cite '${segment}'.`,
          "Accepted: `cross-plan-deps §N`, `cross-plan-deps §N row M`, `cross-plan-deps §N row M + §K row L`.",
          "warn",
        ),
      ],
    };
  }
  const anchors = [
    {
      type: "cross-plan-deps",
      section: m[1],
      row: m[2] ?? null,
      descriptor: m[4] ?? "",
      raw: segment,
    },
  ];
  // Parse any joined § / row clauses.
  for (const joinMatch of (m[3] ?? "").matchAll(/§(\d+)(?:\s+row\s+(\d+))?/g)) {
    anchors.push({
      type: "cross-plan-deps",
      section: joinMatch[1],
      row: joinMatch[2] ?? null,
      descriptor: m[4] ?? "",
      raw: segment,
    });
  }
  return { anchors, failures: [] };
}

function parsePlanLocalIdSegment(segment) {
  // The plan-local-ID prefix is the cite target; the rest is descriptor
  // (which may be parenthesised, dash-separated, or bare prose). We accept
  // any trailing form because legitimate plans use all three. Embedded
  // Spec/ADR cites inside the descriptor are still parsed recursively as
  // defense-in-depth against Plan-local-ID-wrap smuggling.
  const m = segment.match(/^([\w.-]+)(.*)$/s);
  if (!m || !PLAN_LOCAL_ID_RE.test(m[1])) {
    return {
      anchors: [],
      failures: [
        makeFailure(
          "plan-local-id-unparseable",
          segment,
          `Cannot parse plan-local-id cite '${segment}'.`,
          "Accepted plan-local-id shapes: Cn / Pn / Pr-n / In or I-NNN-N or I-NNN-N..M (structured invariant range).",
          "warn",
        ),
      ],
    };
  }
  const id = m[1];
  // Legitimate trailers are empty, whitespace-prefixed prose, or a paren
  // descriptor. A leading `,` / `;` / `+` means the segment-splitter did
  // not detect a boundary AND the trailer is not a descriptor — common
  // shape is `I-024-3, typo` (a malformed trailing cite) or `I-024-1,
  // I-024-2` when the splitter lookahead failed to recognize the
  // following plan-local-id prefix. Fail closed so the gate surfaces the
  // defect instead of swallowing the trailer as a descriptor (Codex P1
  // on PR #96 line 620).
  if (/^[,;+]/.test(m[2])) {
    return {
      anchors: [],
      failures: [
        makeFailure(
          "plan-local-id-malformed-trailer",
          segment,
          `Plan-local-id cite '${segment}' has malformed trailing text after id '${id}': '${m[2].trim()}'. Trailing text must be empty, a parenthetical descriptor, or whitespace-prefixed prose.`,
          "Separate multiple plan-local-ids with `, ` ensuring each is a valid id (Cn / Pn / Pr-n / In or I-NNN-N), or wrap a descriptor in parentheses.",
        ),
      ],
    };
  }
  const rest = m[2].trim();
  const parenMatch = rest.match(/^\(([^)]*)\)/);
  const descriptor = parenMatch ? parenMatch[1] : rest;
  const anchors = [{ type: "plan-local-id", id, descriptor, raw: segment }];
  const failures = [];
  if (descriptor && /\bSpec-\d+\b|\bADR-\d+\b/.test(descriptor)) {
    const nested = parseCitePayload(descriptor);
    anchors.push(...nested.anchors);
    failures.push(...nested.failures);
  }
  return { anchors, failures };
}

function parseSegment(segment) {
  const trimmed = segment.trim();
  if (/^Spec-\d+\b/.test(trimmed)) return parseSpecSegment(trimmed);
  if (/^ADR-\d+\b/.test(trimmed)) return parseAdrSegment(trimmed);
  if (/^[\w-]+\.md\b/.test(trimmed)) return parseArchDocSegment(trimmed);
  if (/^cross-plan-deps\b/.test(trimmed)) return parseCrossPlanDepsSegment(trimmed);
  if (/^none\b/i.test(trimmed)) {
    return {
      anchors: [{ type: "none-literal", raw: trimmed }],
      failures: [],
    };
  }
  // Plan-local-ID at top-level position (legitimate when not inside a
  // Spec-NNN prefix).
  if (/^(?:C|P|Pr|I)-?\d+\b/.test(trimmed)) {
    return parsePlanLocalIdSegment(trimmed);
  }
  return {
    anchors: [],
    failures: [
      makeFailure(
        "unparseable-cite",
        trimmed,
        `Token '${trimmed}' matches no namespace pattern after dash normalization.`,
        "Cite must start with `Spec-NNN`, `ADR-NNN`, `<doc>.md`, `cross-plan-deps`, `none`, or a Plan-local ID (Cn/Pn/Pr-n/I).",
        "error",
      ),
    ],
  };
}

// Parse one **Spec coverage:** or **Verifies invariant:** payload (the
// value after the bold key). Returns {anchors[], failures[]} aggregated
// across all top-level segments.
//
// Defense-in-depth: after per-segment parsing, scan the normalized payload
// for the compound-range defect class (`lines NN-MM (X/Y …)` where X and Y
// are distinct identifier-tokens). This catches the T3.3-shape (post-mortem
// defect class 2) even when the surrounding shape (multi-§Section, prose
// continuation, mixed-namespace) means parseSpecSegment didn't reach the
// range branch. Falsely accepting a compound-range defect is the load-
// bearing failure the en-dash normalization + this scan exist to prevent.
export function parseCitePayload(rawPayload) {
  const normalized = normalizeCitePayload(rawPayload);
  const segments = splitOnSemicolon(normalized);
  const anchors = [];
  const failures = [];
  for (const seg of segments) {
    const { anchors: a, failures: f } = parseSegment(seg);
    anchors.push(...a);
    failures.push(...f);
  }
  // Payload-level compound-range defense-in-depth scan.
  const compoundRangeRe = /\blines\s+(\d+)\s*-\s*(\d+)\s*\(([^)]+)\)/g;
  for (const m of normalized.matchAll(compoundRangeRe)) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    const descriptor = m[3];
    const subjects = nonPlanLocalSubjects(descriptor);
    if (subjects.length >= 2) {
      // Don't re-emit if the per-segment parser already caught this one.
      const dup = failures.some(
        (f) => f.kind === "compound-range-multi-subject" && f.raw.includes(`lines ${start}-${end}`),
      );
      if (!dup) {
        failures.push(
          makeFailure(
            "compound-range-multi-subject",
            m[0],
            `Compound range 'lines ${start}-${end}' covers distinct subjects (${subjects.join(", ")}); one-anchor-per-behavior is required.`,
            `Write 'line ${start} (${subjects[0]}), line ${end} (${subjects[1]})' instead of a range. Each Spec line that names a distinct contract gets its own anchor.`,
          ),
        );
      }
    }
  }
  return { anchors, failures };
}

// Extract every cite payload (Spec coverage / Verifies invariant) from a
// phase section and return the aggregated parse result. Each finding
// carries the field name and the originating task-row id (if discoverable
// from the surrounding bullet structure) for actionable failure messages.
//
// Payload termination: the value after a Spec coverage / Verifies invariant
// marker extends until the FIRST of:
//   (a) the next `**Word:**` bold-labeled marker (`**Spec coverage:**`,
//       `**Verifies invariant:**`, `**Note:**`, `**Files:**`, `**Wires:**`,
//       etc. — Plan-024 task bullets pack multiple labeled clauses on one
//       line),
//   (b) the next newline (canonical per-bullet shape from
//       docs/plans/000-plan-template.md).
// Trailing punctuation (`.`, `,`) is stripped from the payload after
// termination so the per-namespace parser regexes can anchor cleanly.
export function extractCiteAnchors(phaseSection) {
  const anchors = [];
  const failures = [];
  const targetMarkerRe = /\*\*(Spec coverage|Verifies invariant):\*\*/g;
  const anyMarkerRe = /\*\*[A-Z][\w ]*:\*\*/g;
  const targetMarkers = [...phaseSection.matchAll(targetMarkerRe)];
  const anyMarkers = [...phaseSection.matchAll(anyMarkerRe)];
  for (const marker of targetMarkers) {
    const field = marker[1];
    const startIdx = marker.index + marker[0].length;
    const nextAnyMarker = anyMarkers.find((m) => m.index > marker.index);
    const nextMarkerIdx = nextAnyMarker ? nextAnyMarker.index : phaseSection.length;
    const nextNewlineIdx = phaseSection.indexOf("\n", startIdx);
    const endIdx = Math.min(
      nextMarkerIdx,
      nextNewlineIdx === -1 ? phaseSection.length : nextNewlineIdx,
    );
    let payload = phaseSection.slice(startIdx, endIdx).trim();
    // Strip trailing sentence-end punctuation that follows the closing paren
    // of the last cite descriptor (`(...).` → `(...)`).
    payload = payload.replace(/[.,;:]+\s*$/, "");
    if (!payload) continue;
    const prefix = phaseSection.slice(0, marker.index);
    const taskMatch =
      [...prefix.matchAll(/^#####\s+(T[-\w.]+)/gm)].pop() ??
      [...prefix.matchAll(/^-\s+\*\*(T[-\w.]+)\*\*/gm)].pop();
    const taskId = taskMatch ? taskMatch[1] : null;
    const lineNo = prefix.split("\n").length;
    const { anchors: a, failures: f } = parseCitePayload(payload);
    for (const anchor of a) {
      anchors.push({ ...anchor, field, taskId, lineNo });
    }
    for (const failure of f) {
      failures.push({ ...failure, field, taskId, lineNo });
    }
  }
  return { anchors, failures };
}

// Verify one anchor against the spec file it cites. For `type: line`,
// confirm the cited line is non-blank, in-range, and (if a subject is
// present) contains identifier-tokens matching the subject. For `type: ac`,
// confirm the N-th `- [ ]` / `- [x]` bullet inside the §Acceptance Criteria
// section exists. For `type: line-range`, confirm the range is in bounds.
// For `type: section-only`, confirm the named section heading exists.
// Returns {valid, reason, evidence}.
export function verifyAnchorAgainstSpec(
  anchor,
  { specsDir, adrsDir, archDocsDir, crossPlanDepsFile },
) {
  // `none` and `plan-local-id` have no external document to verify;
  // they pass trivially. The three file-bearing namespaces (ADR /
  // arch-doc / cross-plan-deps) get file-existence checks below so
  // typos like `ADR-999 §Whatever` or `missing-doc.md` don't silently
  // pass Gate 4. Section-internal verification within those docs is
  // out-of-scope (different heading conventions per namespace).
  if (anchor.type === "none-literal" || anchor.type === "plan-local-id") {
    return { valid: true, reason: "no-external-doc-to-verify", evidence: anchor.raw };
  }
  if (anchor.type === "adr-section") {
    if (!adrsDir) {
      return { valid: true, reason: "adrs-dir-unconfigured", evidence: anchor.raw };
    }
    const adrMatches = findPaddedFiles(adrsDir, anchor.adr);
    if (adrMatches.length === 0) {
      return {
        valid: false,
        reason: "adr-file-not-found",
        evidence: `No file matched ${adrsDir}/${String(anchor.adr).padStart(3, "0")}-*.md`,
      };
    }
    if (adrMatches.length > 1) {
      return {
        valid: false,
        reason: "adr-file-ambiguous",
        evidence: `Multiple files matched ${adrsDir}/${String(anchor.adr).padStart(3, "0")}-*.md: ${adrMatches.map((p) => basename(p)).join(", ")}. Rename or remove the duplicate so the ADR number resolves uniquely.`,
      };
    }
    return { valid: true, reason: "adr-file-exists", evidence: adrMatches[0] };
  }
  if (anchor.type === "arch-doc") {
    if (!archDocsDir) {
      return { valid: true, reason: "arch-docs-dir-unconfigured", evidence: anchor.raw };
    }
    const archMatches = findArchDocFiles(archDocsDir, anchor.file);
    if (archMatches.length === 0) {
      return {
        valid: false,
        reason: "arch-doc-not-found",
        evidence: `No file named ${anchor.file} found under ${archDocsDir} (recursive search).`,
      };
    }
    if (archMatches.length > 1) {
      return {
        valid: false,
        reason: "arch-doc-ambiguous",
        evidence: `Multiple files named ${anchor.file} found under ${archDocsDir}: ${archMatches.join(", ")}. Disambiguate by directory path or remove the duplicate.`,
      };
    }
    return { valid: true, reason: "arch-doc-exists", evidence: archMatches[0] };
  }
  if (anchor.type === "cross-plan-deps") {
    if (!crossPlanDepsFile) {
      return { valid: true, reason: "cross-plan-deps-file-unconfigured", evidence: anchor.raw };
    }
    if (!existsSync(crossPlanDepsFile)) {
      return {
        valid: false,
        reason: "cross-plan-deps-file-not-found",
        evidence: `cross-plan-deps file does not exist at ${crossPlanDepsFile}.`,
      };
    }
    return { valid: true, reason: "cross-plan-deps-file-exists", evidence: crossPlanDepsFile };
  }
  const specMatches = findPaddedFiles(specsDir, anchor.spec);
  if (specMatches.length === 0) {
    return {
      valid: false,
      reason: "spec-file-not-found",
      evidence: `No file matched ${specsDir}/${String(anchor.spec).padStart(3, "0")}-*.md`,
    };
  }
  if (specMatches.length > 1) {
    return {
      valid: false,
      reason: "spec-file-ambiguous",
      evidence: `Multiple files matched ${specsDir}/${String(anchor.spec).padStart(3, "0")}-*.md: ${specMatches.map((p) => basename(p)).join(", ")}. Rename or remove the duplicate so the spec number resolves uniquely.`,
    };
  }
  const specFile = specMatches[0];
  let source;
  try {
    source = readFileSync(specFile, "utf8");
  } catch (e) {
    return {
      valid: false,
      reason: "spec-file-unreadable",
      evidence: `${specFile}: ${e.message}`,
    };
  }
  const specLines = source.split("\n");
  if (anchor.type === "line") {
    return verifyLineAnchor(anchor, specLines);
  }
  if (anchor.type === "line-range") {
    return verifyLineRangeAnchor(anchor, specLines);
  }
  if (anchor.type === "ac") {
    return verifyAcAnchor(anchor, source, specLines);
  }
  if (anchor.type === "section-only") {
    return verifySectionAnchor(anchor, specLines);
  }
  return { valid: true, reason: "no-spec-type", evidence: anchor.raw };
}

function normalizeTokenForMatch(tok) {
  return tok.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// `Spec-NNN §Section line N` / `§Section lines N1, N2` / `§Section AC-X` —
// the parser attaches `.section` to line / line-range / AC anchors so the
// verifier can reject phantom-section names alongside the line / AC check.
// Without this, `Spec-002 §NotARealSection line 13` accepts as long as line
// 13 exists (Codex P2 on PR #96 line 1301).
function findSectionHeading(sectionName, specLines) {
  // Exact-after-normalize match. The earlier `.includes()` form let
  // `§Token line 39` pass when the actual heading was `Token Security
  // Properties` because the substring check accepted any heading-prefix
  // (Codex P2 on PR #96 line 1435). Anchored equality binds the cite to
  // one heading specifically.
  const target = normalizeTokenForMatch(sectionName);
  for (const line of specLines) {
    if (/^#+\s+/.test(line)) {
      const headingText = line.replace(/^#+\s+/, "");
      if (normalizeTokenForMatch(headingText) === target) {
        return { found: true, headingLine: line.trim() };
      }
    }
  }
  return { found: false };
}

function sectionNotFoundFailure(sectionName) {
  return {
    valid: false,
    reason: "section-not-found",
    evidence: `Section heading '${sectionName}' not present in spec.`,
  };
}

function verifyLineAnchor(anchor, specLines) {
  if (anchor.section) {
    const sec = findSectionHeading(anchor.section, specLines);
    if (!sec.found) return sectionNotFoundFailure(anchor.section);
  }
  if (anchor.line < 1 || anchor.line > specLines.length) {
    return {
      valid: false,
      reason: "line-out-of-range",
      evidence: `Spec has ${specLines.length} lines; cited line ${anchor.line} is past EOF.`,
    };
  }
  const content = specLines[anchor.line - 1];
  if (!content || !content.trim()) {
    return {
      valid: false,
      reason: "line-blank",
      evidence: `Line ${anchor.line} is blank.`,
    };
  }
  if (anchor.subject) {
    const needle = normalizeTokenForMatch(anchor.subject);
    const haystack = normalizeTokenForMatch(content);
    if (!haystack.includes(needle)) {
      return {
        valid: false,
        reason: "subject-mismatch",
        evidence: `Line ${anchor.line} does not contain '${anchor.subject}'. Line content: ${content.trim()}`,
      };
    }
  }
  return { valid: true, reason: "line-content-matches", evidence: content.trim() };
}

function verifyLineRangeAnchor(anchor, specLines) {
  if (anchor.section) {
    const sec = findSectionHeading(anchor.section, specLines);
    if (!sec.found) return sectionNotFoundFailure(anchor.section);
  }
  if (anchor.start < 1 || anchor.end > specLines.length || anchor.start > anchor.end) {
    return {
      valid: false,
      reason: "line-range-out-of-bounds",
      evidence: `Range ${anchor.start}-${anchor.end} invalid for spec with ${specLines.length} lines.`,
    };
  }
  const block = specLines.slice(anchor.start - 1, anchor.end).join("\n");
  if (anchor.subject) {
    // Subject search uses ±2 ambient lines around the cited range so cites
    // pointing at a fenced shape block don't have to widen artificially to
    // include the intro line naming the contract (intro-above-block pattern).
    const ambient = 2;
    const ambientStart = Math.max(1, anchor.start - ambient);
    const ambientEnd = Math.min(specLines.length, anchor.end + ambient);
    const haystackBlock = specLines.slice(ambientStart - 1, ambientEnd).join("\n");
    const needle = normalizeTokenForMatch(anchor.subject);
    const haystack = normalizeTokenForMatch(haystackBlock);
    if (!haystack.includes(needle)) {
      return {
        valid: false,
        reason: "subject-mismatch-in-range",
        evidence: `Lines ${anchor.start}-${anchor.end} (±2 ambient = ${ambientStart}-${ambientEnd}) do not contain '${anchor.subject}'.`,
      };
    }
  }
  return {
    valid: true,
    reason: "line-range-content-matches",
    evidence: block.slice(0, 200),
  };
}

function verifyAcAnchor(anchor, source, specLines) {
  if (anchor.section) {
    const sec = findSectionHeading(anchor.section, specLines);
    if (!sec.found) return sectionNotFoundFailure(anchor.section);
  }
  const acHeadingMatch = source.match(/^#+\s+Acceptance Criteria\s*$/m);
  if (!acHeadingMatch) {
    return {
      valid: false,
      reason: "ac-section-missing",
      evidence: "No §Acceptance Criteria heading in spec.",
    };
  }
  const acStart = acHeadingMatch.index + acHeadingMatch[0].length;
  const after = source.slice(acStart);
  const nextSection = after.match(/^#+\s+\S/m);
  const acBody = nextSection ? after.slice(0, nextSection.index) : after;
  const bullets = [...acBody.matchAll(/^- \[[ x]\]/gm)];
  if (anchor.ac < 1 || anchor.ac > bullets.length) {
    return {
      valid: false,
      reason: "ac-index-out-of-range",
      evidence: `Spec has ${bullets.length} AC bullets; cited AC${anchor.ac} does not exist.`,
    };
  }
  // Best-effort line-hint verification: if hint given, the hinted line must
  // (1) be in range, (2) sit INSIDE the §Acceptance Criteria section, and
  // (3) match an AC bullet shape. Without the section bound, a checkbox
  // bullet anywhere else in the spec would false-pass (Codex P2 on PR #96
  // line 1444).
  if (anchor.lineHint) {
    if (anchor.lineHint < 1 || anchor.lineHint > specLines.length) {
      return {
        valid: false,
        reason: "ac-line-hint-out-of-range",
        evidence: `Line hint ${anchor.lineHint} past EOF.`,
      };
    }
    const acHeadingLineNum = source.slice(0, acHeadingMatch.index).split("\n").length;
    const acEndCharIdx = nextSection ? acStart + nextSection.index : source.length;
    const acLastLineNum = source.slice(0, acEndCharIdx).split("\n").length;
    if (anchor.lineHint <= acHeadingLineNum || anchor.lineHint > acLastLineNum) {
      return {
        valid: false,
        reason: "ac-line-hint-outside-section",
        evidence: `Line ${anchor.lineHint} is outside §Acceptance Criteria (section spans lines ${acHeadingLineNum + 1}-${acLastLineNum}).`,
      };
    }
    const hintContent = specLines[anchor.lineHint - 1] ?? "";
    if (!/^- \[[ x]\]/.test(hintContent)) {
      return {
        valid: false,
        reason: "ac-line-hint-not-bullet",
        evidence: `Line ${anchor.lineHint} is not an AC bullet. Content: ${hintContent.trim()}`,
      };
    }
    // Bind the hint to the specific AC-N index: the hinted line must be the
    // N-th `- [ ]` bullet within §Acceptance Criteria. Without this check
    // `Spec-002 AC3 (line 45)` false-passes when line 45 is actually AC1
    // (Codex P2 on PR #96 line 1571).
    const targetBulletAbsIdx = acStart + bullets[anchor.ac - 1].index;
    const targetBulletLineNum = source.slice(0, targetBulletAbsIdx).split("\n").length;
    if (anchor.lineHint !== targetBulletLineNum) {
      return {
        valid: false,
        reason: "ac-line-hint-wrong-bullet",
        evidence: `Line ${anchor.lineHint} is an AC bullet but not AC${anchor.ac}; AC${anchor.ac} sits at line ${targetBulletLineNum}.`,
      };
    }
  }
  return { valid: true, reason: "ac-bullet-exists", evidence: `AC${anchor.ac} bullet found.` };
}

function verifySectionAnchor(anchor, specLines) {
  const sec = findSectionHeading(anchor.section, specLines);
  if (sec.found) return { valid: true, reason: "section-found", evidence: sec.headingLine };
  return sectionNotFoundFailure(anchor.section);
}

// Grammar/format kinds demote to warnings for S/M classes. FAIL-CLOSED polarity:
// this set enumerates what DEMOTES, so any kind not listed — every
// existence-shaped kind (spec-file-not-found/-ambiguous/-unreadable,
// section-not-found, line-out-of-range, line-blank, line-range-out-of-bounds,
// ac-section-missing, ac-index-out-of-range, adr-/arch-doc-/cross-plan-deps
// lookups, *-unconfigured) and any FUTURE kind — stays a hard error for every
// class. Verifier failures arrive with kind = the verify reason (wrapped at the
// verifyFailures.push site in gateTasksBlockCites), so one set covers both the
// parser and verifier layers. Kind strings verified against this file 2026-07-06.
const G4_GRAMMAR_DEMOTE_KINDS = new Set([
  // parser-layer grammar/format kinds
  "unparseable-cite",
  "unparseable-spec-subanchor",
  "compound-range-multi-subject",
  "namespace-violation",
  "spec-namespace-malformed",
  "plan-local-id-as-spec-anchor",
  "plan-local-id-malformed-trailer",
  "plan-local-id-unparseable",
  // verifier-layer content-drift kinds (the target exists; content moved)
  "subject-mismatch",
  "subject-mismatch-in-range",
  // AC line-HINT refinement kinds (the AC bullet itself was found)
  "ac-line-hint-not-bullet",
  "ac-line-hint-out-of-range",
  "ac-line-hint-outside-section",
  "ac-line-hint-wrong-bullet",
]);

export function gateTasksBlockCites(phaseSection, planNumber, phaseNumber, opts = {}) {
  const counts = countCites(phaseSection);
  if (!(counts.spec_coverage > 0 && counts.verifies_invariant > 0)) {
    return {
      ok: false,
      halt: [
        "## Preflight halt: tasks-block missing G4 cites",
        "",
        `Plan-${planNumber} Phase ${phaseNumber}'s \`#### Tasks\` block is missing`,
        `\`Spec coverage:\` (${counts.spec_coverage}) or \`Verifies invariant:\``,
        `(${counts.verifies_invariant}) cites. The audit's G4 traceability gate did`,
        `not produce content — re-run the audit before dispatch.`,
        "",
        "Re-deriving task structure from prose discards cites downstream reviewers",
        "depend on (anti-pattern: SKILL.md § Anti-Patterns).",
      ].join("\n"),
    };
  }
  // Semantic anchor check (additive on top of token presence). The repoRoot
  // path is threaded from runPreflight options; specs live under docs/specs/,
  // ADRs under docs/decisions/, arch-docs under docs/architecture/ (recursive),
  // and cross-plan-deps is a single canonical file at
  // docs/architecture/cross-plan-dependencies.md.
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const specsDir = resolve(repoRoot, "docs", "specs");
  const adrsDir = resolve(repoRoot, "docs", "decisions");
  const archDocsDir = resolve(repoRoot, "docs", "architecture");
  const crossPlanDepsFile = resolve(archDocsDir, "cross-plan-dependencies.md");
  const { anchors, failures: parseFailures } = extractCiteAnchors(phaseSection);
  const verifyFailures = [];
  for (const anchor of anchors) {
    const v = verifyAnchorAgainstSpec(anchor, {
      specsDir,
      adrsDir,
      archDocsDir,
      crossPlanDepsFile,
    });
    if (!v.valid) {
      verifyFailures.push({
        kind: v.reason,
        raw: anchor.raw,
        field: anchor.field,
        taskId: anchor.taskId,
        message: v.evidence,
        remediation:
          "Re-run the cite-amendment subagent per docs/operations/plan-implementation-readiness-audit-runbook.md §Cite-Amendment Subagent Prompt Template, applying per-anchor verification.",
        // Verifier failures are always errors — they map directly onto the
        // seven post-mortem defect classes (subject mismatch, phantom
        // section, file missing, out-of-range line).
        severity: "error",
      });
    }
  }
  const allFailures = [...parseFailures, ...verifyFailures];
  // Size-classed tiering (SKILL.md § Size-Classed Ceremony): grammar/format
  // kinds demote to warnings for S/M phases; existence-shaped kinds and any
  // kind outside the fail-closed demote set stay hard for every class. The
  // Gate-4 token-presence floor above stays hard for all classes.
  const demoteGrammar = opts.sizeClass === "S" || opts.sizeClass === "M";
  const demoted = [];
  const blockingFailures = allFailures.filter((f) => {
    if ((f.severity ?? "error") !== "error") return false;
    if (demoteGrammar && G4_GRAMMAR_DEMOTE_KINDS.has(f.kind)) {
      demoted.push(f);
      return false;
    }
    return true;
  });
  if (blockingFailures.length === 0) return { ok: true, warnings: demoted };
  const lines = [
    "## Preflight halt: Gate 4 cite-anchor semantic check failed",
    "",
    `Plan-${planNumber} Phase ${phaseNumber} has ${blockingFailures.length} cite-anchor defect(s).`,
    "Each finding maps to a mechanism clause from the runbook §Subagent Prompt Template",
    "(per-anchor verify / one-per-behavior / Plan-vs-Spec namespace / return-DONE self-verify).",
    "",
  ];
  for (const f of blockingFailures) {
    const where = f.taskId ? `${f.taskId} (${f.field})` : f.field;
    lines.push(`- [${f.kind}] ${where}: ${f.message}`);
    lines.push(`  cite: ${f.raw}`);
    if (f.remediation) lines.push(`  fix:  ${f.remediation}`);
  }
  if (demoted.length > 0) {
    lines.push("");
    lines.push(`Demoted to warnings under size-class ${opts.sizeClass}:`);
    for (const f of demoted) {
      const where = f.taskId ? `${f.taskId} (${f.field})` : f.field;
      lines.push(`- [${f.kind}] ${where}: ${f.message}`);
    }
  }
  lines.push("");
  lines.push("Authoring contract: docs/operations/plan-implementation-readiness-audit-runbook.md");
  lines.push(
    "Verifier contract:  .claude/skills/plan-execution/references/preflight-contract.md §Gate 4 — Cite Anchor Semantic Check",
  );
  return { ok: false, halt: lines.join("\n") };
}

// resolvePrecondition signature is additive-backwards-compatible. The four
// existing cases (pr_merged, adr_accepted, plan_phase, cross_plan_carve_out)
// ignore the new params; the audit_status case introduced in this version
// needs phaseSection + phaseNumber to evaluate the substrate_exempt criterion
// (3) check (Spec-AC-empty sentinel + Tasks-block bracket-form conflict). The
// bl_closed case (added for the Plan-003 Phase 3 / NS-32 backlog gate) reads
// only repoRoot — already present — so it too is purely additive.
export function resolvePrecondition(
  entry,
  { repoRoot = REPO_ROOT, phaseSection, phaseNumber } = {},
) {
  switch (entry.type) {
    case "pr_merged": {
      const r = runGh(`gh pr view ${entry.ref} --json state`);
      if (!r.ok) return { ok: false, halt: `gh pr view ${entry.ref} failed: ${r.error}` };
      let data;
      try {
        data = JSON.parse(r.out);
      } catch {
        return {
          ok: false,
          halt: `gh pr view ${entry.ref} returned non-JSON: ${r.out.slice(0, 200)}`,
        };
      }
      if (data.state === "MERGED") return { ok: true };
      return { ok: false, halt: `pr_merged ref=${entry.ref} state=${data.state}, expected MERGED` };
    }
    case "adr_accepted": {
      const adrDir = resolve(repoRoot, "docs", "decisions");
      const adrMatches = findPaddedFiles(adrDir, entry.ref);
      if (adrMatches.length === 0) {
        return { ok: false, halt: `ADR-${entry.ref} not found in docs/decisions/` };
      }
      if (adrMatches.length > 1) {
        return {
          ok: false,
          halt: `ADR-${entry.ref} resolves to multiple files in docs/decisions/: ${adrMatches.map((p) => basename(p)).join(", ")}. Rename or remove the duplicate.`,
        };
      }
      const source = readFileSync(adrMatches[0], "utf8");
      const status = extractAdrStatus(source);
      if (status === "accepted") return { ok: true };
      return {
        ok: false,
        halt: `ADR-${entry.ref} Status=${status || "unknown"}, expected accepted`,
      };
    }
    case "plan_phase": {
      const planDir = resolve(repoRoot, "docs", "plans");
      const planMatches = findPaddedFiles(planDir, entry.plan);
      if (planMatches.length === 0) {
        return { ok: false, halt: `Plan-${entry.plan} not found in docs/plans/` };
      }
      if (planMatches.length > 1) {
        return {
          ok: false,
          halt: `Plan-${entry.plan} resolves to multiple files in docs/plans/: ${planMatches.map((p) => basename(p)).join(", ")}. Rename or remove the duplicate.`,
        };
      }
      const planFile = planMatches[0];
      const source = readFileSync(planFile, "utf8");
      // Mirror Gate 3's set-comparison via the shared classifier. Pre-round-7
      // the resolver matched any phase entry (`some(e.phase === entry.phase)`),
      // which became a partial-ship false-positive when manifest entries
      // moved to task-level granularity (Codex P2 on PR #35 round 7: a single
      // T5.1 entry in Plan-001 Phase 5 satisfied a downstream Plan-001 Phase 5
      // precondition even though T5.5/T5.6 remained unshipped). Same fail-open
      // contract as Gate 3: only future-schema is opaque-pass; everything else
      // halts with an explicit reason.
      const result = classifyPhaseShipment(source, entry.phase);
      switch (result.kind) {
        case "fully_shipped":
        case "manifest_future_schema":
          return { ok: true };
        case "manifest_unparseable":
          return {
            ok: false,
            halt: `Plan-${entry.plan} shipment manifest unparseable (${result.reason}); cannot determine Phase ${entry.phase} ship status`,
          };
        case "manifest_invalid_entries":
          return {
            ok: false,
            halt: `Plan-${entry.plan} shipment manifest has ${result.entryErrors.length} entries that fail validateEntry (e.g. shipped[${result.entryErrors[0].index}]: ${result.entryErrors[0].errors[0]}); cannot determine Phase ${entry.phase} ship status`,
          };
        case "no_phase_section":
          return {
            ok: false,
            halt: `Plan-${entry.plan} Phase ${entry.phase} section not found in plan file`,
          };
        case "no_declared_tasks":
          // Legacy fallback: upstream Tasks block has no task ids. Fall back
          // to phase-presence so plans that shipped before the audit runbook
          // formalized #### Tasks blocks don't fail-loud.
          if (result.phaseHasManifestEntry) return { ok: true };
          return {
            ok: false,
            halt: `Plan-${entry.plan} Phase ${entry.phase} has no entry in shipment manifest`,
          };
        case "partially_shipped":
          return {
            ok: false,
            halt: `Plan-${entry.plan} Phase ${entry.phase} only partially shipped — missing tasks: ${result.missing.join(", ")}`,
          };
        default:
          // Defensive: classifyPhaseShipment kinds are exhaustive today; this
          // branch fires only if a future kind lands without a handler. Halt
          // loudly rather than silently fall through to cross_plan_carve_out.
          return {
            ok: false,
            halt: `unhandled classifyPhaseShipment kind: ${result.kind}`,
          };
      }
    }
    case "plan_unshipped": {
      // Met once the upstream plan has shipped at least one phase/task — i.e.
      // its shipment manifest exists and has ≥1 entry; unmet (and the phase is
      // skipped by the auto-walk) while the upstream is still un-decomposed (no
      // manifest at all). Deliberately COARSE: this answers "has Plan-N started
      // shipping?", not "has the specific cross-tier substrate landed?". The
      // narrow question is unanswerable here because an un-decomposed upstream
      // has no phase/task granularity to point at — that is the whole reason the
      // corpus uses the prose `Plan-NNN Tier M` form rather than `Plan-NNN Phase
      // N merged`. When the upstream IS decomposed and its substrate ships,
      // tighten the dependent precondition to the per-phase `Plan-NNN Phase N
      // merged` form (plan_phase case) for substrate-level precision.
      const planDir = resolve(repoRoot, "docs", "plans");
      const planMatches = findPaddedFiles(planDir, entry.plan);
      if (planMatches.length === 0) {
        return { ok: false, halt: `Plan-${entry.plan} not found in docs/plans/` };
      }
      if (planMatches.length > 1) {
        return {
          ok: false,
          halt: `Plan-${entry.plan} resolves to multiple files in docs/plans/: ${planMatches.map((p) => basename(p)).join(", ")}. Rename or remove the duplicate.`,
        };
      }
      const manifest = parseManifestBlock(readFileSync(planMatches[0], "utf8"));
      if (manifest.ok && Array.isArray(manifest.shipped) && manifest.shipped.length > 0) {
        return { ok: true };
      }
      return {
        ok: false,
        halt: `Plan-${entry.plan} has not shipped yet (no shipment-manifest entries) — cross-tier substrate unavailable`,
      };
    }
    case "cross_plan_carve_out": {
      const xplanPath = resolve(repoRoot, "docs", "architecture", "cross-plan-dependencies.md");
      let source;
      try {
        source = readFileSync(xplanPath, "utf8");
      } catch (e) {
        return { ok: false, halt: `cross-plan-dependencies.md unreadable: ${e.message}` };
      }
      // Scope the membership check to §5 only. Pre-this-version the resolver
      // used `source.includes(ref)` over the whole file, which passed when
      // the ref appeared in §3 prose or §6 NS-rows even if §5 had no entry.
      const section5 = extractSection5(source);
      if (section5 === null) {
        return {
          ok: false,
          halt: `cross-plan-dependencies.md has no §5 (Canonical Build Order) section; cannot evaluate cross_plan_carve_out`,
        };
      }
      if (section5.includes(String(entry.ref))) return { ok: true };
      return {
        ok: false,
        halt: `cross_plan_carve_out ref=${entry.ref} not present in cross-plan-dependencies.md §5`,
      };
    }
    case "audit_status": {
      // Two values per runbook §Per-Phase Audit Semantics:
      //   - complete: the act of declaring `complete` is the load-bearing
      //     assertion (matches the existing Gate 2 behavior of trusting the
      //     human-set checkbox); evidence_pr + baseline_tag are documentary.
      //   - substrate_exempt: requires three criteria. (1)+(2) are
      //     human-judged at audit time and live in the §5 carve-out entry
      //     itself; (3) is mechanically verified here — Spec coverage
      //     declaration must be explicitly empty in the phase body, and the
      //     Tasks block must not cite Spec coverage in bracketed-list form.
      if (entry.status === "complete") return { ok: true };
      if (entry.status === "substrate_exempt") {
        const xplanPath = resolve(repoRoot, "docs", "architecture", "cross-plan-dependencies.md");
        let xplanSource;
        try {
          xplanSource = readFileSync(xplanPath, "utf8");
        } catch (e) {
          return { ok: false, halt: `cross-plan-dependencies.md unreadable: ${e.message}` };
        }
        const section5 = extractSection5(xplanSource);
        if (section5 === null) {
          return {
            ok: false,
            halt: `cross-plan-dependencies.md has no §5 (Canonical Build Order) section; cannot evaluate audit_status: substrate_exempt`,
          };
        }
        if (!entry.carve_out_ref || !section5.includes(entry.carve_out_ref)) {
          return {
            ok: false,
            halt: `audit_status: substrate_exempt requires carve_out_ref present in cross-plan-dependencies.md §5; "${entry.carve_out_ref ?? "<missing>"}" not found within §5 scope`,
          };
        }
        // Criterion (3) sentinel: phase body explicitly disclaims Spec AC
        // coverage. Three canonical phrasings accepted.
        const specAcSentinel =
          /covers no Spec-\d+ acceptance criteri|covers NO Spec-\d+ AC|substrate is pre-behavior plumbing/i;
        if (!specAcSentinel.test(phaseSection ?? "")) {
          return {
            ok: false,
            halt: `audit_status: substrate_exempt requires phase body to declare 'covers no Spec-NNN acceptance criteria' (or equivalent sentinel: 'covers NO Spec-NNN AC', 'substrate is pre-behavior plumbing'); not found in Phase ${phaseNumber} section. If this phase ships any Spec AC, declare audit_status: complete and run the runbook audit instead.`,
          };
        }
        // Criterion (3) sibling consistency: Tasks-block rows MUST NOT cite
        // Spec coverage in bracketed-list form (`Spec coverage: [...]`).
        // Bracket-form is the audit-runbook G4 traceability cite shape;
        // prose-form mentions (e.g., `Spec coverage: per F-008b-1-06, NO
        // Spec-008 AC at Tier 1`) are not in scope because they describe
        // coverage *absence*. A bracketed value is the affirmative cite.
        const tasksBlock = extractTasksBlock(phaseSection ?? "");
        if (tasksBlock !== null) {
          const specCoverageRe = /Spec coverage:\s*\[([^\]]+)\]/g;
          const conflicts = [];
          let m;
          while ((m = specCoverageRe.exec(tasksBlock)) !== null) {
            const inner = m[1].trim();
            if (inner && inner.toLowerCase() !== "none") conflicts.push(inner);
          }
          if (conflicts.length > 0) {
            return {
              ok: false,
              halt: `audit_status: substrate_exempt conflicts with Tasks-block Spec coverage cites in Phase ${phaseNumber}: ${conflicts.join("; ")}. Either remove the Spec coverage cites (phase is pure substrate) or declare audit_status: complete (phase ships Spec AC and requires full audit).`,
            };
          }
        }
        return { ok: true };
      }
      return {
        ok: false,
        halt: `audit_status.status must be 'complete' or 'substrate_exempt'; got '${entry.status}'`,
      };
    }
    case "bl_closed": {
      // Gate a phase on a backlog item being closed. Used when a phase cannot
      // reach its Exit Criteria until a governance change lands, but that change
      // is neither a merged PR nor an accepted ADR — so no artifact number
      // exists at declaration time to gate on with pr_merged / adr_accepted
      // (Codex #3 on PR #138: Plan-003 Phase 3 / NS-32 is blocked on a Spec-003
      // §Default-Behavior heartbeat-threshold amendment whose PR number is
      // unknowable now, and the threshold value is a spec value, not
      // ADR-worthy). The honest machine-readable primitive that exists at
      // declaration time is the backlog item itself — Codex named it a "backlog
      // gate". ok:true iff BL-NNN's Status reads `completed` — from
      // docs/backlog.md while the item is active, else from the archive
      // (docs/archive/backlog-archive.md) where completed items are swept per
      // the CLAUDE.md backlog discipline. The archive Status is re-parsed, not
      // trusted on presence: any open state (todo / in_progress / blocked), a
      // non-completed archived state (e.g. withdrawn / superseded), an
      // unparseable Status, or an unknown BL fails closed.
      const blId = `BL-${String(entry.ref).padStart(3, "0")}`;
      const backlogPath = resolve(repoRoot, "docs", "backlog.md");
      let backlog;
      try {
        backlog = readFileSync(backlogPath, "utf8");
      } catch (e) {
        return { ok: false, halt: `docs/backlog.md unreadable: ${e.message}` };
      }
      const activeSection = extractBacklogItemSection(backlog, blId);
      if (activeSection !== null) {
        const verdict = judgeBacklogCompletion(activeSection);
        if (verdict.ok) return { ok: true };
        if (verdict.reason === "unparseable") {
          return {
            ok: false,
            halt: `${blId} found in docs/backlog.md but its Status line is unparseable; cannot evaluate bl_closed`,
          };
        }
        return {
          ok: false,
          halt: `${blId} is '${verdict.reason}' in docs/backlog.md, not 'completed' — the governance change this phase depends on has not landed`,
        };
      }
      // Not in the active backlog → check the archive. Completed items are swept
      // there per the CLAUDE.md backlog discipline, but the archive is NOT
      // completed-only (withdrawn / superseded items live there too), so the
      // Status is re-judged with the same rigor as the active path — presence
      // alone must never unblock (Codex P2 on PR #138).
      const archivePath = resolve(repoRoot, "docs", "archive", "backlog-archive.md");
      let archive = "";
      try {
        archive = readFileSync(archivePath, "utf8");
      } catch {
        // Archive absent is not fatal — fall through to the not-found halt.
      }
      const archivedSection = extractBacklogItemSection(archive, blId);
      if (archivedSection !== null) {
        const verdict = judgeBacklogCompletion(archivedSection);
        if (verdict.ok) return { ok: true };
        if (verdict.reason === "unparseable") {
          return {
            ok: false,
            halt: `${blId} found in docs/archive/backlog-archive.md but its Status line is unparseable; cannot evaluate bl_closed`,
          };
        }
        return {
          ok: false,
          halt: `${blId} is '${verdict.reason}' in the archive (docs/archive/backlog-archive.md), not 'completed' — withdrawn/superseded items are archived but did not land`,
        };
      }
      return {
        ok: false,
        halt: `${blId} not found in docs/backlog.md or docs/archive/backlog-archive.md; cannot evaluate bl_closed (mint the backlog item or correct the ref)`,
      };
    }
    default:
      return { ok: false, halt: `unknown precondition type: ${entry.type}` };
  }
}

export function gatePreconditions(phaseSection, planFile, phaseNumber, opts = {}) {
  let entries = parsePreconditionsBlock(phaseSection);
  if (entries === null) {
    const lineMatch = phaseSection.match(/\*\*Precondition:\*\*\s*([^\n]+)/);
    if (!lineMatch) return { ok: true }; // no precondition declared; legacy plan, accept
    // Pass the local plan number so bare `Phase N merged` resolves to
    // `{type: plan_phase, plan: <local>, phase: N}`. Without this thread,
    // same-plan precondition prose drops below the regex and the function
    // silently treats the line as legacy free-form.
    entries = regexParsePreconditionsLine(lineMatch[1], extractPlanNumber(planFile));
    if (entries.length === 0) return { ok: true }; // unparseable prose; treat as legacy free-form
  }
  for (const entry of entries) {
    const r = resolvePrecondition(entry, opts);
    if (!r.ok) {
      return {
        ok: false,
        halt: [
          "## Preflight halt: phase precondition unmet",
          "",
          `Plan ${planFile} Phase ${phaseNumber} declares precondition:`,
          `  ${JSON.stringify(entry)}`,
          "",
          r.halt,
        ].join("\n"),
      };
    }
  }
  return { ok: true };
}

// ---------- orchestration ----------

function _checkPhase(planSource, planNumber, phase, planFile, opts) {
  const ship = gatePhaseUnshipped(planSource, planNumber, phase);
  if (!ship.ok) return { eligible: false, reason: ship.kind, halt: ship.halt };
  const sec = extractPhaseSection(planSource, phase.number);
  if (!sec)
    return {
      eligible: false,
      reason: "no-section",
      halt: `cannot extract phase ${phase.number} section`,
    };
  // Per-phase audit gate runs before Gate 4 + Gate 5 — substrate-exempt
  // phases also use this to admit themselves before Gate 4 is skipped.
  const gPhase = gatePhaseAuditCheckbox(planSource, sec, planFile, phase.number);
  if (!gPhase.ok) return { eligible: false, reason: "audit", halt: gPhase.halt };
  // Size class is computed for every phase — including substrate-exempt ones,
  // which skip Gate 4 but still drive the SKILL.md ceremony map off the class.
  const sizeClass = classifyPhaseSize(extractDeclaredTaskIds(sec), extractDeclaredFilePaths(sec));
  // Gate 4 (Tasks-block G4 cites) is skipped for phases declaring
  // audit_status: substrate_exempt. By criterion (3) those phases ship pure
  // pre-behavior plumbing with zero Spec AC coverage — Gate 4's `Spec
  // coverage` substring requirement would halt them by design. The
  // substrate_exempt YAML is the explicit opt-out; the Gate 5 resolver
  // verifies the criterion (3) sentinel + Tasks-block-bracket-conflict
  // check in lieu of Gate 4.
  const entries = parsePreconditionsBlock(sec) ?? [];
  const isSubstrateExempt = entries.some(
    (e) => e.type === "audit_status" && e.status === "substrate_exempt",
  );
  let g4 = null;
  if (!isSubstrateExempt) {
    g4 = gateTasksBlockCites(sec, planNumber, phase.number, { ...opts, sizeClass });
    if (!g4.ok) return { eligible: false, reason: "audit", halt: g4.halt };
  }
  const g5 = gatePreconditions(sec, planFile, phase.number, {
    ...opts,
    phaseSection: sec,
    phaseNumber: phase.number,
  });
  if (!g5.ok)
    return {
      eligible: false,
      reason: "preconditions",
      halt: g5.halt,
      warnings: g4?.warnings ?? [],
    };
  // Demoted G4 findings must ride the PASS path (delta D-14) — otherwise S/M
  // grammar rot accumulates invisibly behind the demotion.
  return { eligible: true, sizeClass, warnings: g4?.warnings ?? [] };
}

export function runPreflight(
  planFile,
  phaseArg,
  { repoRoot = REPO_ROOT, skillMd = SKILL_MD, checkFreshness = false } = {},
) {
  const g1 = gateProjectLocality({ repoRoot, skillMd });
  if (!g1.ok) return { exit: 1, stdout: g1.halt };

  let planSource;
  try {
    planSource = readFileSync(planFile, "utf8");
  } catch (e) {
    return { exit: 2, stderr: `read plan ${planFile}: ${e.message}` };
  }

  const g2 = gateAuditCheckbox(planSource, planFile);
  if (!g2.ok) return { exit: 1, stdout: g2.halt };

  const planNumber = extractPlanNumber(planFile);
  if (planNumber === null) return { exit: 2, stderr: `bad plan filename: ${basename(planFile)}` };

  const phases = walkPhases(planSource);
  if (phases.length === 0)
    return {
      exit: 2,
      stderr: `no \`### Phase N\` headers found in ${planFile} (accepted separators: \`—\`, \`:\`, \`-\`)`,
    };

  // Gate 6 — manifest freshness. CLI runs default it ON (--allow-stale-manifest
  // is the explicit escape); programmatic/test callers opt in via
  // checkFreshness so fixture-driven suites stay network-free. Runs before the
  // phase walk because a stale manifest corrupts Gate 3's phase selection.
  if (checkFreshness) {
    const g6 = gateManifestFreshness(planSource, planNumber);
    if (!g6.ok) return { exit: 1, stdout: g6.halt };
  }

  const opts = { repoRoot };
  if (phaseArg !== undefined && phaseArg !== null) {
    const target = phases.find((p) => p.number === phaseArg);
    if (!target)
      return { exit: 1, stdout: `## Preflight halt: phase ${phaseArg} not found in ${planFile}` };
    const r = _checkPhase(planSource, planNumber, target, planFile, opts);
    // Halt paths carry demoted warnings too — explicit-phase overrides are a
    // normal recovery path, and the never-silent contract must survive them
    // (Codex, PR #190: precondition halt was hiding the phase's cite drift).
    if (!r.eligible) return { exit: 1, stdout: r.halt, warnings: r.warnings ?? [] };
    return { exit: 0, stdout: String(target.number), sizeClass: r.sizeClass, warnings: r.warnings };
  }

  const skipped = [];
  // Demoted G4 grammar warnings from phases the walk SKIPS (e.g. an S phase
  // whose only hard failure is an unmet precondition) must still surface on
  // the eventual success return — the never-silent contract covers skipped
  // phases too, or cite rot hides behind the skip.
  const walkWarnings = [];
  for (const p of phases) {
    const r = _checkPhase(planSource, planNumber, p, planFile, opts);
    if (r.eligible)
      return {
        exit: 0,
        stdout: String(p.number),
        sizeClass: r.sizeClass,
        warnings: [...walkWarnings, ...(r.warnings ?? [])],
      };
    // `fully_shipped` is the only legitimate silent-skip — every other Gate 3
    // failure must surface, including the round-7/8 strict halts. Pre-round-9
    // _checkPhase collapsed all `gatePhaseUnshipped` failures to `reason:
    // "shipped"`, so manifest_unparseable / manifest_invalid_entries got
    // silenced in auto-walk mode (Codex P1 finding on PR #35 round 9). The
    // explicit list — not a default — guarantees future strict-halt kinds
    // also surface unless they're explicitly added as silent-skip.
    //
    // `audit` is in the strict-halt set: an upstream phase failing Gate 2
    // (per-phase audit checkbox) or Gate 4 (Tasks-block G4 cites) signals an
    // author defect that author-defect clustering says will almost certainly
    // affect later phases as well, and the previous auto-walk semantics
    // could resolve to a later phase that passed its own gates while the
    // earlier audit-failed phase went unsurfaced. Authors who need to
    // execute a downstream phase ahead of an audit-failing earlier one can
    // pass the explicit `<phase-number>` argument to override.
    if (r.reason === "fully_shipped") continue;
    if (
      r.reason === "manifest_unparseable" ||
      r.reason === "manifest_invalid_entries" ||
      r.reason === "audit"
    ) {
      return { exit: 1, stdout: r.halt, warnings: [...walkWarnings, ...(r.warnings ?? [])] };
    }
    // no-section / preconditions — per-phase issues, try next phase.
    walkWarnings.push(...(r.warnings ?? []));
    skipped.push(`Phase ${p.number} (${r.reason}): ${r.halt.split("\n")[0]}`);
  }
  const reasonsText = skipped.length
    ? `\n\nNon-eligible phases:\n${skipped.map((s) => `  - ${s}`).join("\n")}`
    : "";
  return {
    exit: 1,
    stdout: `## Preflight halt: no eligible un-shipped phase in ${planFile}${reasonsText}`,
    warnings: walkWarnings,
  };
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  const knownFlags = new Set(["--allow-stale-manifest", "--help", "-h"]);
  const unknownFlags = args.filter((a) => a.startsWith("-") && !knownFlags.has(a));
  if (unknownFlags.length > 0) {
    process.stderr.write(`unknown flag(s): ${unknownFlags.join(", ")}\n`);
    process.exit(2);
  }
  const allowStaleManifest = args.includes("--allow-stale-manifest");
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stderr.write(
      "Usage: node preflight.mjs <plan-file> [phase-number] [--allow-stale-manifest]\n" +
        "See ../references/preflight-contract.md.\n",
    );
    process.exit(2);
  }
  const planFile = positional[0];
  const phaseArg = positional[1] !== undefined ? Number(positional[1]) : undefined;
  if (positional[1] !== undefined && (Number.isNaN(phaseArg) || !Number.isInteger(phaseArg))) {
    process.stderr.write(`bad phase argument: ${positional[1]}\n`);
    process.exit(2);
  }
  if (allowStaleManifest) {
    process.stderr.write(
      "preflight: Gate 6 (manifest freshness) SKIPPED via --allow-stale-manifest\n",
    );
  }
  const result = runPreflight(planFile, phaseArg, { checkFreshness: !allowStaleManifest });
  if (result.stdout) process.stdout.write(result.stdout + "\n");
  // Line 2 of the success contract (delta D-5): the phase's size class drives
  // the ceremony map in SKILL.md § Size-Classed Ceremony.
  if (result.exit === 0 && result.sizeClass)
    process.stdout.write(`size-class: ${result.sizeClass}\n`);
  // Demoted grammar findings are non-blocking but NEVER silent — stderr keeps the
  // stdout contract at exactly two lines while the author still sees the drift.
  // Printed on halt exits too: an explicit-phase or walk halt must not hide
  // warnings its phases demoted (Codex, PR #190).
  if (result.warnings?.length) {
    const classPrefix = result.sizeClass ? `size-class ${result.sizeClass} ` : "";
    process.stderr.write(
      `preflight: ${classPrefix}demoted ${result.warnings.length} grammar finding(s) to warnings:\n`,
    );
    for (const w of result.warnings) {
      process.stderr.write(
        `  - [${w.kind}] ${[w.taskId, w.field, w.message].filter(Boolean).join(" ")}\n`,
      );
    }
  }
  if (result.stderr) process.stderr.write(result.stderr + "\n");
  process.exit(result.exit);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`internal error: ${e.message || String(e)}\n`);
    process.exit(2);
  });
}
