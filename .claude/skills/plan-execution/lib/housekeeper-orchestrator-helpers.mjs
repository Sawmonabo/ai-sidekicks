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
 *     `addressing` is the validator's match key). The semantic_edits[item] value MUST
 *     be a meaningful payload (not null/undefined/empty-string/empty-array/empty-object)
 *     — key-presence alone does not satisfy the contract clause "containing the composed
 *     output" (Codex P2 PR #33 R5 / Finding 9). WAIVED when
 *     `manifest.result === "BLOCKED" | "NEEDS_CONTEXT"` — the subagent halted before
 *     completing semantic work, so per-item pairing is not required.
 *  3. No <TODO subagent prose> placeholder remains in any affected_files on disk.
 *     ALSO: every entry in affected_files MUST exist on disk (Codex P1 PR #33 R6) —
 *     the subagent contract permits edits but not deletions; a missing entry surfaces
 *     as a gap rather than being silently skipped.
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
 *  8. (Codex P1 PR #33 R7 / Finding 11) When `manifest.verification_failures` is
 *     non-empty (script exit-2 halt path — Type-signature / file-overlap /
 *     plan-identity mismatch or multi_pr_task_not_in_block), `manifest.result`
 *     MUST equal `"BLOCKED"`. Mirrors check #6 for schema_violations — surfacing
 *     alone is insufficient; the BLOCKED state is required for halt/routing-path
 *     determinism after candidate-verification failure (per contract
 *     `references/post-merge-housekeeper-contract.md` §exit-code 2 line 79).
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
      // Codex P2 PR #33 R5 / Finding 9: hasOwnProperty alone admitted shapes like
      // `semantic_edits.compose_status_completion_prose = undefined` — key-present
      // but no payload. Contract responsibility #5 requires "an entry containing the
      // composed output", so we require a meaningful payload (not null/undefined/empty).
      const keyPresent =
        manifest.semantic_edits &&
        Object.prototype.hasOwnProperty.call(manifest.semantic_edits, item);
      const editValue = manifest.semantic_edits?.[item];
      const inEdits = keyPresent && isMeaningfulPayload(editValue);
      const inConcerns = (manifest.concerns ?? []).some((c) => c.addressing === item);
      if (!inEdits && !inConcerns) {
        if (keyPresent) {
          // Differentiated gap: key is there but value is empty — more informative for
          // the subagent's round-trip than the generic "absent" message.
          gaps.push(
            `${item} listed in semantic_work_pending: semantic_edits["${item}"] exists but value is empty (need composed output per canonical-template responsibility #5, or a concerns entry with addressing: "${item}")`,
          );
        } else {
          gaps.push(
            `${item} listed in semantic_work_pending but absent from semantic_edits and concerns (need either semantic_edits.${item} or a concerns entry with addressing: "${item}")`,
          );
        }
      }
    }
  }

  for (const path of manifest.affected_files ?? []) {
    const full = join(repoRoot, path);
    if (!existsSync(full)) {
      // Codex P1 PR #33 R6 / Finding 10: prior loop silently skipped any non-existent
      // path (existsSync gate with no else-branch), so a subagent that deleted a declared
      // file (e.g. cross-plan-dependencies.md) passed validation. The contract clause
      // "affected_files ⊇ files actually edited" implies post-edit existence — deletion
      // is a contract violation. Surface it as a gap, then skip the placeholder read.
      gaps.push(
        `${path} declared in affected_files but missing from disk — destructive out-of-scope behavior (subagent contract: affected_files MUST exist; deletion is not permitted via the housekeeper subagent surface)`,
      );
      continue;
    }
    const text = readFileSync(full, "utf8");
    if (text.includes(PLACEHOLDER))
      gaps.push(`${PLACEHOLDER} placeholder still present in ${path}`);
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

  // Check #8 — BLOCKED-when-verification_failures enforcement (Codex P1 PR #33 R7 / Finding 11).
  // Mirrors check #6 for schema_violations. The script halts with exit 2 when candidate
  // verification fails (Type-signature / file-overlap / plan-identity mismatch, or
  // multi_pr_task_not_in_block) and populates `verification_failures` (script lines 1209,
  // 1426, 1446, 1466, 1495). Per contract `references/post-merge-housekeeper-contract.md`
  // §exit-code 2 line 79: "halt BLOCKED via subagent surfacing of `verification_failures`".
  // Surfacing alone is insufficient — the BLOCKED state is load-bearing for the
  // orchestrator's halt/routing-path determinism (DONE / DONE_WITH_CONCERNS would silently
  // take the merge-and-continue path even when the script halted on candidate-verification).
  const verificationFailureCount = manifest.verification_failures?.length ?? 0;
  if (verificationFailureCount > 0 && manifest.result !== "BLOCKED") {
    const actualLabel =
      manifest.result === null
        ? "null"
        : manifest.result === undefined
          ? "undefined"
          : `"${manifest.result}"`;
    gaps.push(
      `verification_failures present (${verificationFailureCount} entries) but result is ${actualLabel}; contract requires result === "BLOCKED" when verification_failures is non-empty (post-merge-housekeeper-contract.md §exit-code 2 / script exit-2 halt path)`,
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
 * Per `references/failure-modes.md` rule 20 + Plan §Decisions-Locked D-7 row 15:
 * first-detection routes to `REDISPATCH`, NOT `DONE_WITH_CONCERNS`. The orchestrator
 * re-dispatches the subagent with the rule-20 (a)/(b) prompt — the subagent must
 * either (a) revert the out-of-scope edits and re-emit the manifest, OR (b) extend
 * `affected_files` AND add a `concerns` entry of `kind: affected_files_extension`
 * justifying the scope expansion. After the re-dispatch returns `DONE`, the
 * orchestrator validates the resolution choice; only if the subagent picks (b) with
 * weak justification does the orchestrator downgrade to `DONE_WITH_CONCERNS` and
 * surface to the user. Returning `DONE_WITH_CONCERNS` at first detection (the
 * pre-Codex-PR-#33-Finding-15 behavior) skipped the corrective round-trip and let
 * unintended out-of-scope edits proceed to commit instead of forcing remediation.
 *
 * The `redispatchPromptTemplate` field provides the verbatim rule-20 prompt the
 * orchestrator should send back to the subagent (with `<file_a>, <file_b>`
 * substituted from `outOfScope`).
 *
 * @param {{ manifestAffectedFiles: string[], gitDiffFiles: string[] }} opts
 * @returns {{ sprawl: false } | { sprawl: true, outOfScope: string[], suggestedRouting: "REDISPATCH", suggestedConcernKind: "affected_files_extension", redispatchPromptTemplate: string }}
 */
export function detectAffectedFilesSprawl({ manifestAffectedFiles, gitDiffFiles }) {
  const declared = new Set(manifestAffectedFiles);
  const outOfScope = gitDiffFiles.filter((f) => !declared.has(f));
  if (outOfScope.length === 0) return { sprawl: false };
  const fileList = outOfScope.join(", ");
  return {
    sprawl: true,
    outOfScope,
    suggestedRouting: "REDISPATCH",
    suggestedConcernKind: "affected_files_extension",
    redispatchPromptTemplate:
      `Your last run edited ${fileList} which are NOT in the manifest's \`affected_files\`. ` +
      `Either (a) revert those out-of-scope edits and re-emit your manifest, OR ` +
      `(b) extend \`affected_files\` AND add a \`concerns\` entry of ` +
      `\`{kind: affected_files_extension, addressing: <reason>}\` to justify the scope expansion.`,
  };
}

/**
 * Decide whether a `semantic_edits[<item>]` value is a "meaningful payload" per
 * canonical-template responsibility #5: an entry "containing the composed output".
 *
 * Codex P2 PR #33 R5 / Finding 9: `hasOwnProperty` returns true for keys whose
 * value is `null` / `undefined` / `""` / `[]` / `{}`, which let pending items pass
 * the validator with zero payload. This helper rejects those empty shapes so the
 * subagent's DONE/DONE_WITH_CONCERNS cannot ship with unresolved semantic work.
 *
 * Numbers, booleans, and other primitives are accepted defensively — semantic_edits
 * values are typically composed prose strings or placeholder-replaced objects, but
 * future contract evolution may legitimately use scalar payloads (e.g. counts), and
 * rejecting them would force a rule change here. Strings are trimmed before the
 * length check so whitespace-only values do not satisfy the contract.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isMeaningfulPayload(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  // numbers, booleans, etc — accept (rare in this contract but don't reject)
  return true;
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
