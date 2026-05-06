import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

// Module-scope literal: the placeholder string the script writes into stubbed `Status:` lines and
// `semantic_edits` values for the subagent to replace. Kept in one place so a future change to the
// literal (or to the validator's checks for it) stays in sync across `validateManifestSubagentStage`
// and `walkForPlaceholder`. Module-private — the prompt template embeds the literal as prose.
const PLACEHOLDER = "<TODO subagent prose>";

// Canonical subagent prompt template — verbatim from
// .claude/skills/plan-execution/references/post-merge-housekeeper-contract.md §Canonical Subagent Prompt Template.
// Plan §Decisions-Locked D-1: this contract is canonical; the script reproduces it verbatim,
// with <manifest-path> / PR #<N> / exit code: <N> substituted at render time.
const CANONICAL_TEMPLATE = `You are the plan-execution-housekeeper subagent. Phase E auto-housekeeping for PR #<N> ran with exit code: <N>. Manifest: <manifest-path>.

Your responsibilities (per Spec §5.4 / §6.2):

1. Compose completion-prose — replace every \`<TODO subagent prose>\` placeholder in the manifest's \`mechanical_edits.status_flip.to_line\` (and in any \`semantic_edits\` field the script left stubbed) with one-line resolution narratives matching the NS-12 precedent shape. Use the merged-commit context (PR title, body, file diff) to ground each narrative.

2. Re-derive set-quantifier claims — read ONLY \`docs/architecture/cross-plan-dependencies.md\` §6 prose paragraphs (the \`## 6. Active Next Steps DAG\` section's intro/closing prose plus inline narrative between NS entries; per Plan §Decisions-Locked D-2). For any quantifying claim invalidated by the merge (e.g. "ready set shares no files with X" / "all Y are Z" / "no W in the list does Q"), surface the invalidation in \`concerns[]\` with \`kind: "set_quantifier_drift"\`.

3. AUTO-CREATE body — if \`manifest.auto_create !== null\`, compose the new NS entry's body (Type / Status / Priority / Upstream / References / Summary / Exit Criteria sub-fields) per the AUTO-CREATE allocation rules in spec §5.4.

4. Reconcile schema_violations — every entry in \`manifest.schema_violations\` MUST surface in \`manifest.concerns[]\` with \`kind: "schema_violation"\`. The script halted with exit ≥1 if any are present; the subagent's job is to surface them, not silently fix them.

5. Bound your edits to \`manifest.affected_files\` — out-of-scope edits trigger an orchestrator round-trip per \`references/failure-modes.md\` rule 20 (sprawl routing). To justify a scope expansion, add a \`concerns\` entry \`{kind: affected_files_extension, addressing: <reason>}\` and extend \`affected_files\`.

6. Write back the updated manifest (overwrite \`<manifest-path>\`) plus any direct file edits via the Edit tool.

7. Return one of the four canonical exit-states (per Plan Invariant I-2): DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. No new exit-state.

Hard rules:
- Do NOT introduce new exit-states.
- Do NOT edit files outside \`manifest.affected_files\`.
- Do NOT leave \`<TODO subagent prose>\` placeholders intact.
- Do NOT read NS catalog item BODIES; the §6-prose-only constraint applies to the set-quantifier reverification surface (responsibility #2).
- Do NOT confuse design-spec §6 ("Data flow") with \`cross-plan-dependencies.md\` §6 ("Active Next Steps DAG"); D-2 routes to the latter.`;

/**
 * Build the housekeeper subagent prompt.
 *
 * BASE prompt = canonical template with three substitutions:
 *   <manifest-path> → manifestPath
 *   PR #<N>         → PR #${prNumber}
 *   exit code: <N>  → exit code: ${scriptExitCode}
 *
 * AUGMENTATIONS appended conditionally on manifest fields:
 *   - auto_create present & non-null → AUTO-CREATE mode line
 *   - schema_violations non-empty    → RESULT: BLOCKED + JSON dump
 *
 * @param {{ manifestPath: string, scriptExitCode: number, prNumber: number, manifest?: object }} opts
 * @returns {string}
 */
export function buildHousekeeperPrompt({ manifestPath, scriptExitCode, prNumber, manifest }) {
  const base = CANONICAL_TEMPLATE.replaceAll("PR #<N>", `PR #${prNumber}`)
    .replaceAll("exit code: <N>", `exit code: ${scriptExitCode}`)
    .replaceAll("<manifest-path>", manifestPath);

  let augmented = base;

  if (manifest?.auto_create !== null && manifest?.auto_create !== undefined) {
    augmented += `\n\nAUTO-CREATE mode: reserved NS slot NS-${manifest.auto_create.reserved_ns_nn}.\n`;
  }

  if (manifest?.schema_violations?.length > 0) {
    augmented += `\n\nRESULT: BLOCKED\nschema_violations: ${JSON.stringify(manifest.schema_violations)}\n`;
  }

  return augmented;
}

/**
 * Validate the manifest after the subagent stage completes.
 *
 * Checks:
 *  1. Every item in semantic_work_pending has a corresponding entry in semantic_edits or concerns.
 *  2. No <TODO subagent prose> placeholder remains in any affected_files on disk.
 *  3. (P2 fix) No <TODO subagent prose> placeholder in any semantic_edits value (nested scan).
 *  4. Every schema_violations entry is surfaced as a concerns entry with kind: "schema_violation".
 *
 * @param {{ manifest: object, repoRoot?: string }} opts
 * @returns {{ valid: true } | { valid: false, gaps: string[] }}
 */
export function validateManifestSubagentStage({ manifest, repoRoot = process.cwd() }) {
  const gaps = [];

  for (const item of manifest.semantic_work_pending ?? []) {
    const inEdits =
      manifest.semantic_edits &&
      Object.prototype.hasOwnProperty.call(manifest.semantic_edits, item);
    const inConcerns = (manifest.concerns ?? []).some((c) => c.addressing === item);
    if (!inEdits && !inConcerns)
      gaps.push(
        `${item} listed in semantic_work_pending but absent from semantic_edits and concerns`,
      );
  }

  for (const path of manifest.affected_files ?? []) {
    const full = join(repoRoot, path);
    if (existsSync(full)) {
      const text = readFileSync(full, "utf8");
      if (text.includes(PLACEHOLDER))
        gaps.push(`${PLACEHOLDER} placeholder still present in ${path}`);
    }
  }

  // P2 fix — scan semantic_edits VALUES for leftover placeholders.
  for (const [field, value] of Object.entries(manifest.semantic_edits ?? {})) {
    walkForPlaceholder(value, [field], (path) => {
      gaps.push(`${PLACEHOLDER} placeholder still present in semantic_edits.${path.join(".")}`);
    });
  }

  // schema_violations × concerns reconciliation
  for (const sv of manifest.schema_violations ?? []) {
    const matched = (manifest.concerns ?? []).some((c) => c.kind === "schema_violation");
    if (!matched) gaps.push(`schema_violation ${sv.kind} not surfaced in concerns`);
  }
  return gaps.length === 0 ? { valid: true } : { valid: false, gaps };
}

/**
 * Recursively walk a value looking for the <TODO subagent prose> placeholder.
 * Calls onHit(path) for every string that contains the placeholder.
 *
 * @param {unknown} value
 * @param {string[]} path
 * @param {(path: string[]) => void} onHit
 */
function walkForPlaceholder(value, path, onHit) {
  if (typeof value === "string") {
    if (value.includes(PLACEHOLDER)) onHit(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkForPlaceholder(item, [...path, String(i)], onHit));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walkForPlaceholder(v, [...path, k], onHit);
  }
}
