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

export function walkPhases(planSource) {
  const re = /^### Phase (\d+)\s*[—-]\s*(.+?)\s*$/gm;
  const phases = [];
  let m;
  while ((m = re.exec(planSource)) !== null) {
    phases.push({ number: Number(m[1]), title: m[2].trim() });
  }
  return phases;
}

export function extractPhaseSection(planSource, phaseNumber) {
  const startRe = new RegExp(`^### Phase ${phaseNumber}\\s*[—-]\\s*.+$`, "m");
  const startMatch = startRe.exec(planSource);
  if (!startMatch) return null;
  const startIdx = startMatch.index;
  const after = planSource.slice(startIdx + startMatch[0].length);
  const nextRe = /^### Phase \d+/m;
  const nextMatch = nextRe.exec(after);
  const endIdx = nextMatch ? startIdx + startMatch[0].length + nextMatch.index : planSource.length;
  return planSource.slice(startIdx, endIdx);
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
  const blockMatch = phaseSection.match(/```ya?ml\s*\n([\s\S]*?)\n```/);
  if (!blockMatch) return null;
  const lines = blockMatch[1].split("\n");
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

export function regexParsePreconditionsLine(line) {
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
  return entries;
}

export function extractPlanNumber(planFile) {
  const base = basename(planFile);
  const match = base.match(/^(\d{1,4})-/);
  return match ? Number(match[1]) : null;
}

export function findPaddedFile(dir, ref) {
  const padded = String(ref).padStart(3, "0");
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (f.startsWith(`${padded}-`) && f.endsWith(".md")) return resolve(dir, f);
    }
    return null;
  } catch {
    return null;
  }
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

// Extract declared task ids from a phase's `#### Tasks` block. Returns a
// sorted unique array. Handles both audit-Tasks-block layouts:
//   Pattern A: sub-header form     `##### T1.1 — title`
//   Pattern B: bullet+bold inline  `- **T-007p-1-1** (Files: ...)`
// Both patterns coexist across the corpus (Plan-001 phases use A;
// Plan-007 partial phases use B); the audit runbook treats them as
// equivalent and Gate 3's set-comparison must accept both.
export function extractDeclaredTaskIds(phaseSection) {
  const tasksMatch = phaseSection.match(/####\s*Tasks\s*\n([\s\S]*?)(?=\n####\s|\n###\s|$)/);
  if (!tasksMatch) return [];
  const block = tasksMatch[1];
  const ids = new Set();
  for (const m of block.matchAll(/^#####\s+(T[-a-zA-Z0-9.]+)\b/gm)) ids.add(m[1]);
  for (const m of block.matchAll(/^-\s+\*\*(T[-a-zA-Z0-9.]+)\*\*/gm)) ids.add(m[1]);
  return [...ids].sort();
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

export function gateAuditCheckbox(planSource, planFile) {
  if (extractAuditCheckbox(planSource)) return { ok: true };
  return {
    ok: false,
    halt: [
      "## Preflight halt: audit-complete checkbox unchecked",
      "",
      `Plan ${planFile} has not passed the plan-readiness audit. The Status`,
      "Promotion Gate from docs/operations/plan-implementation-readiness-audit-runbook.md",
      "blocks code-execution dispatch on un-audited plans.",
      "",
      "Run the audit first, or document an explicit waiver in the plan body",
      "before re-running.",
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

export function gateTasksBlockCites(phaseSection, planNumber, phaseNumber) {
  const counts = countCites(phaseSection);
  if (counts.spec_coverage > 0 && counts.verifies_invariant > 0) return { ok: true };
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

export function resolvePrecondition(entry, { repoRoot = REPO_ROOT } = {}) {
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
      const adrFile = findPaddedFile(resolve(repoRoot, "docs", "decisions"), entry.ref);
      if (!adrFile) return { ok: false, halt: `ADR-${entry.ref} not found in docs/decisions/` };
      const source = readFileSync(adrFile, "utf8");
      const status = extractAdrStatus(source);
      if (status === "accepted") return { ok: true };
      return {
        ok: false,
        halt: `ADR-${entry.ref} Status=${status || "unknown"}, expected accepted`,
      };
    }
    case "plan_phase": {
      const planFile = findPaddedFile(resolve(repoRoot, "docs", "plans"), entry.plan);
      if (!planFile) return { ok: false, halt: `Plan-${entry.plan} not found in docs/plans/` };
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
    case "cross_plan_carve_out": {
      const xplanPath = resolve(repoRoot, "docs", "architecture", "cross-plan-dependencies.md");
      let source;
      try {
        source = readFileSync(xplanPath, "utf8");
      } catch (e) {
        return { ok: false, halt: `cross-plan-dependencies.md unreadable: ${e.message}` };
      }
      if (source.includes(String(entry.ref))) return { ok: true };
      return {
        ok: false,
        halt: `cross_plan_carve_out ref=${entry.ref} not present in cross-plan-dependencies.md`,
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
    entries = regexParsePreconditionsLine(lineMatch[1]);
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
  const g4 = gateTasksBlockCites(sec, planNumber, phase.number);
  if (!g4.ok) return { eligible: false, reason: "audit", halt: g4.halt };
  const g5 = gatePreconditions(sec, planFile, phase.number, opts);
  if (!g5.ok) return { eligible: false, reason: "preconditions", halt: g5.halt };
  return { eligible: true };
}

export function runPreflight(
  planFile,
  phaseArg,
  { repoRoot = REPO_ROOT, skillMd = SKILL_MD } = {},
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
    return { exit: 2, stderr: `no \`### Phase N —\` headers found in ${planFile}` };

  const opts = { repoRoot };
  if (phaseArg !== undefined && phaseArg !== null) {
    const target = phases.find((p) => p.number === phaseArg);
    if (!target)
      return { exit: 1, stdout: `## Preflight halt: phase ${phaseArg} not found in ${planFile}` };
    const r = _checkPhase(planSource, planNumber, target, planFile, opts);
    if (!r.eligible) return { exit: 1, stdout: r.halt };
    return { exit: 0, stdout: String(target.number) };
  }

  const skipped = [];
  for (const p of phases) {
    const r = _checkPhase(planSource, planNumber, p, planFile, opts);
    if (r.eligible) return { exit: 0, stdout: String(p.number) };
    // `fully_shipped` is the only legitimate silent-skip — every other Gate 3
    // failure must surface, including the round-7/8 strict halts. Pre-round-9
    // _checkPhase collapsed all `gatePhaseUnshipped` failures to `reason:
    // "shipped"`, so manifest_unparseable / manifest_invalid_entries got
    // silenced in auto-walk mode (Codex P1 finding on PR #35 round 9). The
    // explicit list — not a default — guarantees future strict-halt kinds
    // also surface unless they're explicitly added as silent-skip.
    if (r.reason === "fully_shipped") continue;
    if (r.reason === "manifest_unparseable" || r.reason === "manifest_invalid_entries") {
      return { exit: 1, stdout: r.halt };
    }
    // no-section / audit / preconditions — per-phase issues, try next phase.
    skipped.push(`Phase ${p.number} (${r.reason}): ${r.halt.split("\n")[0]}`);
  }
  const reasonsText = skipped.length
    ? `\n\nNon-eligible phases:\n${skipped.map((s) => `  - ${s}`).join("\n")}`
    : "";
  return {
    exit: 1,
    stdout: `## Preflight halt: no eligible un-shipped phase in ${planFile}${reasonsText}`,
  };
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stderr.write(
      "Usage: node preflight.mjs <plan-file> [phase-number]\nSee ../references/preflight-contract.md.\n",
    );
    process.exit(2);
  }
  const planFile = args[0];
  const phaseArg = args[1] !== undefined ? Number(args[1]) : undefined;
  if (args[1] !== undefined && (Number.isNaN(phaseArg) || !Number.isInteger(phaseArg))) {
    process.stderr.write(`bad phase argument: ${args[1]}\n`);
    process.exit(2);
  }
  const result = runPreflight(planFile, phaseArg);
  if (result.stdout) process.stdout.write(result.stdout + "\n");
  if (result.stderr) process.stderr.write(result.stderr + "\n");
  process.exit(result.exit);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`internal error: ${e.message || String(e)}\n`);
    process.exit(2);
  });
}
