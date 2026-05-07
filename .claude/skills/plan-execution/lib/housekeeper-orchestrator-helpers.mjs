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

4. Reconcile schema_violations — every entry in \`manifest.schema_violations\` MUST surface in \`manifest.concerns[]\` with the violation's own \`kind\` verbatim (the script emits \`"schema_violation"\` for \`PRs:\` block / missing-required-field shapes and singleton kinds like \`"auto_create_title_seed_underivable"\` for AUTO-CREATE seed failures), plus matching \`field\` and \`ns_id\` when the violation carries them. A single generic concern cannot absorb multiple distinct-kind violations. The script halted with exit ≥1 if any are present; the subagent's job is to surface them, not silently fix them.

5. Reconcile semantic_work_pending — every item in \`manifest.semantic_work_pending\` MUST be paired to either (a) a \`semantic_edits.<item-key>\` entry containing the composed output, or (b) a \`concerns[]\` entry whose \`addressing\` field equals the exact item key verbatim (e.g. \`{kind: "deferred_for_followup", addressing: "set_quantifier_reverification"}\`). The validator pairs each pending item via this \`addressing\` key — \`kind\` is the subagent's choice; only \`addressing\` is the match key. Exception: when returning \`BLOCKED\` or \`NEEDS_CONTEXT\` (subagent halted before completing semantic work), per-item pairing is waived and the validator skips this check.

6. Bound your edits to \`manifest.affected_files\` — out-of-scope edits trigger an orchestrator round-trip per \`references/failure-modes.md\` rule 20 (sprawl routing). To justify a scope expansion, add a \`concerns\` entry \`{kind: affected_files_extension, addressing: <reason>}\` and extend \`affected_files\`.

7. Write back the updated manifest (overwrite \`<manifest-path>\`) plus any direct file edits via the Edit tool.

8. Return one of the four canonical exit-states (per Plan Invariant I-2): DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED. No new exit-state.

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
 *  1. (Codex P2 PR #33 R4) `manifest.result` is one of the four canonical exit-states
 *     (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED) per Plan Invariant I-2.
 *     `null`, `undefined`, or any other string fails. Does NOT short-circuit later
 *     checks — every gap surfaces in one round-trip so the user sees them together.
 *  2. Every item in semantic_work_pending has a corresponding entry in semantic_edits
 *     OR a concerns[] entry whose `addressing` field equals the exact item key
 *     (per canonical-template responsibility #5; `kind` is the subagent's choice,
 *     `addressing` is the validator's match key). WAIVED when
 *     `manifest.result === "BLOCKED" | "NEEDS_CONTEXT"` — the subagent halted before
 *     completing semantic work, so per-item pairing is not required.
 *  3. No <TODO subagent prose> placeholder remains in any affected_files on disk.
 *  4. (P2 fix) No <TODO subagent prose> placeholder in any semantic_edits value (nested scan).
 *  5. Every schema_violations entry is surfaced as its own concerns entry, matched
 *     per-entry on `kind` (the violation's own kind verbatim — `"schema_violation"`
 *     for `PRs:` block / missing-required-field shapes, or singleton kinds like
 *     `"auto_create_title_seed_underivable"` for AUTO-CREATE seed failures), plus
 *     `field` and `ns_id` when the violation carries them. A single generic concern
 *     cannot satisfy multiple violations of distinct kinds; a generic concern with
 *     no `field` cannot trivially absorb a violation that also lacks `field` —
 *     the `kind` discriminator prevents the trivial-equality match (Codex P2 fix).
 *  6. (Codex P1 PR #33 R4) When `manifest.schema_violations` is non-empty, `manifest.result`
 *     MUST equal `"BLOCKED"`. Surfacing the violations in `concerns` (check #5) is necessary
 *     but not sufficient — the contract (`references/post-merge-housekeeper-contract.md`
 *     §Validation invariants line 93) requires the BLOCKED exit-state for halt/routing-path
 *     determinism in Phase E.
 *  7. (D-7 row 14) When `scriptAffectedFiles` is provided, the subagent-emitted
 *     manifest.affected_files MUST be a superset — the subagent may extend the
 *     list (justified via a `concerns` entry of kind `affected_files_extension`)
 *     but MUST NOT drop a file the script declared.
 *
 * @param {{ manifest: object, repoRoot?: string, scriptAffectedFiles?: string[] }} opts
 * @returns {{ valid: true } | { valid: false, gaps: string[] }}
 */
export function validateManifestSubagentStage({
  manifest,
  repoRoot = process.cwd(),
  scriptAffectedFiles = null,
}) {
  const gaps = [];

  // Check #1 — canonical exit-state enforcement (Codex P2 PR #33 R4 / Finding 7).
  // Plan Invariant I-2: subagent MUST return one of {DONE, DONE_WITH_CONCERNS,
  // NEEDS_CONTEXT, BLOCKED}. `null` (script-stage manifest, subagent never ran) and
  // any unknown string break deterministic Phase-E routing. Does NOT short-circuit —
  // continue running the remaining checks so the user sees every gap in one round-trip
  // (avoids whack-a-mole re-dispatch cycles).
  const canonicalStates = new Set(["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"]);
  if (!canonicalStates.has(manifest.result)) {
    const actualLabel =
      manifest.result === null
        ? "null"
        : manifest.result === undefined
          ? "undefined"
          : `"${manifest.result}"`;
    gaps.push(
      `\`result\` is ${actualLabel} but must be one of: DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, BLOCKED (Plan Invariant I-2)`,
    );
  }

  // Halt-state waiver: when subagent returns BLOCKED or NEEDS_CONTEXT, it stopped
  // before completing semantic work. The per-item semantic_work_pending pairing
  // would force false-gap round-trips (see Codex P1 finding on PR #33). Other
  // checks (placeholders, schema_violations, affected_files superset) still apply.
  const haltedBeforeCompletion =
    manifest.result === "BLOCKED" || manifest.result === "NEEDS_CONTEXT";

  if (!haltedBeforeCompletion) {
    for (const item of manifest.semantic_work_pending ?? []) {
      const inEdits =
        manifest.semantic_edits &&
        Object.prototype.hasOwnProperty.call(manifest.semantic_edits, item);
      const inConcerns = (manifest.concerns ?? []).some((c) => c.addressing === item);
      if (!inEdits && !inConcerns)
        gaps.push(
          `${item} listed in semantic_work_pending but absent from semantic_edits and concerns (need either semantic_edits.${item} or a concerns entry with addressing: "${item}")`,
        );
    }
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

  // schema_violations × concerns reconciliation. Each schema_violations entry MUST
  // surface as its OWN concerns entry. Match key is `kind` + `field` + `ns_id`,
  // each compared verbatim. The `kind` discriminator (Codex P2 follow-up to the R1
  // per-entry fix) closes a loophole: when both sv and a generic concern lack `field`,
  // `c.field !== sv.field` was trivially `false` (undefined !== undefined), letting
  // a single generic concern absorb shapes like `{kind: "auto_create_title_seed_underivable"}`
  // that the script emits as singletons without `field`/`ns_id`. By requiring kind
  // alignment, distinct-kind violations cannot share a concern.
  for (const sv of manifest.schema_violations ?? []) {
    const matched = (manifest.concerns ?? []).some((c) => {
      if (c.kind !== sv.kind) return false;
      if (c.field !== sv.field) return false;
      if (sv.ns_id !== undefined && c.ns_id !== sv.ns_id) return false;
      return true;
    });
    if (!matched) {
      const idLabel =
        sv.ns_id && sv.field
          ? `${sv.ns_id}.${sv.field}`
          : sv.field
            ? String(sv.field)
            : `(kind: ${sv.kind})`;
      const matchReqs = `kind: "${sv.kind}"${sv.field !== undefined ? " + matching field" : ""}${sv.ns_id !== undefined ? " + matching ns_id" : ""}`;
      gaps.push(
        `schema_violation ${idLabel} not surfaced in concerns (need entry with ${matchReqs})`,
      );
    }
  }

  // Check #6 — BLOCKED-when-schema-violations enforcement (Codex P1 PR #33 R4 / Finding 6).
  // The matcher loop above handles the SURFACE half ("each violation is in concerns"); this
  // check handles the EXIT-STATE half ("...AND result === BLOCKED"). Contract clause from
  // `references/post-merge-housekeeper-contract.md` §Validation invariants line 93:
  // "...AND `result === "BLOCKED"`". Surfacing alone is insufficient — the BLOCKED state is
  // load-bearing for the orchestrator's halt/routing-path determinism (DONE / DONE_WITH_CONCERNS
  // would silently take the merge-and-continue path even when the script halted on schema_violations).
  const violationsCount = manifest.schema_violations?.length ?? 0;
  if (violationsCount > 0 && manifest.result !== "BLOCKED") {
    const actualLabel =
      manifest.result === null
        ? "null"
        : manifest.result === undefined
          ? "undefined"
          : `"${manifest.result}"`;
    gaps.push(
      `schema_violations present (${violationsCount} entries) but result is ${actualLabel}; contract requires result === "BLOCKED" when schema_violations is non-empty (post-merge-housekeeper-contract.md §Validation invariants)`,
    );
  }

  // D-7 row 14 — superset check. When the orchestrator passes the script's
  // stage-1 affected_files, the subagent's stage-2 list MUST include every
  // entry. Dropping a file is a contract violation (the subagent may not
  // narrow scope; it may only justify expansion via `affected_files_extension`).
  if (Array.isArray(scriptAffectedFiles)) {
    const subagentSet = new Set(manifest.affected_files ?? []);
    for (const path of scriptAffectedFiles) {
      if (!subagentSet.has(path)) {
        gaps.push(
          `${path} declared by script but absent from subagent-emitted affected_files (D-7 row 14: subagent affected_files MUST be a superset of script affected_files)`,
        );
      }
    }
  }

  return gaps.length === 0 ? { valid: true } : { valid: false, gaps };
}

/**
 * Detect whether the merged commit's git-diff touched files outside the
 * manifest's declared `affected_files` (scope sprawl). Pure function — no I/O.
 *
 * Per Plan §Decisions-Locked D-7 row 15 + `references/failure-modes.md` rule 20:
 * sprawl is NOT a hard error. The orchestrator routes to `RESULT: DONE_WITH_CONCERNS`
 * with a `concerns` entry of `kind: affected_files_extension` enumerating the
 * out-of-scope files; the Reviewer/user decides whether to backfill the manifest
 * or roll back the out-of-scope edits.
 *
 * @param {{ manifestAffectedFiles: string[], gitDiffFiles: string[] }} opts
 * @returns {{ sprawl: false } | { sprawl: true, outOfScope: string[], suggestedRouting: "DONE_WITH_CONCERNS", suggestedConcernKind: "affected_files_extension" }}
 */
export function detectAffectedFilesSprawl({ manifestAffectedFiles, gitDiffFiles }) {
  const declared = new Set(manifestAffectedFiles);
  const outOfScope = gitDiffFiles.filter((f) => !declared.has(f));
  return outOfScope.length === 0
    ? { sprawl: false }
    : {
        sprawl: true,
        outOfScope,
        suggestedRouting: "DONE_WITH_CONCERNS",
        suggestedConcernKind: "affected_files_extension",
      };
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
