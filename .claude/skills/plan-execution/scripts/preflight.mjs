#!/usr/bin/env node
// preflight.mjs — plan-execution skill mechanical gate runner.
// Authoritative contract: ./preflight-contract.md.
//
// Exit codes:
//   0 — all gates pass; stdout = selected phase number on a single line.
//   1 — gate failed; stdout = self-contained halt message (orchestrator
//       surfaces verbatim).
//   2 — internal error (malformed input); stderr describes; stdout empty.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// ---------- paths ----------

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const REPO_ROOT = resolve(SKILL_ROOT, '..', '..', '..');

// ---------- pure helpers (exported for tests) ----------

export function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const lines = match[1].split('\n');
  const result = {};
  let inList = null;
  for (const line of lines) {
    const listKeyMatch = line.match(/^([a-zA-Z_][\w]*)\s*:\s*$/);
    if (listKeyMatch) { inList = listKeyMatch[1]; result[inList] = []; continue; }
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
  const startRe = new RegExp(`^### Phase ${phaseNumber}\\s*[—-]\\s*.+$`, 'm');
  const startMatch = startRe.exec(planSource);
  if (!startMatch) return null;
  const startIdx = startMatch.index;
  const after = planSource.slice(startIdx + startMatch[0].length);
  const nextRe = /^### Phase \d+/m;
  const nextMatch = nextRe.exec(after);
  const endIdx = nextMatch
    ? startIdx + startMatch[0].length + nextMatch.index
    : planSource.length;
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
  for (const pair of inner.split(',')) {
    const colonIdx = pair.indexOf(':');
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
  const blockMatch = phaseSection.match(/```yaml\s*\n([\s\S]*?)\n```/);
  if (!blockMatch) return null;
  const lines = blockMatch[1].split('\n');
  let inPre = false;
  const entries = [];
  for (const line of lines) {
    if (/^preconditions\s*:/.test(line)) { inPre = true; continue; }
    if (inPre) {
      if (/^\s*-\s+/.test(line)) {
        const entry = parseFlowMapping(line);
        if (entry) entries.push(entry);
      } else if (/^\S/.test(line)) {
        inPre = false;
      }
    }
  }
  return entries;
}

export function regexParsePreconditionsLine(line) {
  const entries = [];
  for (const m of line.matchAll(/PR\s*#(\d+)\s+merged/gi)) {
    entries.push({ type: 'pr_merged', ref: Number(m[1]) });
  }
  for (const m of line.matchAll(/ADR-(\d{3})\s+accepted/gi)) {
    entries.push({ type: 'adr_accepted', ref: Number(m[1]) });
  }
  for (const m of line.matchAll(/Plan-(\d{3})\s+Phase\s*(\d+)\s+(?:approved|merged)/gi)) {
    entries.push({ type: 'plan_phase', plan: Number(m[1]), phase: Number(m[2]), status: 'merged' });
  }
  return entries;
}

export function extractPlanNumber(planFile) {
  const base = basename(planFile);
  const match = base.match(/^(\d{1,4})-/);
  return match ? Number(match[1]) : null;
}

export function findPaddedFile(dir, ref) {
  const padded = String(ref).padStart(3, '0');
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (f.startsWith(`${padded}-`) && f.endsWith('.md')) return resolve(dir, f);
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

export function findProgressLogPhaseEntry(source, phaseNumber) {
  const plMatch = source.match(/##\s*Progress Log\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!plMatch) return false;
  const content = plMatch[1];
  return new RegExp(`(Phase\\s*${phaseNumber}\\b|PR\\s*#${phaseNumber}\\b)`, 'i').test(content);
}

// ---------- IO layer (stubbable) ----------

let _ghImpl = (cmd) => execSync(cmd, { encoding: 'utf8', cwd: REPO_ROOT });

export function setGhImpl(impl) { _ghImpl = impl; }
export function resetGhImpl() {
  _ghImpl = (cmd) => execSync(cmd, { encoding: 'utf8', cwd: REPO_ROOT });
}

function runGh(cmd) {
  try { return { ok: true, out: _ghImpl(cmd) }; }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
}

// ---------- gates ----------

export function gateProjectLocality({ repoRoot = REPO_ROOT, skillMd = SKILL_MD } = {}) {
  let skillSource;
  try { skillSource = readFileSync(skillMd, 'utf8'); }
  catch (e) {
    return { ok: false, halt: `## Preflight halt: skill SKILL.md unreadable\n\n${skillMd}: ${e.message}` };
  }
  const fm = parseFrontmatter(skillSource);
  const required = fm.requires_files || [];
  if (required.length === 0) return { ok: true };
  const missing = required.filter((p) => !existsSync(resolve(repoRoot, p)));
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    halt: [
      '## Preflight halt: project-locality',
      '',
      'The plan-execution skill expects an ai-sidekicks-shaped repo with these files:',
      ...required.map((p) => `  - ${p}`),
      '',
      'Missing from this repo:',
      ...missing.map((p) => `  - ${p}`),
      '',
      'Re-run from a repo with these surfaces, or fork the skill and amend the',
      '`requires_files:` frontmatter at .claude/skills/plan-execution/SKILL.md.',
    ].join('\n'),
  };
}

export function gateAuditCheckbox(planSource, planFile) {
  if (extractAuditCheckbox(planSource)) return { ok: true };
  return {
    ok: false,
    halt: [
      '## Preflight halt: audit-complete checkbox unchecked',
      '',
      `Plan ${planFile} has not passed the plan-readiness audit. The Status`,
      'Promotion Gate from docs/operations/plan-implementation-readiness-audit-runbook.md',
      'blocks code-execution dispatch on un-audited plans.',
      '',
      'Run the audit first, or document an explicit waiver in the plan body',
      'before re-running.',
    ].join('\n'),
  };
}

function _phaseAlreadyShipped(merged, planNumber, phase) {
  const planNum3 = String(planNumber).padStart(3, '0');
  const prFormPattern = new RegExp(`Plan-${planNumber}\\b.*PR\\s*#${phase.number}\\b`, 'i');
  const phaseFormPattern = new RegExp(`Plan-${planNum3}\\b.*Phase\\s*${phase.number}\\b`, 'i');
  for (const pr of merged) {
    const t = pr.title || '';
    if (prFormPattern.test(t) || phaseFormPattern.test(t)) return t;
    if (phase.title && phase.title.length >= 8 &&
        t.toLowerCase().includes(phase.title.toLowerCase())) return t;
  }
  return null;
}

export function gatePhaseUnshipped(planNumber, phase, mergedList) {
  let merged = mergedList;
  if (!Array.isArray(merged)) {
    const planNum3 = String(planNumber).padStart(3, '0');
    const r = runGh(`gh pr list --state merged --search "Plan-${planNum3} in:title" --json number,title --limit 50`);
    if (!r.ok) {
      return { ok: false, halt: `## Preflight halt: gh CLI failed for phase-unshipped check\n\n${r.error}`, internal: true };
    }
    try { merged = JSON.parse(r.out || '[]'); }
    catch { merged = []; }
  }
  const matchedTitle = _phaseAlreadyShipped(merged, planNumber, phase);
  if (!matchedTitle) return { ok: true };
  return {
    ok: false,
    halt: [
      '## Preflight halt: phase already shipped',
      '',
      `Plan-${planNumber} Phase ${phase.number} ("${phase.title}") matches`,
      `merged PR: "${matchedTitle}". Pick the next un-shipped phase.`,
    ].join('\n'),
  };
}

export function gateTasksBlockCites(phaseSection, planNumber, phaseNumber) {
  const counts = countCites(phaseSection);
  if (counts.spec_coverage > 0 && counts.verifies_invariant > 0) return { ok: true };
  return {
    ok: false,
    halt: [
      '## Preflight halt: tasks-block missing G4 cites',
      '',
      `Plan-${planNumber} Phase ${phaseNumber}'s \`#### Tasks\` block is missing`,
      `\`Spec coverage:\` (${counts.spec_coverage}) or \`Verifies invariant:\``,
      `(${counts.verifies_invariant}) cites. The audit's G4 traceability gate did`,
      `not produce content — re-run the audit before dispatch.`,
      '',
      'Re-deriving task structure from prose discards cites downstream reviewers',
      'depend on (anti-pattern: SKILL.md § Anti-Patterns).',
    ].join('\n'),
  };
}

export function resolvePrecondition(entry, { repoRoot = REPO_ROOT } = {}) {
  switch (entry.type) {
    case 'pr_merged': {
      const r = runGh(`gh pr view ${entry.ref} --json state`);
      if (!r.ok) return { ok: false, halt: `gh pr view ${entry.ref} failed: ${r.error}` };
      let data;
      try { data = JSON.parse(r.out); }
      catch { return { ok: false, halt: `gh pr view ${entry.ref} returned non-JSON: ${r.out.slice(0, 200)}` }; }
      if (data.state === 'MERGED') return { ok: true };
      return { ok: false, halt: `pr_merged ref=${entry.ref} state=${data.state}, expected MERGED` };
    }
    case 'adr_accepted': {
      const adrFile = findPaddedFile(resolve(repoRoot, 'docs', 'decisions'), entry.ref);
      if (!adrFile) return { ok: false, halt: `ADR-${entry.ref} not found in docs/decisions/` };
      const source = readFileSync(adrFile, 'utf8');
      const status = extractAdrStatus(source);
      if (status === 'accepted') return { ok: true };
      return { ok: false, halt: `ADR-${entry.ref} Status=${status || 'unknown'}, expected accepted` };
    }
    case 'plan_phase': {
      const planFile = findPaddedFile(resolve(repoRoot, 'docs', 'plans'), entry.plan);
      if (!planFile) return { ok: false, halt: `Plan-${entry.plan} not found in docs/plans/` };
      const source = readFileSync(planFile, 'utf8');
      if (findProgressLogPhaseEntry(source, entry.phase)) return { ok: true };
      return { ok: false, halt: `Plan-${entry.plan} Phase ${entry.phase} not in Progress Log` };
    }
    case 'cross_plan_carve_out': {
      const xplanPath = resolve(repoRoot, 'docs', 'architecture', 'cross-plan-dependencies.md');
      let source;
      try { source = readFileSync(xplanPath, 'utf8'); }
      catch (e) { return { ok: false, halt: `cross-plan-dependencies.md unreadable: ${e.message}` }; }
      if (source.includes(String(entry.ref))) return { ok: true };
      return { ok: false, halt: `cross_plan_carve_out ref=${entry.ref} not present in cross-plan-dependencies.md` };
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
          '## Preflight halt: phase precondition unmet',
          '',
          `Plan ${planFile} Phase ${phaseNumber} declares precondition:`,
          `  ${JSON.stringify(entry)}`,
          '',
          r.halt,
        ].join('\n'),
      };
    }
  }
  return { ok: true };
}

// ---------- orchestration ----------

function _checkPhase(planSource, planNumber, phase, planFile, mergedList, opts) {
  const ship = gatePhaseUnshipped(planNumber, phase, mergedList);
  if (!ship.ok) {
    if (ship.internal) return { eligible: false, reason: 'gh-error', halt: ship.halt, fatal: true };
    return { eligible: false, reason: 'shipped', halt: ship.halt };
  }
  const sec = extractPhaseSection(planSource, phase.number);
  if (!sec) return { eligible: false, reason: 'no-section', halt: `cannot extract phase ${phase.number} section` };
  const g4 = gateTasksBlockCites(sec, planNumber, phase.number);
  if (!g4.ok) return { eligible: false, reason: 'audit', halt: g4.halt };
  const g5 = gatePreconditions(sec, planFile, phase.number, opts);
  if (!g5.ok) return { eligible: false, reason: 'preconditions', halt: g5.halt };
  return { eligible: true };
}

export function runPreflight(planFile, phaseArg, { repoRoot = REPO_ROOT, skillMd = SKILL_MD } = {}) {
  const g1 = gateProjectLocality({ repoRoot, skillMd });
  if (!g1.ok) return { exit: 1, stdout: g1.halt };

  let planSource;
  try { planSource = readFileSync(planFile, 'utf8'); }
  catch (e) { return { exit: 2, stderr: `read plan ${planFile}: ${e.message}` }; }

  const g2 = gateAuditCheckbox(planSource, planFile);
  if (!g2.ok) return { exit: 1, stdout: g2.halt };

  const planNumber = extractPlanNumber(planFile);
  if (planNumber === null) return { exit: 2, stderr: `bad plan filename: ${basename(planFile)}` };

  const phases = walkPhases(planSource);
  if (phases.length === 0) return { exit: 2, stderr: `no \`### Phase N —\` headers found in ${planFile}` };

  // Pre-fetch merged PR list once for the plan; cuts gh calls in auto-detect from O(phases) to 1.
  const planNum3 = String(planNumber).padStart(3, '0');
  const mergedRes = runGh(`gh pr list --state merged --search "Plan-${planNum3} in:title" --json number,title --limit 50`);
  let merged;
  if (mergedRes.ok) {
    try { merged = JSON.parse(mergedRes.out || '[]'); } catch { merged = []; }
  } else {
    return { exit: 2, stderr: `gh pr list failed: ${mergedRes.error}` };
  }

  const opts = { repoRoot };
  if (phaseArg !== undefined && phaseArg !== null) {
    const target = phases.find((p) => p.number === phaseArg);
    if (!target) return { exit: 1, stdout: `## Preflight halt: phase ${phaseArg} not found in ${planFile}` };
    const r = _checkPhase(planSource, planNumber, target, planFile, merged, opts);
    if (!r.eligible) return { exit: 1, stdout: r.halt };
    return { exit: 0, stdout: String(target.number) };
  }

  const skipped = [];
  for (const p of phases) {
    const r = _checkPhase(planSource, planNumber, p, planFile, merged, opts);
    if (r.fatal) return { exit: 2, stderr: r.halt };
    if (r.reason === 'shipped') continue;
    if (!r.eligible) {
      skipped.push(`Phase ${p.number} (${r.reason}): ${r.halt.split('\n')[0]}`);
      continue;
    }
    return { exit: 0, stdout: String(p.number) };
  }
  const reasonsText = skipped.length
    ? `\n\nNon-eligible phases:\n${skipped.map((s) => `  - ${s}`).join('\n')}`
    : '';
  return {
    exit: 1,
    stdout: `## Preflight halt: no eligible un-shipped phase in ${planFile}${reasonsText}`,
  };
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stderr.write('Usage: node preflight.mjs <plan-file> [phase-number]\nSee preflight-contract.md.\n');
    process.exit(2);
  }
  const planFile = args[0];
  const phaseArg = args[1] !== undefined ? Number(args[1]) : undefined;
  if (args[1] !== undefined && (Number.isNaN(phaseArg) || !Number.isInteger(phaseArg))) {
    process.stderr.write(`bad phase argument: ${args[1]}\n`);
    process.exit(2);
  }
  const result = runPreflight(planFile, phaseArg);
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  if (result.stderr) process.stderr.write(result.stderr + '\n');
  process.exit(result.exit);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`internal error: ${e.message || String(e)}\n`);
    process.exit(2);
  });
}
