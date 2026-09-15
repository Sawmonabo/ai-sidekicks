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
    try {
      subjectCache = execFileSync("git", ["log", "--format=%s"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }).split("\n");
    } catch (error) {
      fail(`cannot read git history: ${error.message}`);
    }
  }
  return subjectCache;
}
// A `docs` or `chore` subject names a plan task it did not ship — a cite
// repair, a manifest row — for the same reason the message body is not
// searched, so only the types that carry code can answer "shipped".
const NON_SHIPPING_TYPE = /^(?:docs|chore)(?:\([^)]*\))?!?:/i;

function shipped(plan, phaseLabel) {
  // History names a plan's phase three ways — `Phase N`, `PN`, and a task
  // number `TN.k` — and each guards its tail, so `Phase 3` does not match
  // `Phase 3B`, `P1` does not match `P12`, and `T3.` does not match `T31.5`.
  // A lettered phase (`3B`) is a split of its parent that only the long form
  // spells, so it matches `Phase 3B` alone — never `P3`/`T3.`, which would
  // read the parent's shipment as the split's.
  const label = String(phaseLabel);
  const alternatives = [`Phase\\s+${label}(?![0-9A-Za-z])`];
  if (!/[A-Za-z]$/.test(label)) alternatives.push(`P${label}(?![0-9A-Za-z])`, `T${label}\\.[0-9]`);
  const token = new RegExp(`${plan}\\s+(?:${alternatives.join("|")})`, "i");
  return (
    commitSubjects().find((subject) => !NON_SHIPPING_TYPE.test(subject) && token.test(subject)) ??
    null
  );
}
const already = shipped(planToken, phase);
if (already) fail(`phase ${phase} already in git log: ${already}`);
ok(`phase ${phase} not in git log`);

// 4. Every "Plan-MMM Phase K" named in the phase's precondition block is in
//    git history. "Precondition: none." passes. The corpus writes the label
//    bold, either inline (`**Precondition:** Plan-005 Phase 1 merged.`) or as
//    a heading over a checklist (`**Preconditions.**`), and the template
//    writes it bare, so all three shapes are read and a label-only line takes
//    the block beneath it as its text.
const sectionLines = section.split("\n");
const labelIndex = sectionLines.findIndex((line) => /^\s*\*{0,2}Precondition[s]?\b/.test(line));
let preconditionText = "none";
if (labelIndex !== -1) {
  const inline = sectionLines[labelIndex].replace(
    /^\s*\*{0,2}Precondition[s]?\b[:.]?\*{0,2}[:.]?\s*/,
    "",
  );
  const block = [];
  if (inline.trim() === "") {
    for (let i = labelIndex + 1; i < sectionLines.length; i += 1) {
      const line = sectionLines[i];
      if (line.trim() === "") {
        if (block.length > 0) break;
        continue;
      }
      if (/^#+\s/.test(line)) break;
      block.push(line);
    }
  }
  const collected = [inline, ...block].join(" ").replace(/\s+/g, " ").trim();
  if (collected !== "") preconditionText = collected;
}
for (const m of preconditionText.matchAll(/(Plan-\d{3})\s+Phase\s+(\d+[A-Za-z]?)/g)) {
  if (!shipped(m[1], m[2])) fail(`precondition not met: ${m[1]} Phase ${m[2]} is not in git log`);
}
ok(`preconditions satisfied (${preconditionText.trim()})`);
