// node:test suite for validate-review-response.mjs.
// Run via: node --test .claude/skills/plan-execution/scripts/__tests__/validate-review-response.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReviewerResponse,
  validatePhaseD,
  detectConflicts,
  severityMax,
} from '../validate-review-response.mjs';

test('parseReviewerResponse extracts findings with severity, file_line, round_trip_target', () => {
  const src = `## Verification narrative

I checked X.

## Findings

- Severity: ACTIONABLE
- File + line range: \`packages/foo/src/bar.ts:45-52\`
- Spec: foo bar
- Suggested fix: do thing.
- Round-trip target: T1

- Severity: POLISH
- File + line range: \`packages/foo/src/bar.ts:60\`
- Suggested fix: do other thing.

RESULT: DONE_WITH_CONCERNS`;

  const r = parseReviewerResponse(src);
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[0].severity, 'ACTIONABLE');
  assert.equal(r.findings[0].file_line, 'packages/foo/src/bar.ts:45-52');
  assert.equal(r.findings[0].round_trip_target, 'T1');
  assert.equal(r.findings[1].severity, 'POLISH');
  assert.equal(r.findings[1].round_trip_target, null);
  assert.equal(r.result, 'DONE_WITH_CONCERNS');
});

test('parseReviewerResponse handles empty Findings section', () => {
  const src = `## Verification narrative

All good.

## Findings

(none)

RESULT: DONE`;
  const r = parseReviewerResponse(src);
  assert.equal(r.findings.length, 0);
  assert.equal(r.result, 'DONE');
});

test('parseReviewerResponse stops at next ## section', () => {
  const src = `## Findings

- Severity: ACTIONABLE
- File: a.ts:1
- Suggested fix: x

## Notes

- Severity: POLISH (this should NOT count as a finding)
- File: b.ts:2

RESULT: DONE`;
  const r = parseReviewerResponse(src);
  assert.equal(r.findings.length, 1);
});

test('validatePhaseD flags missing stamps', () => {
  const parsed = {
    findings: [
      { severity: 'ACTIONABLE', round_trip_target: 'T1', file_line: 'a.ts:1', text: 'a' },
      { severity: 'POLISH', round_trip_target: null, file_line: 'b.ts:2', text: 'b' },
    ],
    result: 'DONE_WITH_CONCERNS',
  };
  const errs = validatePhaseD(parsed);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].file_line, 'b.ts:2');
});

test('validatePhaseD passes when all findings stamped', () => {
  const parsed = {
    findings: [
      { severity: 'ACTIONABLE', round_trip_target: 'T1', file_line: 'a.ts:1', text: 'a' },
    ],
    result: 'DONE_WITH_CONCERNS',
  };
  assert.equal(validatePhaseD(parsed).length, 0);
});

test('severityMax picks ACTIONABLE > POLISH > VERIFICATION', () => {
  assert.equal(severityMax(['POLISH', 'ACTIONABLE']), 'ACTIONABLE');
  assert.equal(severityMax(['VERIFICATION', 'POLISH']), 'POLISH');
  assert.equal(severityMax(['POLISH']), 'POLISH');
  assert.equal(severityMax([]), null);
});

test('detectConflicts surfaces same-file:line entries from multiple reviewers', () => {
  const responses = [
    { reviewer: 'spec', findings: [{ severity: 'POLISH', file_line: 'a.ts:5', text: 'extract' }] },
    { reviewer: 'quality', findings: [{ severity: 'POLISH', file_line: 'a.ts:5', text: 'do not extract' }] },
  ];
  const conflicts = detectConflicts(responses);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].surface, 'a.ts:5');
  assert.equal(conflicts[0].entries.length, 2);
  assert.equal(conflicts[0].mixed_severity, false);
});

test('detectConflicts flags mixed-severity at same surface', () => {
  const responses = [
    { reviewer: 'spec', findings: [{ severity: 'ACTIONABLE', file_line: 'a.ts:5', text: 'fix' }] },
    { reviewer: 'code', findings: [{ severity: 'POLISH', file_line: 'a.ts:5', text: 'tweak' }] },
  ];
  const conflicts = detectConflicts(responses);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].mixed_severity, true);
  assert.equal(conflicts[0].severity_max, 'ACTIONABLE');
});

test('detectConflicts finds nothing when surfaces differ', () => {
  const responses = [
    { reviewer: 'spec', findings: [{ severity: 'POLISH', file_line: 'a.ts:5', text: '' }] },
    { reviewer: 'code', findings: [{ severity: 'POLISH', file_line: 'b.ts:9', text: '' }] },
  ];
  assert.equal(detectConflicts(responses).length, 0);
});

test('detectConflicts skips findings without file_line', () => {
  const responses = [
    { reviewer: 'spec', findings: [{ severity: 'POLISH', file_line: null, text: '' }] },
    { reviewer: 'code', findings: [{ severity: 'POLISH', file_line: null, text: '' }] },
  ];
  assert.equal(detectConflicts(responses).length, 0);
});
