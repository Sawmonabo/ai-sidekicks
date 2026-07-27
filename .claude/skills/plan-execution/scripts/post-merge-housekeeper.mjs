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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
// node:fs + node:path only — Plan Invariant I-3 holds through this import.
import { planFilesystemKey, resolvePlanFile } from "./lib/plan-file.mjs";

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

// Positive-integer regex: rejects empty, `0`, `00`, and leading zeros (`01`).
// PR numbers and tier numbers MUST be > 0 — `0` flowing in from an unset
// upstream env var default would otherwise corrupt the audit trail with
// "PR #0" / "Tier 0" instead of failing fast at arg parse.
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;
const PR_NUMBER_RE = POSITIVE_INTEGER_RE;
// `\d{2,}` (min 2 digits) matches the canonical zero-padded form that
// `NS_ID()` (line 770) emits via `String(n).padStart(2, "0")`. Pre-fix the
// regex accepted `\d+`, so `--candidate-ns NS-1` would parse but silently
// fail `locateNsEntry` (which compares against the canonical `NS-01`),
// surfacing as `ns_entry_not_found` rather than fail-fast at arg parse.
// REJECT (not normalize) — force the orchestrator to pass canonical form.
const CANDIDATE_NS_TOKEN_RE = /^NS-\d{2,}[a-z]?(?:\.\.NS-\d{2,})?$/;
const PLAN_RE = /^\d{3}(-partial)?$/;
const PHASE_RE = /^(\d+|[A-Z])$/;
const TASK_RE = /^(T\d+(\.\d+)?|T-\d{3}-\d+-\d+|tier-\d+)$/;
const TIER_RE = POSITIVE_INTEGER_RE;
// Mirrors lib/manifest.mjs SHA_RE + DATE_RE — single-source-of-truth lives in
// the shared module; we re-validate at the CLI surface so a malformed value
// fails fast at parseArgs rather than producing an invalid manifest entry the
// orchestrator's appendManifestEntry would later reject.
const SQUASH_SHA_RE = /^[0-9a-f]{7,40}$/i;
const MERGED_AT_RE = /^\d{4}-\d{2}-\d{2}$/;

const VALUE_FLAGS = new Set([
  "--candidate-ns",
  "--plan",
  "--phase",
  "--task",
  "--tier",
  "--pr-tag",
  "--touched-files-path",
  "--squash-sha",
  "--merged-at",
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
    touchedFilesPath: null,
    squashSha: null,
    mergedAt: null,
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
      case "--touched-files-path":
        result.touchedFilesPath = value;
        break;
      case "--squash-sha":
        if (!SQUASH_SHA_RE.test(value)) {
          throw new ParseArgsError(`--squash-sha malformed: ${value}`, 6);
        }
        result.squashSha = value;
        break;
      case "--merged-at":
        if (!MERGED_AT_RE.test(value)) {
          throw new ParseArgsError(`--merged-at malformed: ${value}`, 6);
        }
        result.mergedAt = value;
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
    return code ? { ok: true } : { ok: false, failure: { kind: "type_signature_mismatch" } };
  }
  if (isAudit(type) || GOVERNANCE_TYPES.has(type)) {
    return docs && !code
      ? { ok: true }
      : { ok: false, failure: { kind: "type_signature_mismatch" } };
  }
  if (isCodeGovernance(type)) {
    return docs && code
      ? { ok: true }
      : { ok: false, failure: { kind: "type_signature_mismatch" } };
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

const REGEX_SPECIALS_RE = /[.*+?^${}()|[\]\\]/g;

// Token-bounded match: needle must not be flanked by [\w.-] on either side.
// Plain `.includes()` lets `--task T5` collide with heading `T5.4` (period
// continues the token) and `--tier 1` collide with `Tier 10` (digit continues).
// Periods and hyphens are treated as continuation chars because real task IDs
// use both forms (e.g., `T5.4`, `T-024-2-1`) per cross-plan-dependencies.md.
function tokenBoundedRe(needle) {
  const escaped = needle.replace(REGEX_SPECIALS_RE, "\\$&");
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`);
}

export function verifyPlanIdentity({ headingTitle, args, type, rangeBoundaries }) {
  if (PLAN_IDENTITY_SKIP_TYPES.has(type)) {
    return { ok: true, concerns: [{ kind: "plan_identity_skipped_for_manual_dispatch" }] };
  }
  if (args.plan && tokenBoundedRe(`Plan-${args.plan}`).test(headingTitle)) return { ok: true };
  if (args.task && tokenBoundedRe(args.task).test(headingTitle)) return { ok: true };
  if (args.tier) {
    if (tokenBoundedRe(`Tier ${args.tier}`).test(headingTitle)) return { ok: true };
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

// Caller must pre-validate prsBlockBeforeTick (orchestrator's job per
// validateCandidate / single-candidate's pre-validation): every taskId is
// resolvable and the row matching `taskId` is present and unchecked. We
// derive prsBlockAfterTick by mapping the validated structure rather than
// re-parsing the post-tick lines, which both eliminates a redundant parse
// and removes a throw site that previously crashed the CLI on a malformed
// PRs block (the parse already happened upstream and was wrapped there).
export function applyMultiPrTickAndRecompute({
  lines,
  statusLineIndex,
  prsBlockStartIndex,
  prsBlockBeforeTick,
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
  const prsBlockAfterTick = prsBlockBeforeTick.map((r) =>
    r.taskId === taskId ? { ...r, checked: true, prNumber, mergedAt: today } : r,
  );
  const allChecked = prsBlockAfterTick.every((r) => r.checked);
  if (upstreamBlocked && !allChecked) {
    const checked = prsBlockAfterTick.filter((r) => r.checked);
    const last = checked.reduce((acc, r) => (r.mergedAt > acc.mergedAt ? r : acc));
    result[statusLineIndex] =
      `- Status: \`blocked\` (blocked-on ${upstreamNsRef}; last shipped: PR #${last.prNumber}, ${last.mergedAt})`;
  } else {
    result[statusLineIndex] = computeStatusFromPRs({
      prsBlock: prsBlockAfterTick,
      upstreamBlocked: false,
      today,
      prNumber,
    });
  }
  return result;
}

const MERMAID_NODE_RE = /(NS(\d+)([a-z])?)\[([^\]]+)\]:::(ready|blocked|completed|governance)/g;
const CLASSDEF_RE = /^\s*classDef\b/;

export function applyMermaidClassSwap({ lines, nsNum, suffix = null, newClass }) {
  const result = [...lines];
  const targetId = `NS${String(nsNum).padStart(2, "0")}${suffix ?? ""}`;
  for (let i = 0; i < result.length; i += 1) {
    if (CLASSDEF_RE.test(result[i])) continue;
    const original = result[i];
    const replaced = original.replace(
      MERMAID_NODE_RE,
      (match, fullId, _digits, _suffix, body, _cls) =>
        fullId === targetId ? `${fullId}[${body}]:::${newClass}` : match,
    );
    if (replaced !== original) result[i] = replaced;
  }
  return result;
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
//
// proposed_manifest_entry is the script's draft of the in-plan
// `### Shipment Manifest` YAML entry the orchestrator appends in Phase E
// step 6 via lib/housekeeper-orchestrator-helpers.buildFinalManifestEntry.
// Null when --squash-sha or --merged-at is omitted (graceful degradation
// for fixture tests + legacy callers); the script never edits the plan
// file's manifest block itself (Plan Invariant I-3 — no git/file ownership).

export function buildProposedManifestEntry({ args, diffTouchedFiles }) {
  if (!args.squashSha || !args.mergedAt) return null;
  if (!args.plan || !args.phase || !args.task) return null;
  // Phase A-Z (Tier-A / Tier-B style) cannot be expressed as a positive
  // integer; the manifest schema requires `phase: <int>`. Skip rather than
  // coerce — any later consumer would reject NaN.
  const phaseNum = Number(args.phase);
  if (!Number.isInteger(phaseNum) || phaseNum < 1) return null;
  return {
    phase: phaseNum,
    task: args.task,
    pr: args.prNumber,
    sha: args.squashSha,
    merged_at: args.mergedAt,
    files: diffTouchedFiles ?? [],
    // verifies_invariant + spec_coverage come from the audit Tasks-block
    // (analyst output → DAG → orchestrator). The script has no DAG access;
    // the orchestrator's Phase E step 6 helper merges these in before the
    // final appendManifestEntry call.
    verifies_invariant: [],
    spec_coverage: [],
  };
}

export function emitManifest({
  repoRoot,
  prNumber,
  generatedAt = null,
  plan = null,
  phase = null,
  taskId = null,
  scriptExitCode,
  matchedEntry = null,
  matchedEntries = null,
  autoCreate = null,
  mechanicalEdits = {},
  schemaViolations = [],
  verificationFailures = [],
  affectedFiles = [],
  semanticWorkPending = [],
  warnings = [],
  proposedManifestEntry = null,
}) {
  const tmpDir = join(repoRoot, ".agents", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const manifestPath = join(tmpDir, `housekeeper-manifest-PR${prNumber}.json`);
  // Multi-candidate (--candidate-ns NS-XX,NS-YY) sets matchedEntries (plural)
  // and leaves matched_entry null. Single-candidate sets matchedEntry and
  // leaves matched_entries null. Subagent-stage consumers switch on whichever
  // is non-null; emitting both keys (one always null) keeps the schema closed.
  const serializeEntry = (e) => ({
    ns_id: e.nsId,
    heading: e.heading,
    shape: e.shape,
    file: e.file,
    heading_line: e.headingLine,
  });
  const manifest = {
    generated_at: generatedAt ?? new Date().toISOString(),
    pr_number: prNumber,
    plan,
    phase,
    task_id: taskId,
    script_exit_code: scriptExitCode,
    matched_entry: matchedEntry === null ? null : serializeEntry(matchedEntry),
    // matched_entries is OMITTED entirely (not null) when single-candidate so
    // existing fixture manifests stay byte-for-byte stable. Subagent consumers
    // detect multi-candidate by checking `Array.isArray(manifest.matched_entries)`.
    ...(matchedEntries !== null && { matched_entries: matchedEntries.map(serializeEntry) }),
    auto_create:
      autoCreate == null
        ? null
        : {
            reserved_ns_nn: autoCreate.reservedNsNn,
            derived_title_seed: autoCreate.derivedTitleSeed,
          },
    mechanical_edits: mechanicalEdits,
    schema_violations: schemaViolations,
    verification_failures: verificationFailures,
    affected_files: affectedFiles,
    semantic_work_pending: semanticWorkPending,
    warnings,
    // Immutable script-stage snapshot embedded in the manifest itself. The
    // validator reads this at subagent-stage to detect bypass attempts
    // (subagent clearing schema_violations / verification_failures /
    // semantic_work_pending / affected_files). Mirrors the four script-output
    // arrays above; deep-cloned so a post-write mutation of the live arrays
    // (defensive — the script doesn't currently mutate, but a future caller
    // might) cannot retroactively poison the snapshot. Subagent contract:
    // _script_stage is READ-ONLY — touching it is itself a bypass attempt and
    // surfaces as a structural-tampering gap in the validator.
    _script_stage: {
      affected_files: [...affectedFiles],
      schema_violations: schemaViolations.map((v) => ({ ...v })),
      verification_failures: verificationFailures.map((f) => ({ ...f })),
      semantic_work_pending: [...semanticWorkPending],
    },
    proposed_manifest_entry: proposedManifestEntry,
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
// Glue for §5.1's pipeline (locate → schema-validate → verify → mechanical
// edit → emit manifest). Returns { exitCode, manifestPath }; never
// throws on exit ≥ 1 (only on internal bugs). The verifier trio is silently
// SKIPPED when diffTouchedFiles is null — the CLI computes git-diff and passes
// the touched-file list; the fixture harness omits it (since fixture trees aren't
// real git diffs and would otherwise fail Type-signature for code-typed entries).

const NS_ID = (nsNum, suffix) => `NS-${String(nsNum).padStart(2, "0")}${suffix ?? ""}`;

// `plan_done_checklist_evaluation` replaced a mechanical tick this script used
// to attempt (2026-07-27). The tick looked for `#### Done Checklist` nested
// under `### Phase N`; no plan in `docs/plans/` has ever carried that shape —
// every plan file, template included, puts a single document-level
// `## Done Checklist` at the end instead (enforced at runtime by
// `__tests__/plan-done-checklist-corpus.test.mjs`, which pins no file count)
// — so the tick never fired once in production and every run
// carrying `--plan`/`--phase` returned a silent exit 3. Repointing it at the
// real heading would have been worse than leaving it dead: those rows are
// evidence-bearing prose naming PRs, SHAs and dates, and the checklist is
// PLAN-scoped, so a blind tick on a mid-plan phase ship both asserts done-ness
// with no trace and asserts it early. Deciding whether a tick is due needs the
// plan read, which is the subagent's job, not a regex's.
//
// Evaluation-shaped rather than action-shaped, mirroring
// `ns_auto_create_evaluation`. The subagent contract requires every
// `semantic_work_pending` item to produce a `semantic_edits` entry OR a
// `concerns` entry, and `RESULT: DONE` requires zero concerns — so an
// action-shaped item would file a concern on every mid-plan phase (the common
// case) and make DONE_WITH_CONCERNS the default verdict. Phrased as an
// evaluation, "not due — phase 2 of 5" is itself the completed work.
//
// Appended per-run rather than baked into the two base sets below: only a
// plan-bound run can answer it. See resolvePlanDeclaration.
const PLAN_DONE_CHECKLIST_EVALUATION = "plan_done_checklist_evaluation";

const SEMANTIC_WORK_PENDING_COMPLETION_BASE = [
  "compose_status_completion_prose",
  "ready_set_re_derivation",
  "line_cite_sweep",
  "set_quantifier_reverification",
  "ns_auto_create_evaluation",
  "unannotated_referenced_files_check",
];

// Spec §5.1 step 4' enumerates the three auto_create_* items verbatim. The
// candidate-ns symmetric items (ready_set_re_derivation, etc.) are NOT
// included here — defer to a follow-on spec amendment if subagent practice
// shows they're load-bearing for the auto-create branch too.
const SEMANTIC_WORK_PENDING_AUTO_CREATE_BASE = [
  "auto_create_compose_entry",
  "auto_create_compose_mermaid_node",
  "auto_create_derive_upstream",
];

const PLANS_DIR_REL = "docs/plans";

// Resolves the plan file whose phase this run shipped. Feeds two coupled
// manifest fields (see planScopedManifestFields), never a write: the script's
// writable surface is the §6 corpus plus its own manifest, and declaring a
// file in `affected_files` authorizes the SUBAGENT to edit it, not this script.
//
// `planFileRel` is null in two situations, only one of which is anomalous:
//
//   - Not plan-bound. Cleanup, governance and tier-audit invocations legally
//     omit --plan and --phase (deriveTitleSeed already forks on the same
//     pair, and the manifest records plan: null, phase: null). There is no
//     plan whose checklist could be due, so the item is dropped and nothing
//     is warned about. Emitting it anyway would hand the subagent an
//     unanswerable question — and since the contract pairs every pending item
//     to a `semantic_edits` entry or a `concerns` entry, and `RESULT: DONE`
//     requires zero concerns, that alone would downgrade every otherwise
//     clean non-plan run to DONE_WITH_CONCERNS.
//
//   - Plan-bound but unresolvable: `docs/plans/` is missing, nothing matches
//     `<plan>-*.md`, or several files do. That IS anomalous, so it surfaces as
//     a warning rather than passing silently. It does not halt the run — the
//     §6 mechanical work is independent of the plan file and still valid — and
//     it still drops the item and the declaration, because the orchestrator's
//     validator rejects any `affected_files` entry that does not exist on disk
//     (declaring an unresolved path would trade a warning for a hard gap), and
//     an unanswerable item costs a concern exactly as above.
function resolvePlanDeclaration({ args, repoRoot }) {
  // Checked before resolution rather than folded into it: the two null causes
  // are not independent. With `plan` null the resolver would search for
  // `null-*.md`, miss, and take the branch below — mislabelling every legal
  // cleanup / governance / tier-audit run as an unresolved-plan anomaly.
  if (!args.plan || !args.phase) {
    return { planFileRel: null, warnings: [] };
  }
  const resolved = resolvePlanFile({
    plan: args.plan,
    plansDir: join(repoRoot, PLANS_DIR_REL),
  });
  if (resolved === null) {
    // One warning kind covers the absent / no-match / multi-match cases
    // together: the resolver cannot distinguish them, and the operator remedy
    // is the same — look at what `glob` does and does not match.
    //
    // The two fields carry the two halves of the identity/filesystem split:
    // `plan` is the dispatch token as given (`023-partial`), `glob` is the
    // pattern actually searched (`docs/plans/023-*.md`). Interpolating the raw
    // token into `glob` would print a pattern this run never executed and that
    // no repo state can satisfy — worthless against the remedy above.
    return {
      planFileRel: null,
      warnings: [
        {
          kind: "plan_file_unresolved",
          plan: args.plan,
          glob: `${PLANS_DIR_REL}/${planFilesystemKey(args.plan)}-*.md`,
        },
      ],
    };
  }
  // Rebuilt from the basename rather than passed through from `resolved` so
  // the manifest records a posix repo-relative path on every platform; the
  // absolute `resolved` carries backslashes on Windows.
  return { planFileRel: `${PLANS_DIR_REL}/${basename(resolved)}`, warnings: [] };
}

// The three manifest fields that vary with plan-boundness, derived from one
// input so they cannot disagree. Declaring the plan file without emitting the
// item widens the subagent's authorized edit scope for nothing; emitting the
// item without declaring the file asks the subagent to tick a checklist in a
// file it is not authorized to touch, costing a sprawl round-trip and an
// `affected_files_extension` concern. Both shipped as live defects and were
// fixed 2026-07-27 by making them unrepresentable rather than by patching the
// call sites independently.
//
// `affected_files` is an AUTHORIZATION scope, never a work list, and the plan
// file is the clearest case of the difference: it is declared so the subagent
// MAY tick the checklist, not so it must. The item is evaluation-shaped, and
// its ordinary mid-phase answer ("not due — phase N of M") resolves to a
// `semantic_edits` payload and no file edit at all. The pipeline's only
// per-file edit obligation is the `<TODO subagent prose>` placeholder scan, and
// this script writes no placeholder — indeed nothing at all — under
// `docs/plans/`, so a declared-but-unedited plan file is the conformant shape
// rather than a skipped duty. A consumer contract that reads membership here as
// "Edit this file" forces the subagent to invent a plan change or breach its own
// action contract; that defect was Codex PR #259 R4, fixed in
// `.claude/agents/plan-execution-housekeeper.md` § Required tool sequence (in
// order) and the contract's § Canonical Subagent Prompt Template responsibility
// #6, not by narrowing this declaration.
function planScopedManifestFields({ corpusRel, planDeclaration, basePendingItems }) {
  if (planDeclaration.planFileRel === null) {
    return {
      affectedFiles: [corpusRel],
      semanticWorkPending: basePendingItems,
      warnings: planDeclaration.warnings,
    };
  }
  return {
    affectedFiles: [corpusRel, planDeclaration.planFileRel],
    semanticWorkPending: [...basePendingItems, PLAN_DONE_CHECKLIST_EVALUATION],
    warnings: planDeclaration.warnings,
  };
}

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

function findMermaidNode({ lines, nsNum, suffix = null }) {
  const targetId = `NS${String(nsNum).padStart(2, "0")}${suffix ?? ""}`;
  const NODE_RE = new RegExp(`\\b${targetId}\\[[^\\]]+\\]:::(\\w+)`);
  for (let i = 0; i < lines.length; i += 1) {
    if (CLASSDEF_RE.test(lines[i])) continue;
    const m = NODE_RE.exec(lines[i]);
    if (m) return { lineIndex: i, currentClass: m[1] };
  }
  return null;
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

function deriveTitleSeed(args) {
  if (args.prTag) {
    return args.prTag.replace(/^[a-z]+(\([^)]+\))?:\s*/, "");
  }
  if (args.plan && args.phase) {
    return `Plan-${args.plan} Phase ${args.phase}`;
  }
  return null;
}

// `repoRoot` is deliberately absent: this branch reads and writes the corpus
// only, and `baseManifest` already carries the root that `emitManifest` needs.
// It was a parameter until 2026-07-27, when the plan-file tick that used it was
// retired — keeping it would re-grant the plan tree to a function that no
// longer touches it. `planDeclaration` arrives already resolved by the caller
// for the same reason: this branch needs the plan's repo-relative path for the
// manifest, not the ability to go looking for it.
function runAutoCreate({
  args,
  corpusText,
  corpusLines,
  baseManifest,
  corpusRel,
  planDeclaration,
  diffTouchedFiles = null,
}) {
  // A guard here used to bump past 23, because §3a.3 reserved NS-23 for the
  // schema-amendment PR while the corpus still topped out at 22 — so max+1
  // would have collided with the reservation. NS-23 has since landed, and its
  // own comment said the guard becomes a no-op at that point; removed
  // 2026-07-27. reserveNextFreeNs now skips it naturally, from the corpus.
  const reservedNsNn = reserveNextFreeNs(corpusText);

  const derivedTitleSeed = deriveTitleSeed(args);
  if (derivedTitleSeed === null) {
    emitFailureManifest({
      ...baseManifest,
      scriptExitCode: 5,
      schemaViolations: [{ kind: "auto_create_title_seed_underivable" }],
    });
    return { exitCode: 5 };
  }

  const existingTitles = corpusLines
    .map((l) => parseNsHeading(l))
    .filter((h) => h !== null)
    .map((h) => h.title);
  const dupCheck = checkDuplicateTitle({ existingTitles, newTitle: derivedTitleSeed });
  if (!dupCheck.ok) {
    emitFailureManifest({
      ...baseManifest,
      scriptExitCode: 5,
      schemaViolations: [dupCheck.failure],
    });
    return { exitCode: 5 };
  }

  // No mechanical edits fire on this branch. The §6 entry and its mermaid node
  // are composed by the subagent from `auto_create`, and the plan's
  // `## Done Checklist` is semantic work now, not a regex tick — see
  // PLAN_DONE_CHECKLIST_EVALUATION. The checklist question is live on this
  // branch too: a phase shipped whether or not an NS entry existed pre-merge.
  // Declaring the plan file authorizes the SUBAGENT to edit it; this branch
  // still touches the corpus only, and the script writes nothing under
  // `docs/plans/`.
  const { manifestPath } = emitManifest({
    ...baseManifest,
    scriptExitCode: 0,
    matchedEntry: null,
    autoCreate: { reservedNsNn, derivedTitleSeed },
    mechanicalEdits: {},
    ...planScopedManifestFields({
      corpusRel,
      planDeclaration,
      basePendingItems: SEMANTIC_WORK_PENDING_AUTO_CREATE_BASE,
    }),
    // Codex P2 finding on PR #35 round 3: pass through the touched-files set
    // computed from `--touched-files-path` so auto-created shipment-manifest
    // entries record the authoritative file-change trace instead of `files: []`.
    proposedManifestEntry: buildProposedManifestEntry({ args, diffTouchedFiles }),
  });
  return { exitCode: 0, manifestPath };
}

// ---------- Multi-candidate dispatch (spec §5.1 step 1 comma-list) ----------
// Validates ALL tokens first (locate + schema + verify trio); applies edits
// only when every candidate validates clean. On first-failure, surfaces the
// failure for the failing candidate and tags untouched remaining tokens with
// `kind: not_evaluated` per spec line 551 ("remaining candidates' verification
// states enumerated"). The N=1 path is intentionally NOT routed through this
// function — preserves byte-for-byte fixture compatibility.
function validateCandidate({ token, corpusLines, corpusPath, repoRoot, args, diffTouchedFiles }) {
  const located = locateNsEntry({ lines: corpusLines, candidateNs: token });
  if (located === null) {
    return { ok: false, schemaViolation: { kind: "ns_entry_not_found", ns_id: token } };
  }
  const nsId = NS_ID(located.nsNum, located.suffix);
  const matchedEntryBase = {
    nsId,
    heading: located.heading,
    file: relative(repoRoot, corpusPath),
    headingLine: located.headingLine + 1,
  };
  const body = corpusLines.slice(located.headingLine + 1, located.bodyEnd).join("\n");
  const fields = parseSubFields(body);
  const requiredFields = ["status", "type", "references", "summary"];
  const violations = requiredFields
    .filter((f) => fields[f] === null)
    .map((f) => ({ kind: "schema_violation", field: f, ns_id: nsId }));
  if (violations.length > 0) {
    return { ok: false, matchedEntryBase, schemaViolations: violations, shape: "unknown" };
  }
  let prsBlock;
  try {
    prsBlock = parsePRsBlock(body);
  } catch (err) {
    return {
      ok: false,
      matchedEntryBase,
      shape: "unknown",
      schemaViolations: [{ kind: "prs_block_malformed", ns_id: nsId, message: err.message }],
    };
  }
  const shape = prsBlock === null ? "single-pr" : "multi-pr";
  if (diffTouchedFiles !== null) {
    const typeCheck = verifyTypeSignature({ type: fields.type, touchedFiles: diffTouchedFiles });
    if (!typeCheck.ok) {
      return {
        ok: false,
        matchedEntryBase,
        shape,
        verificationFailure: { ...typeCheck.failure, ns_id: nsId },
      };
    }
    const refs = extractFileReferences({
      references: fields.references,
      summary: fields.summary,
      repoRoot,
      entryFile: corpusPath,
    });
    const overlapCheck = verifyFileOverlap({
      type: fields.type,
      refs,
      touched: diffTouchedFiles,
    });
    if (!overlapCheck.ok) {
      return {
        ok: false,
        matchedEntryBase,
        shape,
        verificationFailure: { ...overlapCheck.failure, ns_id: nsId },
      };
    }
    const tierRangeMatch =
      located.rangeUpperNum !== null ? /\bTier (\d+)-(\d+)\b/.exec(located.headingTitle) : null;
    const rangeBoundaries = tierRangeMatch
      ? { K1: Number(tierRangeMatch[1]), K2: Number(tierRangeMatch[2]) }
      : null;
    const identityCheck = verifyPlanIdentity({
      headingTitle: located.headingTitle,
      args,
      type: fields.type,
      rangeBoundaries,
    });
    if (!identityCheck.ok) {
      return {
        ok: false,
        matchedEntryBase,
        shape,
        verificationFailure: { ...identityCheck.failure, ns_id: nsId },
      };
    }
  }
  if (shape === "multi-pr" && !args.task) {
    return {
      ok: false,
      matchedEntryBase,
      shape,
      schemaViolations: [{ kind: "multi_pr_requires_task_arg", ns_id: nsId }],
      multiPrTaskMissing: true,
    };
  }
  if (shape === "multi-pr") {
    // pre-validate task-in-block: applyMultiPrTickAndRecompute used to
    // silently exit its tick-loop when --task didn't match an unchecked row,
    // leaving the Status line untouched and the PRs block unmodified — an
    // invisible no-op that masked orchestrator-misdispatch (wrong --task)
    // as success. Catch it as a verification failure (not schema; the entry
    // itself is well-formed — the dispatch is wrong) so the subagent can
    // re-derive.
    const taskRow = prsBlock.find((r) => r.taskId === args.task);
    if (!taskRow || taskRow.checked) {
      return {
        ok: false,
        matchedEntryBase,
        shape,
        verificationFailure: {
          kind: "multi_pr_task_not_in_block",
          ns_id: nsId,
          task_id: args.task,
        },
      };
    }
  }
  return { ok: true, matchedEntryBase, located, fields, shape, nsId, prsBlock };
}

function applyEditsForCandidate({ candidate, corpusLines, args, today }) {
  const { located, shape, nsId } = candidate;
  let lines = corpusLines;
  let statusFlip;
  let prsTickEntry = null;
  if (shape === "single-pr") {
    const statusLineIndex = findStatusLineIndex({
      lines,
      headingLine: located.headingLine,
      bodyEnd: located.bodyEnd,
    });
    const fromLine = lines[statusLineIndex];
    lines = applyStatusFlipSinglePr({ lines, statusLineIndex, prNumber: args.prNumber, today });
    statusFlip = {
      ns_id: nsId,
      from_line: fromLine,
      to_line: lines[statusLineIndex],
      computed_via: "single-pr direct flip",
    };
  } else {
    const statusLineIndex = findStatusLineIndex({
      lines,
      headingLine: located.headingLine,
      bodyEnd: located.bodyEnd,
    });
    const prsBlockStartIndex = findPrsBlockStartIndex({
      lines,
      headingLine: located.headingLine,
      bodyEnd: located.bodyEnd,
    });
    const fromLine = lines[statusLineIndex];
    const blockedOnMatch = /^- Status:\s*`blocked`\s*\(blocked-on\s+(NS-\d+[a-z]?)/.exec(fromLine);
    const upstreamBlocked = blockedOnMatch !== null;
    const upstreamNsRef = upstreamBlocked ? blockedOnMatch[1] : null;
    lines = applyMultiPrTickAndRecompute({
      lines,
      statusLineIndex,
      prsBlockStartIndex,
      prsBlockBeforeTick: candidate.prsBlock,
      taskId: args.task,
      prNumber: args.prNumber,
      today,
      upstreamBlocked,
      upstreamNsRef,
    });
    prsTickEntry = { ns_id: nsId, task_id: args.task };
    statusFlip = {
      ns_id: nsId,
      from_line: fromLine,
      to_line: lines[statusLineIndex],
      computed_via: "prs-matrix recompute",
    };
  }
  let mermaidClassSwap = null;
  const newClassFlipped =
    lines[
      findStatusLineIndex({ lines, headingLine: located.headingLine, bodyEnd: located.bodyEnd })
    ].includes("`completed`");
  if (newClassFlipped) {
    const node = findMermaidNode({ lines, nsNum: located.nsNum, suffix: located.suffix });
    if (node !== null) {
      const fromClass = `:::${node.currentClass}`;
      lines = applyMermaidClassSwap({
        lines,
        nsNum: located.nsNum,
        suffix: located.suffix,
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
  return { lines, statusFlip, prsTickEntry, mermaidClassSwap };
}

function runMultiCandidate({
  args,
  tokens,
  repoRoot,
  corpusLines,
  corpusPath,
  corpusRel,
  baseManifest,
  planDeclaration,
  diffTouchedFiles,
  today,
}) {
  const validated = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const result = validateCandidate({
      token: tokens[i],
      corpusLines,
      corpusPath,
      repoRoot,
      args,
      diffTouchedFiles,
    });
    if (!result.ok) {
      // Spec §5.1 line 521: abort on first failure with `not_evaluated` for
      // remaining tokens (line 551 "remaining candidates' verification states
      // enumerated"). Determine exit code from the failure type.
      const remainingNotEvaluated = tokens
        .slice(i + 1)
        .map((t) => ({ kind: "not_evaluated", ns_id: t }));
      let exitCode;
      const failureManifest = {
        ...baseManifest,
        matchedEntries: validated.map((c) => ({ ...c.matchedEntryBase, shape: c.shape })),
      };
      if (result.schemaViolation) {
        exitCode = 1;
        failureManifest.scriptExitCode = 1;
        failureManifest.schemaViolations = [result.schemaViolation, ...remainingNotEvaluated];
      } else if (result.verificationFailure) {
        exitCode = 2;
        failureManifest.scriptExitCode = 2;
        failureManifest.verificationFailures = [
          result.verificationFailure,
          ...remainingNotEvaluated,
        ];
        failureManifest.matchedEntries.push({ ...result.matchedEntryBase, shape: result.shape });
      } else if (result.multiPrTaskMissing) {
        exitCode = 4;
        failureManifest.scriptExitCode = 4;
        failureManifest.schemaViolations = [...result.schemaViolations, ...remainingNotEvaluated];
        failureManifest.matchedEntries.push({ ...result.matchedEntryBase, shape: result.shape });
      } else {
        exitCode = 5;
        failureManifest.scriptExitCode = 5;
        failureManifest.schemaViolations = [...result.schemaViolations, ...remainingNotEvaluated];
        failureManifest.matchedEntries.push({ ...result.matchedEntryBase, shape: result.shape });
      }
      emitFailureManifest(failureManifest);
      return { exitCode };
    }
    validated.push(result);
  }

  // All candidates validated — apply edits sequentially. Each apply mutates
  // corpusLines for the next candidate's locate() to pick up updated headings
  // (locate is line-index-based, additions/removals would shift; status-line
  // edits don't change line counts so this is safe).
  let lines = corpusLines;
  const statusFlips = [];
  const prsBlockTicks = [];
  const mermaidClassSwaps = [];
  for (const candidate of validated) {
    const {
      lines: newLines,
      statusFlip,
      prsTickEntry,
      mermaidClassSwap,
    } = applyEditsForCandidate({
      candidate,
      corpusLines: lines,
      args,
      today,
    });
    lines = newLines;
    statusFlips.push(statusFlip);
    if (prsTickEntry) prsBlockTicks.push(prsTickEntry);
    if (mermaidClassSwap) mermaidClassSwaps.push(mermaidClassSwap);
  }

  writeFileSync(corpusPath, lines.join("\n"));

  const { manifestPath } = emitManifest({
    ...baseManifest,
    scriptExitCode: 0,
    matchedEntries: validated.map((c) => ({ ...c.matchedEntryBase, shape: c.shape })),
    autoCreate: null,
    mechanicalEdits: {
      status_flips: statusFlips,
      prs_block_ticks: prsBlockTicks,
      mermaid_class_swaps: mermaidClassSwaps,
    },
    ...planScopedManifestFields({
      corpusRel,
      planDeclaration,
      basePendingItems: SEMANTIC_WORK_PENDING_COMPLETION_BASE,
    }),
    proposedManifestEntry: buildProposedManifestEntry({ args, diffTouchedFiles }),
  });
  return { exitCode: 0, manifestPath };
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

  // Resolved once here and threaded down, so all three success paths declare
  // and emit identically and no branch has to re-derive it. Failure paths
  // (exit 1/2/5) never consume it: emitFailureManifest hardcodes empty
  // affected_files / semantic_work_pending / warnings, which is honest — a run
  // that halted before the semantic-work stage never reached the checklist
  // question, and its schema_violations are already the louder signal.
  const planDeclaration = resolvePlanDeclaration({ args, repoRoot });

  if (!args.candidateNs) {
    return runAutoCreate({
      args,
      corpusText,
      corpusLines,
      baseManifest,
      corpusRel,
      planDeclaration,
      diffTouchedFiles,
    });
  }

  // Spec §5.1 step 1 + line 454: `--candidate-ns NS-XX,NS-YY` is a comma-list.
  // For N≥2, dispatch to the multi-candidate path which validates ALL tokens
  // before any mechanical edit (per line 521: "aborts on first failure rather
  // than partial-applying"), then emits a multi-entry manifest. For N=1 the
  // existing single-candidate path runs unchanged so all prior fixtures stay
  // byte-for-byte stable.
  const tokens = args.candidateNs.split(",");
  if (tokens.length >= 2) {
    return runMultiCandidate({
      args,
      tokens,
      repoRoot,
      corpusLines,
      corpusPath,
      corpusRel,
      baseManifest,
      planDeclaration,
      diffTouchedFiles,
      today,
    });
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

  let prsBlock;
  try {
    prsBlock = parsePRsBlock(body);
  } catch (err) {
    emitFailureManifest({
      ...baseManifest,
      scriptExitCode: 5,
      matchedEntry: { ...matchedEntryBase, shape: "unknown" },
      schemaViolations: [{ kind: "prs_block_malformed", ns_id: nsId, message: err.message }],
    });
    return { exitCode: 5 };
  }
  const shape = prsBlock === null ? "single-pr" : "multi-pr";

  if (diffTouchedFiles !== null) {
    const typeCheck = verifyTypeSignature({ type: fields.type, touchedFiles: diffTouchedFiles });
    if (!typeCheck.ok) {
      emitFailureManifest({
        ...baseManifest,
        scriptExitCode: 2,
        matchedEntry: { ...matchedEntryBase, shape },
        verificationFailures: [typeCheck.failure],
      });
      return { exitCode: 2 };
    }
    const refs = extractFileReferences({
      references: fields.references,
      summary: fields.summary,
      repoRoot,
      entryFile: corpusPath,
    });
    const overlapCheck = verifyFileOverlap({
      type: fields.type,
      refs,
      touched: diffTouchedFiles,
    });
    if (!overlapCheck.ok) {
      emitFailureManifest({
        ...baseManifest,
        scriptExitCode: 2,
        matchedEntry: { ...matchedEntryBase, shape },
        verificationFailures: [overlapCheck.failure],
      });
      return { exitCode: 2 };
    }
    const tierRangeMatch =
      located.rangeUpperNum !== null ? /\bTier (\d+)-(\d+)\b/.exec(located.headingTitle) : null;
    const rangeBoundaries = tierRangeMatch
      ? { K1: Number(tierRangeMatch[1]), K2: Number(tierRangeMatch[2]) }
      : null;
    const identityCheck = verifyPlanIdentity({
      headingTitle: located.headingTitle,
      args,
      type: fields.type,
      rangeBoundaries,
    });
    if (!identityCheck.ok) {
      emitFailureManifest({
        ...baseManifest,
        scriptExitCode: 2,
        matchedEntry: { ...matchedEntryBase, shape },
        verificationFailures: [identityCheck.failure],
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

  if (shape === "multi-pr") {
    // pre-validate task-in-block: applyMultiPrTickAndRecompute used to
    // silently exit its tick-loop when --task didn't match an unchecked row,
    // leaving the Status line untouched and the PRs block unmodified — an
    // invisible no-op that masked orchestrator-misdispatch (wrong --task)
    // as success. Catch it as a verification failure (not schema; the entry
    // itself is well-formed — the dispatch is wrong) so the subagent can
    // re-derive.
    const taskRow = prsBlock.find((r) => r.taskId === args.task);
    if (!taskRow || taskRow.checked) {
      emitFailureManifest({
        ...baseManifest,
        scriptExitCode: 2,
        matchedEntry: { ...matchedEntryBase, shape },
        verificationFailures: [
          { kind: "multi_pr_task_not_in_block", ns_id: nsId, task_id: args.task },
        ],
      });
      return { exitCode: 2 };
    }
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
    // Derive upstream-blocked signal from the current Status line's textual
    // form per spec §3a.2 row 5 ("Upstream blocked-on cite present?"). The
    // cite shape mirrors what applyMultiPrTickAndRecompute writes back when
    // it preserves the override (line ~550): `blocked` (blocked-on NS-XX; ...).
    // Read-then-pass-through: the orchestrator does NOT recurse into the
    // upstream entry; it trusts the entry's own current Status line as the
    // authoritative blocked-on cite. If the upstream NS becomes unblocked, a
    // separate housekeeping cycle on THAT entry refreshes both.
    const blockedOnMatch = /^- Status:\s*`blocked`\s*\(blocked-on\s+(NS-\d+[a-z]?)/.exec(fromLine);
    const upstreamBlocked = blockedOnMatch !== null;
    const upstreamNsRef = upstreamBlocked ? blockedOnMatch[1] : null;
    corpusLines = applyMultiPrTickAndRecompute({
      lines: corpusLines,
      statusLineIndex,
      prsBlockStartIndex,
      prsBlockBeforeTick: prsBlock,
      taskId: args.task,
      prNumber: args.prNumber,
      today,
      upstreamBlocked,
      upstreamNsRef,
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
    const node = findMermaidNode({
      lines: corpusLines,
      nsNum: located.nsNum,
      suffix: located.suffix,
    });
    if (node !== null) {
      const fromClass = `:::${node.currentClass}`;
      corpusLines = applyMermaidClassSwap({
        lines: corpusLines,
        nsNum: located.nsNum,
        suffix: located.suffix,
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

  writeFileSync(corpusPath, corpusLines.join("\n"));

  const { manifestPath } = emitManifest({
    ...baseManifest,
    scriptExitCode: 0,
    matchedEntry: { ...matchedEntryBase, shape },
    autoCreate: null,
    mechanicalEdits: {
      status_flip: statusFlip,
      prs_block_ticks: prsBlockTicks,
      mermaid_class_swap: mermaidClassSwap,
    },
    ...planScopedManifestFields({
      corpusRel,
      planDeclaration,
      basePendingItems: SEMANTIC_WORK_PENDING_COMPLETION_BASE,
    }),
    proposedManifestEntry: buildProposedManifestEntry({ args, diffTouchedFiles }),
  });

  return { exitCode: 0, manifestPath };
}

// Diff source: orchestrator owns git knowledge per Plan Invariant I-3 (script
// never shells out to git). The orchestrator computes the PR-wide diff (e.g.
// `git diff origin/develop...HEAD --name-only` on the feature branch BEFORE
// squash-merge per Phase E ordering — see SKILL.md L100,L421) and writes the
// resulting one-path-per-line file, then passes its absolute path via
// `--touched-files-path`. The verifier trio (§5.1 step 3) reads this set to
// check Type-signature + file-overlap. Tests inject `diffTouchedFiles` directly
// (bypassing the CLI file read) for hermeticity.
export function readTouchedFilesFromPath(touchedFilesPath) {
  const out = readFileSync(touchedFilesPath, "utf8");
  return out.split("\n").filter(Boolean);
}

/**
 * Direct-invocation guard — same form as
 * `tools/docs-corpus/bin/pre-commit-runner.ts` § isDirectlyInvoked.
 *
 * NOT `import.meta.url === \`file://${process.argv[1]}\``: that compares a
 * percent-ENCODED URL against a raw path, so a checkout under a directory
 * containing a space (or `#`, `?`, non-ASCII) makes them unequal and this script
 * silently does nothing while exiting 0. `realpathSync` on both sides also
 * survives a symlinked invocation (macOS `/tmp` → `/private/tmp`).
 *
 * A miss here is worse than a plain no-op: Phase E would go on to read
 * `.agents/tmp/housekeeper-manifest-PR<N>.json`, and because that path is keyed
 * only on the PR number, a STALE manifest from an earlier run of the same PR
 * would validate and be acted upon as if this run had produced it.
 */
function isDirectlyInvoked() {
  const invokedPath = process.argv[1];
  if (typeof invokedPath !== "string") return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that will not resolve to a real file was not this module's entry
    // point, so `false` is the correct answer rather than a swallowed failure.
    return false;
  }
}

if (isDirectlyInvoked()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.touchedFilesPath === null) {
      throw new ParseArgsError("--touched-files-path is required when invoked as CLI", 6);
    }
    const repoRoot = process.cwd();
    const diffTouchedFiles = readTouchedFilesFromPath(args.touchedFilesPath);
    const result = await runHousekeeper({ args, repoRoot, diffTouchedFiles });
    process.exit(result.exitCode);
  } catch (err) {
    if (err instanceof ParseArgsError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    throw err;
  }
}
