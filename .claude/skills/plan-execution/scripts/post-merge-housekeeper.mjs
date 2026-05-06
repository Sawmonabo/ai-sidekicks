#!/usr/bin/env node
// post-merge-housekeeper.mjs — plan-execution skill housekeeper script.
//
// Stage 1 of a 2-stage post-merge automation. Authoritative contract:
// ../references/post-merge-housekeeper-contract.md; design at
// docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md.
//
// Public surface (used by runHousekeeper + tests):
//   parseNsHeading / parseSubFields / parsePRsBlock      — §6 entry parsers
//   computeStatusFromPRs                                  — §3a.2 6-row matrix
//   extractFileReferences                                 — §3a.4 path heuristic
//   parseArgs + ParseArgsError                            — §5.1 step 0
//   verifyTypeSignature / verifyFileOverlap /
//   verifyPlanIdentity                                    — §5.1 step 3 verifiers

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";

// ---------- Task 3.2: parseNsHeading ----------

const NS_HEADING_RE = /^### NS-(\d+)(?:\.\.NS-(\d+))?([a-z])?: (.+)$/;

export function parseNsHeading(line) {
  const m = NS_HEADING_RE.exec(line);
  if (!m) return null;
  return {
    nsNum: Number(m[1]),
    suffix: m[3] ?? null,
    rangeUpperNum: m[2] ? Number(m[2]) : null,
    title: m[4],
  };
}

// ---------- Task 3.3: parseSubFields ----------

const SUB_FIELD_RE = /^- (Status|Type|Priority|Upstream|References|Summary|Exit Criteria): (.+)$/;
const ATOMIC_RE = /^`([^`]+)`(?:\s+(.+))?$/;

const SUB_FIELD_KEY_MAP = {
  Status: "status",
  Type: "type",
  Priority: "priority",
  Upstream: "upstream",
  References: "references",
  Summary: "summary",
  "Exit Criteria": "exit_criteria",
};

export function parseSubFields(body) {
  const fields = {
    status: null,
    type: null,
    priority: null,
    upstream: null,
    references: null,
    summary: null,
    exit_criteria: null,
  };
  for (const line of body.split("\n")) {
    const m = SUB_FIELD_RE.exec(line);
    if (!m) continue;
    const [, label, value] = m;
    const key = SUB_FIELD_KEY_MAP[label];
    if (key === "status" || key === "priority") {
      const am = ATOMIC_RE.exec(value);
      fields[key] = am ? { atomic: am[1], prose: am[2] ?? null } : { atomic: value, prose: null };
    } else {
      fields[key] = value;
    }
  }
  return fields;
}

// ---------- Task 3.4: parsePRsBlock ----------

const PRS_HEADER_RE = /^- PRs:\s*$/;
const PRS_ROW_RE = /^ {2}- \[([ x])\] ([^—]+) — (.+)$/;
const PRS_ANNOTATION_RE = /\s*\(PR #(\d+), merged (\d{4}-\d{2}-\d{2})\)\s*$/;

export function parsePRsBlock(body) {
  const lines = body.split("\n");
  const headerIdx = lines.findIndex((l) => PRS_HEADER_RE.test(l));
  if (headerIdx === -1) return null;
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const m = PRS_ROW_RE.exec(lines[i]);
    if (!m) break;
    const [, mark, taskIdRaw, rest] = m;
    const taskId = taskIdRaw.trim();
    if (mark === "x") {
      const am = PRS_ANNOTATION_RE.exec(rest);
      if (!am) {
        throw new Error(
          `PRs block malformed: checked task ${taskId} missing required (PR #N, merged YYYY-MM-DD) annotation`,
        );
      }
      rows.push({
        taskId,
        description: rest.replace(PRS_ANNOTATION_RE, "").trim(),
        checked: true,
        prNumber: Number(am[1]),
        mergedAt: am[2],
      });
    } else {
      rows.push({
        taskId,
        description: rest.trim(),
        checked: false,
        prNumber: null,
        mergedAt: null,
      });
    }
  }
  return rows;
}

// ---------- Task 3.5: computeStatusFromPRs (§3a.2 matrix) ----------

export function computeStatusFromPRs({ prsBlock, upstreamBlocked, today, prNumber }) {
  // Row 1: absent PRs block → single-PR completion
  if (prsBlock === null) {
    return `- Status: \`completed\` (resolved ${today} via PR #${prNumber} — <TODO subagent prose>)`;
  }
  const checked = prsBlock.filter((r) => r.checked);
  const allUnchecked = checked.length === 0;
  const allChecked = checked.length === prsBlock.length;
  // Rows 2-3: all unchecked
  if (allUnchecked) {
    return upstreamBlocked ? "- Status: `blocked`" : "- Status: `todo`";
  }
  // Row 6: all checked (overrides upstream blocked per matrix "n/a")
  if (allChecked) {
    return `- Status: \`completed\` (resolved ${today} via PR #${prNumber} — last sub-task; <TODO subagent prose>)`;
  }
  // Row 5: ≥1 checked + ≥1 unchecked + upstream blocked → blocked override
  if (upstreamBlocked) {
    return "- Status: `blocked` (overrides — see Upstream: blocked even after partial PRs landed)";
  }
  // Row 4: in_progress with last-shipped citation derived from most-recent merged checked row
  const last = checked.reduce((acc, r) => (r.mergedAt > acc.mergedAt ? r : acc));
  return `- Status: \`in_progress\` (last shipped: PR #${last.prNumber}, ${last.mergedAt})`;
}

// ---------- Task 3.6: extractFileReferences (§3a.4) ----------
//
// Heuristic: scan References (markdown links + bare paths) and Summary
// (bare paths + directory paths) for path tokens; expand brace-tokens
// (bash-style nested expansion); filesystem-resolve each result against
// the working copy; categorize as file / directory / unresolvable.
// Upstream / Type / Status / Priority / Exit Criteria are NOT scanned.
//
// The bare-path char class includes `{},` so brace-bearing tokens match as
// a single regex hit; the trailing `\}*` swallows the outermost closing
// brace that the greedy `[class]+\.(ext)` backtrack drops. The spec's
// regex (without these additions) cannot capture brace tokens — see
// Plan-PR-32 commit message for the deviation rationale.

const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((\.\.\/[^)]+\.md)\)(?::\d+(?:-\d+)?)?/g;
const BARE_PATH_RE =
  /[a-zA-Z0-9_./{},-]+\.(?:md|ts|js|mjs|sql|rs|toml|json|ya?ml)(?::\d+(?:,\d+)*(?:-\d+)?)?\}*/g;
const DIR_PATH_RE = /[a-zA-Z0-9_./-]+\/(?![a-zA-Z0-9_./-])/g;

function expandBraces(token) {
  const open = token.indexOf("{");
  if (open === -1) return [token];
  let depth = 0;
  let close = -1;
  for (let i = open; i < token.length; i += 1) {
    if (token[i] === "{") depth += 1;
    else if (token[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) {
    throw new Error(`brace expansion malformed: unbalanced braces in ${token}`);
  }
  const prefix = token.slice(0, open);
  const inside = token.slice(open + 1, close);
  const suffix = token.slice(close + 1);
  const parts = [];
  let depth2 = 0;
  let last = 0;
  for (let i = 0; i < inside.length; i += 1) {
    if (inside[i] === "{") depth2 += 1;
    else if (inside[i] === "}") depth2 -= 1;
    else if (inside[i] === "," && depth2 === 0) {
      parts.push(inside.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(inside.slice(last));
  if (parts.some((p) => p.length === 0)) {
    throw new Error(`brace expansion malformed: empty alternative in ${token}`);
  }
  const out = [];
  for (const part of parts) {
    out.push(...expandBraces(prefix + part + suffix));
  }
  return out;
}

function stripCite(path) {
  return path.replace(/:\d+(?:,\d+)*(?:-\d+)?$/, "");
}

export function extractFileReferences({ references, summary, repoRoot, entryFile }) {
  const files = new Set();
  const directories = new Set();
  const unresolvable = [];
  const seen = new Set();

  function tryAddFile(repoRel, abs) {
    if (seen.has(repoRel)) return;
    seen.add(repoRel);
    if (existsSync(abs) && statSync(abs).isFile()) {
      files.add(repoRel);
    } else {
      unresolvable.push({ path: repoRel, path_kind: "file" });
    }
  }
  function tryAddDir(repoRel, abs) {
    if (seen.has(repoRel)) return;
    seen.add(repoRel);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      directories.add(repoRel);
    } else {
      unresolvable.push({ path: repoRel, path_kind: "directory" });
    }
  }

  // 1. Markdown links from References (resolve relative to entryFile dir)
  let refsStripped = references ?? "";
  if (references && entryFile) {
    const entryDir = dirname(entryFile);
    for (const m of references.matchAll(MARKDOWN_LINK_RE)) {
      const abs = resolve(entryDir, m[2]);
      const repoRel = relative(repoRoot, abs);
      tryAddFile(repoRel, abs);
    }
    refsStripped = references.replace(MARKDOWN_LINK_RE, "");
  }

  // 2 + 4. Bare paths (with brace expansion) from refsStripped + summary
  for (const text of [refsStripped, summary ?? ""]) {
    for (const m of text.matchAll(BARE_PATH_RE)) {
      const token = stripCite(m[0]);
      const expanded = expandBraces(token);
      for (const path of expanded) {
        const abs = isAbsolute(path) ? path : resolve(repoRoot, path);
        tryAddFile(path, abs);
      }
    }
  }
  const refsForDirs = refsStripped.replace(BARE_PATH_RE, "");
  const summaryForDirs = (summary ?? "").replace(BARE_PATH_RE, "");

  // 3. Directory paths (trailing /) from stripped sources
  for (const text of [refsForDirs, summaryForDirs]) {
    for (const m of text.matchAll(DIR_PATH_RE)) {
      const path = m[0];
      const normalized = path.replace(/\/$/, "");
      const abs = isAbsolute(normalized) ? normalized : resolve(repoRoot, normalized);
      tryAddDir(path, abs);
    }
  }

  return {
    files: Array.from(files),
    directories: Array.from(directories),
    unresolvable,
  };
}

// ---------- Task 3.7: parseArgs (§5.1 step 0) ----------
//
// Throws ParseArgsError(exitCode≥6) on mutual-exclusion or shape-validation
// violations (Plan Invariant I-7). The CLI entrypoint (Task 3.19) translates
// `error.exitCode` into the process exit code so callers can route on it.
//
// `--task` regex per Plan §Decisions-Locked D-4 (widens spec §5.1 to include
// `tier-K` for §4.3.2 rule-3 dispatch).
//
// `--candidate-ns` is intentionally permissive when passed alone: the cleanup/
// governance carve-out (no plan/task/tier required) is enforced at runtime by
// Task 3.10 plan-identity sanity, not here. parseArgs only enforces:
//   - exactly one of {--candidate-ns, --auto-create}
//   - at-least-one of {--plan, --task, --tier} when --auto-create

export class ParseArgsError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "ParseArgsError";
    this.exitCode = exitCode;
  }
}

const PR_NUMBER_RE = /^\d+$/;
const CANDIDATE_NS_TOKEN_RE = /^NS-\d+[a-z]?(?:\.\.NS-\d+)?$/;
const PLAN_RE = /^\d{3}(-partial)?$/;
const PHASE_RE = /^(\d+|[A-Z])$/;
const TASK_RE = /^(T\d+(\.\d+)?|T-\d{3}-\d+-\d+|tier-\d+)$/;
const TIER_RE = /^\d+$/;

const VALUE_FLAGS = new Set([
  "--candidate-ns",
  "--plan",
  "--phase",
  "--task",
  "--tier",
  "--pr-tag",
]);
const BOOLEAN_FLAGS = new Set(["--auto-create"]);

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new ParseArgsError("missing positional <PR#> argument", 6);
  }
  const [first, ...rest] = argv;
  if (!PR_NUMBER_RE.test(first)) {
    throw new ParseArgsError(`<PR#> must be a positive integer, got: ${first}`, 6);
  }
  const result = {
    prNumber: Number(first),
    candidateNs: null,
    autoCreate: false,
    plan: null,
    phase: null,
    task: null,
    tier: null,
    prTag: null,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (BOOLEAN_FLAGS.has(flag)) {
      if (flag === "--auto-create") result.autoCreate = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new ParseArgsError(`unknown flag: ${flag}`, 6);
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ParseArgsError(`flag ${flag} requires a value`, 6);
    }
    i += 1;
    switch (flag) {
      case "--candidate-ns": {
        for (const token of value.split(",")) {
          if (!CANDIDATE_NS_TOKEN_RE.test(token)) {
            throw new ParseArgsError(`--candidate-ns token malformed: ${token}`, 6);
          }
        }
        result.candidateNs = value;
        break;
      }
      case "--plan":
        if (!PLAN_RE.test(value)) throw new ParseArgsError(`--plan malformed: ${value}`, 6);
        result.plan = value;
        break;
      case "--phase":
        if (!PHASE_RE.test(value)) throw new ParseArgsError(`--phase malformed: ${value}`, 6);
        result.phase = value;
        break;
      case "--task":
        if (!TASK_RE.test(value)) throw new ParseArgsError(`--task malformed: ${value}`, 6);
        result.task = value;
        break;
      case "--tier":
        if (!TIER_RE.test(value)) throw new ParseArgsError(`--tier malformed: ${value}`, 6);
        result.tier = value;
        break;
      case "--pr-tag":
        result.prTag = value;
        break;
    }
  }
  const hasCandidate = result.candidateNs !== null;
  if (hasCandidate && result.autoCreate) {
    throw new ParseArgsError("--candidate-ns and --auto-create are mutually exclusive", 6);
  }
  if (!hasCandidate && !result.autoCreate) {
    throw new ParseArgsError("must pass exactly one of --candidate-ns or --auto-create", 6);
  }
  if (result.autoCreate && result.plan === null && result.task === null && result.tier === null) {
    throw new ParseArgsError("--auto-create requires at least one of --plan, --task, --tier", 6);
  }
  return result;
}

// ---------- Tasks 3.8-3.10: verifiers (§5.1 step 3) ----------
//
// Three-state outcome for callers (orchestrator, Task 3.18):
//   { ok: true }                                     — pass, no annotation needed
//   { ok: true, kind: "<discriminator>" }            — pass with discriminator (file-overlap)
//   { ok: true, concerns: [{kind: "..."}] }          — pass with concern → manifest annotation
//   { ok: false, failure: { kind: "..." } }          — halt, surface in verification_failures
//
// SKIP families (per §5.1 step 3 carve-outs):
//   cleanup* / governance* — SKIP file-overlap AND plan-identity
//   audit*                 — SKIP file-overlap (plan-identity still checked via Plan-NNN substring)

const CLEANUP_TYPES = new Set(["cleanup", "cleanup (doc-only)"]);
const GOVERNANCE_TYPES = new Set([
  "governance",
  "governance (doc-only)",
  "governance (load-bearing)",
]);

function isAudit(type) {
  return type.startsWith("audit");
}

function isCodeGovernance(type) {
  return (
    type === "code + governance" ||
    type === "code (cross-plan PR pair, internally a 3-step sequence)"
  );
}

function partitionTouches(touchedFiles) {
  let docs = false;
  let code = false;
  for (const f of touchedFiles) {
    if (f.startsWith("docs/")) docs = true;
    else code = true;
  }
  return { docs, code };
}

export function verifyTypeSignature({ type, touchedFiles }) {
  if (CLEANUP_TYPES.has(type)) {
    return { ok: true, concerns: [{ kind: "cleanup_diff_unverified" }] };
  }
  const { docs, code } = partitionTouches(touchedFiles);
  if (type === "code") {
    return code ? { ok: true } : { ok: false, failure: { kind: "type_signature_violation" } };
  }
  if (isAudit(type) || GOVERNANCE_TYPES.has(type)) {
    return docs && !code
      ? { ok: true }
      : { ok: false, failure: { kind: "type_signature_violation" } };
  }
  if (isCodeGovernance(type)) {
    return docs && code
      ? { ok: true }
      : { ok: false, failure: { kind: "type_signature_violation" } };
  }
  return { ok: false, failure: { kind: "type_signature_unknown_type" } };
}

const FILE_OVERLAP_SKIP_TYPES = new Set([...CLEANUP_TYPES, ...GOVERNANCE_TYPES]);

export function verifyFileOverlap({ type, refs, touched }) {
  if (FILE_OVERLAP_SKIP_TYPES.has(type) || isAudit(type)) {
    return { ok: true, kind: "skip" };
  }
  const refsEmpty = refs.files.length === 0 && refs.directories.length === 0;
  if (refsEmpty) {
    return { ok: true, concerns: [{ kind: "file_overlap_unverifiable_for_sparse_body" }] };
  }
  const touchedSet = new Set(touched);
  let kind = null;
  for (const f of refs.files) {
    if (touchedSet.has(f)) {
      kind = "pass_file_path";
      break;
    }
  }
  if (kind === null) {
    for (const d of refs.directories) {
      if (touched.some((t) => t.startsWith(d))) {
        kind = "pass_dir_prefix";
        break;
      }
    }
  }
  if (kind === null) {
    return { ok: false, failure: { kind: "file_overlap_zero" } };
  }
  const allRefsDocs =
    refs.files.every((f) => f.startsWith("docs/")) &&
    refs.directories.every((d) => d.startsWith("docs/"));
  if (allRefsDocs) kind = "pass_doc_path_only";
  return { ok: true, kind };
}

const PLAN_IDENTITY_SKIP_TYPES = new Set([...CLEANUP_TYPES, ...GOVERNANCE_TYPES]);

export function verifyPlanIdentity({ headingTitle, args, type, rangeBoundaries }) {
  if (PLAN_IDENTITY_SKIP_TYPES.has(type)) {
    return { ok: true, concerns: [{ kind: "plan_identity_skipped_for_manual_dispatch" }] };
  }
  if (args.plan && headingTitle.includes(`Plan-${args.plan}`)) return { ok: true };
  if (args.task && headingTitle.includes(args.task)) return { ok: true };
  if (args.tier) {
    if (headingTitle.includes(`Tier ${args.tier}`)) return { ok: true };
    if (rangeBoundaries) {
      const k = Number(args.tier);
      if (k >= rangeBoundaries.K1 && k <= rangeBoundaries.K2) return { ok: true };
    }
  }
  return { ok: false, failure: { kind: "plan_identity_missing" } };
}

// ---------- Tasks 3.11-3.14: mechanical edits (§5.1 steps 5-7) ----------

export function applyStatusFlipSinglePr({ lines, statusLineIndex, prNumber, today }) {
  const result = [...lines];
  result[statusLineIndex] =
    `- Status: \`completed\` (resolved ${today} via PR #${prNumber} — <TODO subagent prose>)`;
  return result;
}

const PRS_UNCHECKED_ROW_RE = /^ {2}- \[ \] (\S+) — (.+)$/;

export function applyMultiPrTickAndRecompute({
  lines,
  statusLineIndex,
  prsBlockStartIndex,
  taskId,
  prNumber,
  today,
  upstreamBlocked,
  upstreamNsRef,
}) {
  const result = [...lines];
  for (let i = prsBlockStartIndex + 1; i < result.length; i += 1) {
    const m = PRS_UNCHECKED_ROW_RE.exec(result[i]);
    if (!m) {
      // Non-PRs-row line ends the block (defensive — orchestrator passes a clean prsBlockStartIndex)
      if (!result[i].startsWith("  - [")) break;
      continue;
    }
    if (m[1] === taskId) {
      result[i] = `  - [x] ${taskId} — ${m[2]} (PR #${prNumber}, merged ${today})`;
      break;
    }
  }
  const prsBlock = parsePRsBlock(result.slice(prsBlockStartIndex).join("\n"));
  const allChecked = prsBlock.every((r) => r.checked);
  if (upstreamBlocked && !allChecked) {
    const checked = prsBlock.filter((r) => r.checked);
    const last = checked.reduce((acc, r) => (r.mergedAt > acc.mergedAt ? r : acc));
    result[statusLineIndex] =
      `- Status: \`blocked\` (blocked-on ${upstreamNsRef}; last shipped: PR #${last.prNumber}, ${last.mergedAt})`;
  } else {
    result[statusLineIndex] = computeStatusFromPRs({
      prsBlock,
      upstreamBlocked: false,
      today,
      prNumber,
    });
  }
  return result;
}

const MERMAID_NODE_RE = /(NS(\d+))\[([^\]]+)\]:::(ready|blocked|completed|governance)/g;
const CLASSDEF_RE = /^\s*classDef\b/;

export function applyMermaidClassSwap({ lines, nsNum, newClass }) {
  const result = [...lines];
  const targetId = `NS${String(nsNum).padStart(2, "0")}`;
  for (let i = 0; i < result.length; i += 1) {
    if (CLASSDEF_RE.test(result[i])) continue;
    const original = result[i];
    const replaced = original.replace(MERMAID_NODE_RE, (match, fullId, _digits, body, _cls) =>
      fullId === targetId ? `${fullId}[${body}]:::${newClass}` : match,
    );
    if (replaced !== original) result[i] = replaced;
  }
  return result;
}

export function tickPlanDoneChecklist({ lines, phase }) {
  const result = [...lines];
  const phaseHeadingRe = new RegExp(`^### Phase ${phase}\\b`);
  let phaseStart = -1;
  for (let i = 0; i < result.length; i += 1) {
    if (phaseHeadingRe.test(result[i])) {
      phaseStart = i;
      break;
    }
  }
  if (phaseStart === -1) return { lines: result, ticksApplied: 0, notFound: true };
  let phaseEnd = result.length;
  for (let i = phaseStart + 1; i < result.length; i += 1) {
    if (/^### Phase /.test(result[i])) {
      phaseEnd = i;
      break;
    }
  }
  let checklistStart = -1;
  for (let i = phaseStart; i < phaseEnd; i += 1) {
    if (/^#### Done Checklist/.test(result[i])) {
      checklistStart = i;
      break;
    }
  }
  if (checklistStart === -1) return { lines: result, ticksApplied: 0, notFound: true };
  let ticksApplied = 0;
  for (let i = checklistStart + 1; i < phaseEnd; i += 1) {
    if (result[i].startsWith("- [ ] ")) {
      result[i] = "- [x] " + result[i].slice(6);
      ticksApplied += 1;
    }
  }
  return { lines: result, ticksApplied };
}

// ---------- Task 3.15: emitManifest (§5.3 schema) ----------
//
// Writes the post-merge manifest under <repoRoot>/.agents/tmp/. The shape
// follows §5.3 verbatim: pre-script fields populated; subagent-stage fields
// (subagent_completed_at / semantic_edits / concerns / result) emitted as
// null|empty stubs so consumers can switch on them without hasOwnProperty.
//
// auto_create is always present at top level — null in --candidate-ns mode,
// {reserved_ns_nn, derived_title_seed} in --auto-create mode (P5 fix).

export function emitManifest({
  repoRoot,
  prNumber,
  generatedAt = null,
  plan = null,
  phase = null,
  taskId = null,
  scriptExitCode,
  matchedEntry = null,
  autoCreate = null,
  mechanicalEdits = {},
  schemaViolations = [],
  affectedFiles = [],
  semanticWorkPending = [],
  warnings = [],
}) {
  const tmpDir = join(repoRoot, ".agents", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const manifestPath = join(tmpDir, `housekeeper-manifest-PR${prNumber}.json`);
  const manifest = {
    generated_at: generatedAt ?? new Date().toISOString(),
    pr_number: prNumber,
    plan,
    phase,
    task_id: taskId,
    script_exit_code: scriptExitCode,
    matched_entry:
      matchedEntry === null
        ? null
        : {
            ns_id: matchedEntry.nsId,
            heading: matchedEntry.heading,
            shape: matchedEntry.shape,
            file: matchedEntry.file,
            heading_line: matchedEntry.headingLine,
          },
    auto_create:
      autoCreate == null
        ? null
        : {
            reserved_ns_nn: autoCreate.reservedNsNn,
            derived_title_seed: autoCreate.derivedTitleSeed,
          },
    mechanical_edits: mechanicalEdits,
    schema_violations: schemaViolations,
    affected_files: affectedFiles,
    semantic_work_pending: semanticWorkPending,
    warnings,
    subagent_completed_at: null,
    semantic_edits: {},
    concerns: [],
    result: null,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifestPath };
}

// ---------- Task 3.16: reserveNextFreeNs (auto-create step 1') ----------

export function reserveNextFreeNs(content) {
  const seenIds = new Set();
  const seenIntegers = new Set();
  for (const line of content.split("\n")) {
    const heading = parseNsHeading(line);
    if (heading === null) continue;
    const id = `NS-${String(heading.nsNum).padStart(2, "0")}${heading.suffix ?? ""}`;
    if (seenIds.has(id)) {
      throw new Error(`duplicate ${id} heading detected in §6 corpus`);
    }
    seenIds.add(id);
    const top = heading.rangeUpperNum ?? heading.nsNum;
    for (let n = heading.nsNum; n <= top; n++) {
      seenIntegers.add(n);
    }
  }
  if (seenIntegers.size === 0) return 1;
  return Math.max(...seenIntegers) + 1;
}

// ---------- Task 3.17: checkDuplicateTitle (auto-create step 2') ----------

export function checkDuplicateTitle({ existingTitles, newTitle }) {
  for (const existing of existingTitles) {
    if (existing.includes(newTitle) || newTitle.includes(existing)) {
      return {
        ok: false,
        failure: { kind: "auto_create_duplicate_title", colliding_with: existing },
      };
    }
  }
  return { ok: true };
}

// ---------- Tasks 3.18-3.19: runHousekeeper orchestrator + CLI entrypoint ----------
//
// Glue for §5.1's pipeline (locate → schema-validate → verify → mechanical edit →
// plan checklist tick → emit manifest). Returns { exitCode, manifestPath }; never
// throws on exit ≥ 1 (only on internal bugs). The verifier trio is silently
// SKIPPED when diffTouchedFiles is null — the CLI computes git-diff and passes
// the touched-file list; the fixture harness omits it (since fixture trees aren't
// real git diffs and would otherwise fail Type-signature for code-typed entries).

const NS_ID = (nsNum, suffix) => `NS-${String(nsNum).padStart(2, "0")}${suffix ?? ""}`;

const SEMANTIC_WORK_PENDING_COMPLETION = [
  "compose_status_completion_prose",
  "ready_set_re_derivation",
  "line_cite_sweep",
  "set_quantifier_reverification",
  "ns_auto_create_evaluation",
  "unannotated_referenced_files_check",
];

function locateNsEntry({ lines, candidateNs }) {
  for (let i = 0; i < lines.length; i += 1) {
    const heading = parseNsHeading(lines[i]);
    if (heading === null) continue;
    const id = NS_ID(heading.nsNum, heading.suffix);
    const rangeId = heading.rangeUpperNum
      ? `NS-${String(heading.nsNum).padStart(2, "0")}..NS-${String(heading.rangeUpperNum).padStart(2, "0")}`
      : null;
    if (id !== candidateNs && rangeId !== candidateNs) continue;
    let bodyEnd = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (/^#{1,6} /.test(l) || /^```/.test(l)) {
        bodyEnd = j;
        break;
      }
    }
    return {
      headingLine: i,
      heading: lines[i],
      headingTitle: heading.title,
      nsNum: heading.nsNum,
      suffix: heading.suffix,
      rangeUpperNum: heading.rangeUpperNum,
      bodyEnd,
    };
  }
  return null;
}

function findStatusLineIndex({ lines, headingLine, bodyEnd }) {
  for (let i = headingLine + 1; i < bodyEnd; i += 1) {
    if (/^- Status:/.test(lines[i])) return i;
  }
  return -1;
}

function findPrsBlockStartIndex({ lines, headingLine, bodyEnd }) {
  for (let i = headingLine + 1; i < bodyEnd; i += 1) {
    if (PRS_HEADER_RE.test(lines[i])) return i;
  }
  return -1;
}

function findMermaidNode({ lines, nsNum }) {
  const targetId = `NS${String(nsNum).padStart(2, "0")}`;
  const NODE_RE = new RegExp(`\\b${targetId}\\[[^\\]]+\\]:::(\\w+)`);
  for (let i = 0; i < lines.length; i += 1) {
    if (CLASSDEF_RE.test(lines[i])) continue;
    const m = NODE_RE.exec(lines[i]);
    if (m) return { lineIndex: i, currentClass: m[1] };
  }
  return null;
}

function findPlanFile({ repoRoot, plan }) {
  const plansDir = join(repoRoot, "docs", "plans");
  if (!existsSync(plansDir)) return null;
  const matches = readdirSync(plansDir).filter(
    (name) => name.startsWith(`${plan}-`) && name.endsWith(".md"),
  );
  if (matches.length !== 1) return null;
  return join(plansDir, matches[0]);
}

function emitFailureManifest(opts) {
  emitManifest({
    autoCreate: null,
    mechanicalEdits: {},
    affectedFiles: [],
    semanticWorkPending: [],
    warnings: [],
    ...opts,
  });
}

export async function runHousekeeper({
  args,
  repoRoot,
  today = process.env.HOUSEKEEPER_TODAY ?? new Date().toISOString().slice(0, 10),
  diffTouchedFiles = null,
}) {
  const generatedAt = `${today}T00:00:00Z`;
  const corpusRel = "docs/architecture/cross-plan-dependencies.md";
  const corpusPath = join(repoRoot, corpusRel);
  const baseManifest = {
    repoRoot,
    prNumber: args.prNumber,
    generatedAt,
    plan: args.plan,
    phase: args.phase,
    taskId: args.task ?? null,
  };

  if (!existsSync(corpusPath)) {
    emitFailureManifest({
      ...baseManifest,
      scriptExitCode: 1,
      schemaViolations: [{ kind: "corpus_file_missing", path: corpusRel }],
    });
    return { exitCode: 1 };
  }

  const corpusText = readFileSync(corpusPath, "utf8");
  let corpusLines = corpusText.split("\n");

  if (!args.candidateNs) {
    emitFailureManifest({
      ...baseManifest,
      scriptExitCode: 1,
      schemaViolations: [{ kind: "auto_create_not_implemented" }],
    });
    return { exitCode: 1 };
  }

  const located = locateNsEntry({ lines: corpusLines, candidateNs: args.candidateNs });
  if (located === null) {
    emitFailureManifest({
      ...baseManifest,
      scriptExitCode: 1,
      schemaViolations: [{ kind: "ns_entry_not_found", ns_id: args.candidateNs }],
    });
    return { exitCode: 1 };
  }

  const nsId = NS_ID(located.nsNum, located.suffix);
  const matchedEntryBase = {
    nsId,
    heading: located.heading,
    file: corpusRel,
    headingLine: located.headingLine + 1,
  };

  const body = corpusLines.slice(located.headingLine + 1, located.bodyEnd).join("\n");
  const fields = parseSubFields(body);
  const requiredFields = ["status", "type", "references", "summary"];
  const violations = requiredFields
    .filter((f) => fields[f] === null)
    .map((f) => ({ kind: "schema_violation", field: f }));
  if (violations.length > 0) {
    emitFailureManifest({
      ...baseManifest,
      scriptExitCode: 5,
      matchedEntry: { ...matchedEntryBase, shape: "unknown" },
      schemaViolations: violations,
    });
    return { exitCode: 5 };
  }

  const prsBlock = parsePRsBlock(body);
  const shape = prsBlock === null ? "single-pr" : "multi-pr";

  if (diffTouchedFiles !== null) {
    const typeCheck = verifyTypeSignature({ type: fields.type, touchedFiles: diffTouchedFiles });
    if (!typeCheck.ok) {
      emitFailureManifest({
        ...baseManifest,
        scriptExitCode: 2,
        matchedEntry: { ...matchedEntryBase, shape },
        schemaViolations: [typeCheck.failure],
      });
      return { exitCode: 2 };
    }
  }

  if (shape === "multi-pr" && !args.task) {
    emitFailureManifest({
      ...baseManifest,
      scriptExitCode: 4,
      matchedEntry: { ...matchedEntryBase, shape },
      schemaViolations: [{ kind: "multi_pr_requires_task_arg" }],
    });
    return { exitCode: 4 };
  }

  let statusFlip;
  let prsBlockTicks = [];

  if (shape === "single-pr") {
    const statusLineIndex = findStatusLineIndex({
      lines: corpusLines,
      headingLine: located.headingLine,
      bodyEnd: located.bodyEnd,
    });
    const fromLine = corpusLines[statusLineIndex];
    corpusLines = applyStatusFlipSinglePr({
      lines: corpusLines,
      statusLineIndex,
      prNumber: args.prNumber,
      today,
    });
    statusFlip = {
      ns_id: nsId,
      from_line: fromLine,
      to_line: corpusLines[statusLineIndex],
      computed_via: "single-pr direct flip",
    };
  } else {
    const statusLineIndex = findStatusLineIndex({
      lines: corpusLines,
      headingLine: located.headingLine,
      bodyEnd: located.bodyEnd,
    });
    const prsBlockStartIndex = findPrsBlockStartIndex({
      lines: corpusLines,
      headingLine: located.headingLine,
      bodyEnd: located.bodyEnd,
    });
    const fromLine = corpusLines[statusLineIndex];
    corpusLines = applyMultiPrTickAndRecompute({
      lines: corpusLines,
      statusLineIndex,
      prsBlockStartIndex,
      taskId: args.task,
      prNumber: args.prNumber,
      today,
      upstreamBlocked: false,
      upstreamNsRef: null,
    });
    prsBlockTicks = [{ ns_id: nsId, task_id: args.task }];
    statusFlip = {
      ns_id: nsId,
      from_line: fromLine,
      to_line: corpusLines[statusLineIndex],
      computed_via: "prs-matrix recompute",
    };
  }

  let mermaidClassSwap = null;
  const newClassFlipped =
    corpusLines[
      findStatusLineIndex({
        lines: corpusLines,
        headingLine: located.headingLine,
        bodyEnd: located.bodyEnd,
      })
    ].includes("`completed`");
  if (newClassFlipped) {
    const node = findMermaidNode({ lines: corpusLines, nsNum: located.nsNum });
    if (node !== null) {
      const fromClass = `:::${node.currentClass}`;
      corpusLines = applyMermaidClassSwap({
        lines: corpusLines,
        nsNum: located.nsNum,
        newClass: "completed",
      });
      mermaidClassSwap = {
        ns_id: nsId,
        from: fromClass,
        to: ":::completed",
        node_line: node.lineIndex + 1,
      };
    }
  }

  const planChecklistTicks = [];
  const affectedFiles = [corpusRel];
  const warnings = [];
  let scriptExitCode = 0;
  if (args.plan && args.phase) {
    let didTick = false;
    const planFile = findPlanFile({ repoRoot, plan: args.plan });
    if (planFile !== null) {
      const planLines = readFileSync(planFile, "utf8").split("\n");
      const tickResult = tickPlanDoneChecklist({ lines: planLines, phase: args.phase });
      if (!tickResult.notFound && tickResult.ticksApplied > 0) {
        writeFileSync(planFile, tickResult.lines.join("\n"));
        const planRel = relative(repoRoot, planFile);
        planChecklistTicks.push({
          file: planRel,
          phase: args.phase,
          items_ticked: tickResult.ticksApplied,
        });
        affectedFiles.push(planRel);
        didTick = true;
      }
    }
    // Per spec §5.1 line 505 + line 950: exit 3 (soft-failure, continue) when
    // the plan checklist is unreachable — covers (a) plan file not found,
    // (b) `### Phase N` section absent, (c) Done Checklist sub-section absent,
    // (d) all boxes already ticked from a prior partial run. Mechanical edits
    // to the corpus are still applied; the warning propagates to the subagent
    // which surfaces it as a `concerns` entry with kind: plan_checklist_not_found.
    if (!didTick) {
      scriptExitCode = 3;
      warnings.push({
        kind: "plan_checklist_not_found",
        plan: args.plan,
        phase: args.phase,
      });
    }
  }

  writeFileSync(corpusPath, corpusLines.join("\n"));

  const { manifestPath } = emitManifest({
    ...baseManifest,
    scriptExitCode,
    matchedEntry: { ...matchedEntryBase, shape },
    autoCreate: null,
    mechanicalEdits: {
      status_flip: statusFlip,
      prs_block_ticks: prsBlockTicks,
      mermaid_class_swap: mermaidClassSwap,
      plan_checklist_ticks: planChecklistTicks,
    },
    affectedFiles,
    semanticWorkPending: SEMANTIC_WORK_PENDING_COMPLETION,
    warnings,
  });

  return { exitCode: scriptExitCode, manifestPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runHousekeeper({ args, repoRoot: process.cwd() });
    process.exit(result.exitCode);
  } catch (err) {
    if (err instanceof ParseArgsError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    throw err;
  }
}
