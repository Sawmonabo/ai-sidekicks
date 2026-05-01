#!/usr/bin/env node
// validate-review-response.mjs — parse reviewer response markdown, validate
// Phase D `Round-trip target:` stamp, group findings by file:line for
// inter-reviewer conflict detection.
//
// Exit codes:
//   0 — parsed successfully; in --phase=D mode, every finding carries a
//       Round-trip target stamp; in --conflicts mode, no cross-reviewer
//       conflicts detected.
//   1 — validation failure (missing stamps, or conflicts present);
//       stdout = JSON describing the failure.
//   2 — internal error; stderr describes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

// ---------- pure parsers ----------

const SEVERITY_RE =
  /^\s*[-*]?\s*(?:\*\*)?Severity(?:\*\*)?\s*:\s*\*?\*?\s*(POLISH|ACTIONABLE|VERIFICATION)/im;
const FILE_LINE_RE = /([\w./@-]+\.[a-zA-Z][\w]*?):(\d+(?:-\d+)?)/;
const ROUND_TRIP_RE = /Round-trip target\s*:\s*([^\n`*]+)/i;
const RESULT_RE = /^\s*\*?\*?\s*RESULT\s*:\s*\*?\*?\s*(\w+)/m;

export function parseReviewerResponse(source) {
  const lines = source.split("\n");
  const findings = [];
  let current = null;
  let inFindings = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+Findings\b/i.test(line)) {
      inFindings = true;
      continue;
    }
    if (!inFindings) continue;
    // End of findings: any other top-level ## header
    if (/^##\s+/.test(line) && !/^##\s+Findings\b/i.test(line)) {
      if (current) {
        findings.push(current);
        current = null;
      }
      break;
    }

    const sevMatch = line.match(SEVERITY_RE);
    if (sevMatch) {
      if (current) findings.push(current);
      current = {
        severity: sevMatch[1].toUpperCase(),
        lines: [line],
        file_line: null,
        round_trip_target: null,
      };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) findings.push(current);

  for (const f of findings) {
    const body = f.lines.join("\n");
    const fl = body.match(FILE_LINE_RE);
    if (fl) f.file_line = `${fl[1]}:${fl[2]}`;
    const rt = body.match(ROUND_TRIP_RE);
    if (rt) f.round_trip_target = rt[1].trim();
    f.text = body;
    delete f.lines;
  }

  const resultMatch = source.match(RESULT_RE);
  return {
    findings,
    result: resultMatch ? resultMatch[1].toUpperCase() : null,
  };
}

export function validatePhaseD(parsed) {
  const errors = [];
  for (const f of parsed.findings) {
    // VERIFICATION is narrative, not a finding — but if it slipped into
    // the Findings section it still needs a stamp under Phase D.
    if (!f.round_trip_target) {
      errors.push({
        severity: f.severity,
        file_line: f.file_line,
        excerpt: f.text.split("\n").slice(0, 2).join(" / ").slice(0, 200),
        missing: "Round-trip target:",
      });
    }
  }
  return errors;
}

const SEVERITY_RANK = { ACTIONABLE: 3, POLISH: 2, VERIFICATION: 1 };

export function severityMax(severities) {
  let max = null;
  for (const s of severities) {
    if (max === null || (SEVERITY_RANK[s] || 0) > (SEVERITY_RANK[max] || 0)) max = s;
  }
  return max;
}

export function detectConflicts(responses) {
  // responses = [{ reviewer: 'spec', findings: [...] }, ...]
  const bySurface = new Map();
  for (const r of responses) {
    for (const f of r.findings) {
      if (!f.file_line) continue;
      if (!bySurface.has(f.file_line)) bySurface.set(f.file_line, []);
      bySurface.get(f.file_line).push({
        reviewer: r.reviewer,
        severity: f.severity,
        excerpt: f.text.split("\n").slice(0, 2).join(" / ").slice(0, 200),
      });
    }
  }
  const conflicts = [];
  for (const [surface, entries] of bySurface) {
    if (entries.length < 2) continue;
    const severities = Array.from(new Set(entries.map((e) => e.severity)));
    conflicts.push({
      surface,
      entries,
      severity_max: severityMax(severities),
      mixed_severity: severities.length > 1,
    });
  }
  return conflicts;
}

// ---------- IO helpers ----------

function readSource(file) {
  if (file === "-" || file === "/dev/stdin") return readFileSync(0, "utf8");
  return readFileSync(file, "utf8");
}

function reviewerNameFromPath(p) {
  const base = p.split("/").pop() || p;
  // Match conventions like "spec-reviewer.md", "code-quality.txt", or
  // fall back to filename stem.
  const m = base.match(/(spec|code-quality|code|quality)/i);
  return m ? m[1].toLowerCase() : base.replace(/\.[^.]+$/, "");
}

// ---------- CLI ----------

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stderr.write(
      [
        "Usage:",
        "  validate-review-response.mjs <file>             # parse, output JSON to stdout",
        "  validate-review-response.mjs --phase=D <file>   # require Round-trip target on each finding",
        "  validate-review-response.mjs --conflicts <f>... # detect inter-reviewer conflicts (≥2 files)",
        "",
        "Use `-` as <file> to read from stdin.",
      ].join("\n") + "\n",
    );
    process.exit(2);
  }

  const phaseD = args.includes("--phase=D");
  const conflictsMode = args.includes("--conflicts");
  const fileArgs = args.filter((a) => !a.startsWith("--"));

  if (conflictsMode) {
    if (fileArgs.length < 2) {
      process.stderr.write("--conflicts requires ≥ 2 response files\n");
      process.exit(2);
    }
    const responses = fileArgs.map((f) => ({
      reviewer: reviewerNameFromPath(f),
      ...parseReviewerResponse(readSource(f)),
    }));
    const conflicts = detectConflicts(responses);
    printJson({ conflicts });
    process.exit(conflicts.length === 0 ? 0 : 1);
  }

  if (fileArgs.length === 0) {
    process.stderr.write("no input file given\n");
    process.exit(2);
  }
  const source = readSource(fileArgs[0]);
  const parsed = parseReviewerResponse(source);

  if (phaseD) {
    const stamp_errors = validatePhaseD(parsed);
    printJson({ ...parsed, stamp_errors });
    process.exit(stamp_errors.length === 0 ? 0 : 1);
  }

  printJson(parsed);
  process.exit(0);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`internal error: ${e.message || String(e)}\n`);
    process.exit(2);
  });
}
