#!/usr/bin/env node
// post-merge-housekeeper.mjs — plan-execution skill housekeeper script.
//
// Stage 1 of a 2-stage post-merge automation. Authoritative contract:
// ../references/post-merge-housekeeper-contract.md (added in PR 4); design
// at docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md.
// This commit (C3 of PR #32) lands only the pure parsers — orchestrator,
// arg parsing, mechanical edits, and manifest emission ship in C4-C9.
//
// Pure parsers exported here:
//   - parseNsHeading      (Task 3.2 — §3a.1 grammar)
//   - parseSubFields      (Task 3.3 — Status/Type/Priority/Upstream/References/
//                          Summary/Exit Criteria)
//   - parsePRsBlock       (Task 3.4 — multi-PR block grammar)
//   - computeStatusFromPRs(Task 3.5 — §3a.2 6-row completion matrix)
//   - extractFileReferences(Task 3.6 — §3a.4 file/dir + brace expansion)

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
