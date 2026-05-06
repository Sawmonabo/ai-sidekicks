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

import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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
