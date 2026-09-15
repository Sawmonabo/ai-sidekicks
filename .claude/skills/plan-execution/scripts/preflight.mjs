#!/usr/bin/env node
// Four checks before a plan phase is dispatched. Each is one question the
// model cannot answer from the plan file alone. Exit 0 when all pass, 1 on the
// first failure, 2 on usage error.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

// A phase label is a number, optionally with a letter, optionally `R`-prefixed:
// plans split a phase into `3A` / `3B` supplements and carry a Tier-3 remainder
// as `R1` / `R2` / `R3`, and both are dispatched under that label, so coercing
// the argument to a number would make those phases undispatchable.
const [planArg, phaseArg] = process.argv.slice(2);
if (!planArg || !/^R?\d+[A-Za-z]?$/.test(phaseArg ?? "")) {
  process.stderr.write("usage: preflight.mjs <docs/plans/NNN-*.md> <phase-label>\n");
  process.exit(2);
}

const planFile = path.resolve(planArg);
const phase = phaseArg;
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
// The tail guard keeps `Phase 3` off `### Phase 3B`: a split is its own phase.
const phaseHeading = new RegExp(`^###\\s+Phase\\s+${phase}(?![0-9A-Za-z]).*$`, "m");
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
//
//    Commit 426a4ce3a renumbered the plan corpus, so a subject written before
//    it names a different plan by the same number; subjects from that era are
//    translated through the table below before matching, and a number whose
//    plan was retired translates to a token no query can equal. The tests
//    point `PREFLIGHT_RENUMBER_COMMIT` at a fixture boundary to drive this.
const RENUMBER_COMMIT = process.env.PREFLIGHT_RENUMBER_COMMIT ?? "426a4ce3a";
const PLAN_RENUMBERED = {
  "001": "001",
  "003": "002",
  "004": "003",
  "005": "004",
  "006": "005",
  "007": "006",
  "009": "007",
  "010": "008",
  "011": "009",
  "012": "010",
  "013": "011",
  "014": "012",
  "015": "013",
  "016": "014",
  "017": "015",
  "018": "016",
  "019": "017",
  "020": "018",
  "021": "019",
  "022": "020",
  "023": "021",
  "024": "022",
  "026": "023",
  "027": "024",
  "028": "025",
  "029": "026",
  "030": "027",
  "031": "028",
};

// Each entry keeps the subject as it was written alongside the copy matching
// reads, so every message quotes what a person will find in `git log`.
function readSubjects(range) {
  try {
    return execFileSync("git", ["log", "--format=%s", range], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .map((original) => ({ subject: original, original }));
  } catch (error) {
    return fail(`cannot read git history: ${error.message}`);
  }
}

function renumber(entry) {
  return {
    subject: entry.original.replace(/Plan-(\d{3})/gi, (token, number) =>
      PLAN_RENUMBERED[number] ? `Plan-${PLAN_RENUMBERED[number]}` : "Plan-retired",
    ),
    original: entry.original,
  };
}

// A checkout whose history does not carry the renumber commit has not been
// renumbered either, so all of it is already in today's numbering.
function historyWasRenumbered() {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", RENUMBER_COMMIT, "HEAD"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

let subjectCache = null;
function commitEntries() {
  if (subjectCache === null) {
    subjectCache = historyWasRenumbered()
      ? [
          ...readSubjects(`${RENUMBER_COMMIT}^..HEAD`),
          ...readSubjects(`${RENUMBER_COMMIT}^`).map(renumber),
        ]
      : readSubjects("HEAD");
  }
  return subjectCache;
}
// A `docs` or `chore` subject names a plan task it did not ship — a cite
// repair, a manifest row — for the same reason the message body is not
// searched, so only the types that carry code can answer "shipped".
const NON_SHIPPING_TYPE = /^(?:docs|chore)(?:\([^)]*\))?!?:/i;

// History names a plan's phase two different things: `Phase N` and `PN` claim
// the whole phase shipped, while a task number `TN.k` claims only that one
// task inside it landed. `shipped()` reports which claim it found — `kind`
// `"phase"` or `"task"`, with every distinct task number it saw — so a caller
// can tell a finished phase from a partly-landed one. Each form guards its
// tail, so `Phase 3` does not match `Phase 3B`, `P1` does not match `P12`, and
// `T3.` does not match `T31.5`. Only a plain number has the `PN` and `TN.k`
// shorthands: a supplement (`3B`) and a remainder phase (`R2`) are spelled in
// full wherever history names them, and `PR2` would read as a pull request.
function shipped(plan, phaseLabel) {
  const label = String(phaseLabel);
  const plainNumber = /^\d+$/.test(label);
  const phaseForms = [`Phase\\s+${label}(?![0-9A-Za-z])`];
  if (plainNumber) phaseForms.push(`P${label}(?![0-9A-Za-z])`);
  const phaseToken = new RegExp(`${plan}\\s+(?:${phaseForms.join("|")})`, "i");
  const taskAnchor = plainNumber ? new RegExp(`${plan}\\s+T${label}\\.[0-9]`, "i") : null;
  const taskNumber = plainNumber ? new RegExp(`T${label}\\.([0-9]+)`, "gi") : null;

  const taskNumbers = new Set();
  let phaseEntry = null;
  let taskEntry = null;
  for (const entry of commitEntries()) {
    if (NON_SHIPPING_TYPE.test(entry.subject)) continue;
    if (phaseEntry === null && phaseToken.test(entry.subject)) phaseEntry = entry;
    if (taskAnchor?.test(entry.subject)) {
      if (taskEntry === null) taskEntry = entry;
      for (const [, number] of entry.subject.matchAll(taskNumber)) taskNumbers.add(number);
    }
  }
  const found = phaseEntry ?? taskEntry;
  if (!found) return null;
  return {
    kind: phaseEntry ? "phase" : "task",
    subject: found.subject,
    original: found.original,
    taskNumbers,
  };
}
const already = shipped(planToken, phase);
if (already)
  fail(
    already.kind === "phase"
      ? `phase ${phase} already in git log: ${already.original}`
      : // A phase with landed tasks is not dispatchable as a fresh phase.
        `phase ${phase} partly in git log: ${already.original}`,
  );
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
// A precondition names a phase in any of four shapes: qualified
// (`Plan-005 Phase 1 merged`), bare (`Phase 1 merged` — the commonest, since
// most preconditions point at this plan's own earlier phase), coordinated
// (`Phases 2 and 3 merged`), or a range (`Phases 2-4`). Reading only the
// qualified singular let every other shape pass unchecked, which is the one
// failure direction this check exists to prevent: a false red costs a re-read,
// a false green dispatches work whose prerequisite has not shipped.
const LABEL = "R?[0-9]+[A-Za-z]?";
const SEPARATOR = "\\s*(?:,|and|&|\\+|-|–|—|to)\\s*";
const PHASE_REFERENCE = new RegExp(
  `(?:(Plan-\\d{3})\\s+)?Phases?\\s+(${LABEL}(?:${SEPARATOR}${LABEL})*)`,
  "g",
);

// `2-4` means every phase in the span; `2 and 4` means those two alone. Only a
// dash between two plain numbers expands, so `3B` and `2 to 4` are left as
// written rather than guessed at.
function labelsIn(list) {
  const labels = [];
  const parts = list.split(new RegExp(`(${SEPARATOR})`));
  for (let i = 0; i < parts.length; i += 2) {
    const label = parts[i].trim();
    const separator = (parts[i - 1] ?? "").trim();
    const previous = labels[labels.length - 1];
    if (/^[-–—]$/.test(separator) && /^\d+$/.test(label) && /^\d+$/.test(previous ?? "")) {
      for (let n = Number(previous) + 1; n <= Number(label); n += 1) labels.push(String(n));
      continue;
    }
    labels.push(label);
  }
  return labels;
}

// A bare reference is only a requirement when the sentence says the phase has
// to have SHIPPED. Precondition blocks are prose, and they mention phases for
// other reasons — "Phase 1 has no unsatisfied upstream dependency" is a remark,
// not a gate. A qualified `Plan-NNN Phase K` needs no such evidence: naming
// another plan's phase inside a precondition block is already the gate.
const SHIPMENT_CLAIM =
  /^.{0,60}?\b(?:merged|landed|shipp(?:ed|ing)|complete[sd]?|green|satisfied|in git log)\b/is;

const required = [];
for (const m of preconditionText.matchAll(PHASE_REFERENCE)) {
  const qualified = m[1] !== undefined;
  if (!qualified && !SHIPMENT_CLAIM.test(preconditionText.slice(m.index + m[0].length))) continue;
  for (const label of labelsIn(m[2])) required.push([m[1] ?? planToken, label]);
}
for (const [referencedPlan, label] of required) {
  const evidence = shipped(referencedPlan, label);
  if (!evidence) fail(`precondition not met: ${referencedPlan} Phase ${label} is not in git log`);
  // One task token is one task, not the phase; two distinct ones are a phase
  // that shipped under task subjects.
  if (evidence.kind === "task" && evidence.taskNumbers.size < 2)
    fail(
      `precondition not met: ${referencedPlan} Phase ${label} has one task in git log, ` +
        `not the phase: ${evidence.original}`,
    );
}
ok(`preconditions satisfied (${preconditionText.trim()})`);
