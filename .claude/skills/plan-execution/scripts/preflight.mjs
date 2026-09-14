#!/usr/bin/env node
// Four checks before a plan phase is dispatched. Each is one question the
// model cannot answer from the plan file alone. Exit 0 when all pass, 1 on the
// first failure, 2 on usage error.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const [planArg, phaseArg] = process.argv.slice(2);
if (!planArg || !/^\d+$/.test(phaseArg ?? "")) {
  process.stderr.write("usage: preflight.mjs <docs/plans/NNN-*.md> <phase-number>\n");
  process.exit(2);
}

const planFile = path.resolve(planArg);
const phase = Number(phaseArg);
const fail = (message) => {
  process.stderr.write(`preflight: ${message}\n`);
  process.exit(1);
};
const ok = (message) => process.stdout.write(`ok: ${message}\n`);

if (!existsSync(planFile)) fail(`plan file not found: ${planArg}`);
const source = readFileSync(planFile, "utf8");
const planMatch = path.basename(planFile).match(/^(\d{3})-/);
if (!planMatch) fail("plan file name must start with NNN-");
const planToken = `Plan-${planMatch[1]}`;

// 1. The plan is marked ready (draft plans are not dispatched).
const statusMatch = source.match(/\*\*Status\*\*\s*\|\s*`([a-z-]+)`/);
const status = statusMatch ? statusMatch[1] : "unknown";
if (!["ready", "approved", "completed"].includes(status))
  fail(`plan status is ${status}; mark it ready first`);
ok("plan is ready");

// 2. The phase section exists.
const phaseHeading = new RegExp(`^###\\s+Phase\\s+${phase}\\b.*$`, "m");
const headingMatch = source.match(phaseHeading);
if (!headingMatch) fail(`no "### Phase ${phase}" section in ${planArg}`);
const sectionStart = headingMatch.index + headingMatch[0].length;
const nextHeading = source.slice(sectionStart).search(/^##+\s/m);
const section =
  nextHeading === -1
    ? source.slice(sectionStart)
    : source.slice(sectionStart, sectionStart + nextHeading);
ok(`phase ${phase} section found`);

// 3. The phase is not already in git history. Commit SUBJECTS carry the
//    `Plan-NNN Phase N` token (the squash subject inherits the PR title); the
//    message body is deliberately not searched, because a body routinely names
//    a plan it does not ship. `git log --grep` cannot be limited to the
//    subject and its `-E` engine has no `\b`, so the subjects are read once
//    and matched here.
let subjectCache = null;
function commitSubjects() {
  if (subjectCache === null) {
    subjectCache = execFileSync("git", ["log", "--format=%s"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).split("\n");
  }
  return subjectCache;
}
function shipped(plan, phaseNumber) {
  // The trailing guard keeps `Phase 3` from matching `Phase 3B`.
  const token = new RegExp(`${plan}\\s+Phase\\s+${phaseNumber}(?![0-9A-Za-z])`, "i");
  return commitSubjects().find((subject) => token.test(subject)) ?? null;
}
const already = shipped(planToken, phase);
if (already) fail(`phase ${phase} already in git log: ${already}`);
ok(`phase ${phase} not in git log`);

// 4. Every "Plan-MMM Phase K" named in the phase's precondition sentence is
//    in git history. "Precondition: none." passes.
const preconditionLine = section.match(/^Precondition[s]?:\s*(.*)$/m);
const preconditionText = preconditionLine ? preconditionLine[1] : "none";
for (const m of preconditionText.matchAll(/(Plan-\d{3})\s+Phase\s+(\d+)/g)) {
  if (!shipped(m[1], Number(m[2])))
    fail(`precondition not met: ${m[1]} Phase ${m[2]} is not in git log`);
}
ok(`preconditions satisfied (${preconditionText.trim()})`);
