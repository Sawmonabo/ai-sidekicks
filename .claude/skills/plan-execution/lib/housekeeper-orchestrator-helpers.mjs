import { readFileSync, existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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
- Do NOT confuse design-spec §6 ("Data flow") with \`cross-plan-dependencies.md\` §6 ("Active Next Steps DAG"); D-2 routes to the latter.
- Do NOT touch \`manifest._script_stage\`. It is the script-embedded immutable snapshot of the four arrays the validator enforces preservation/iteration on (\`affected_files\`, \`schema_violations\`, \`verification_failures\`, \`semantic_work_pending\`); when you rewrite the manifest, copy \`_script_stage\` through verbatim. Removing the key, replacing it with a non-object, or swapping any of its four fields for non-array values is itself a bypass attempt and surfaces in the validator as a structural-tampering gap.`;

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
 *  1. `manifest.result` is one of the four canonical exit-states
 *     (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED) per Plan Invariant I-2.
 *     `null`, `undefined`, or any other string fails. Does NOT short-circuit later
 *     checks — every gap surfaces in one round-trip so the user sees them together.
 *  2. Every item in semantic_work_pending has a corresponding entry in semantic_edits
 *     OR a concerns[] entry whose `addressing` field equals the exact item key
 *     (per canonical-template responsibility #5; `kind` is the subagent's choice,
 *     `addressing` is the validator's match key). The semantic_edits[item] value MUST
 *     be a meaningful payload (not null/undefined/empty-string/empty-array/empty-object)
 *     — key-presence alone does not satisfy the contract clause "containing the composed
 *     output". WAIVED when `manifest.result === "BLOCKED" | "NEEDS_CONTEXT"` — the
 *     subagent halted before completing semantic work, so per-item pairing is not
 *     required.
 *  3. No <TODO subagent prose> placeholder remains in any affected_files on disk.
 *     ALSO: every entry in affected_files MUST exist on disk — the subagent contract
 *     permits edits but not deletions; a missing entry surfaces as a gap rather
 *     than being silently skipped.
 *  4. No <TODO subagent prose> placeholder in any semantic_edits value (nested scan).
 *  5. Every schema_violations entry is surfaced as its own concerns entry, matched
 *     per-entry on `kind` (the violation's own kind verbatim — `"schema_violation"`
 *     for `PRs:` block / missing-required-field shapes, or singleton kinds like
 *     `"auto_create_title_seed_underivable"` for AUTO-CREATE seed failures), plus
 *     `field` and `ns_id` when the violation carries them. A single generic concern
 *     cannot satisfy multiple violations of distinct kinds; a generic concern with
 *     no `field` cannot trivially absorb a violation that also lacks `field` —
 *     the `kind` discriminator prevents the trivial-equality match.
 *  6. When `manifest.schema_violations` is non-empty, `manifest.result` MUST equal
 *     `"BLOCKED"`. Surfacing the violations in `concerns` (check #5) is necessary
 *     but not sufficient — the contract (`references/post-merge-housekeeper-contract.md`
 *     §Validation invariants line 93) requires the BLOCKED exit-state for halt/routing-path
 *     determinism in Phase E.
 *  7. When `scriptAffectedFiles` is provided, the subagent-emitted
 *     manifest.affected_files MUST be a superset — the subagent may extend the
 *     list (justified via a `concerns` entry of kind `affected_files_extension`)
 *     but MUST NOT drop a file the script declared.
 *  8. When `manifest.verification_failures` is non-empty (script exit-2 halt path —
 *     Type-signature / file-overlap / plan-identity mismatch or
 *     multi_pr_task_not_in_block), `manifest.result` MUST equal `"BLOCKED"`. Mirrors
 *     check #6 for schema_violations — surfacing alone is insufficient; the BLOCKED
 *     state is required for halt/routing-path determinism after
 *     candidate-verification failure (per contract
 *     `references/post-merge-housekeeper-contract.md` §exit-code 2 line 79).
 *  9. When `scriptSchemaViolations` is provided, the subagent-emitted
 *     `manifest.schema_violations` MUST contain every entry from the script-stage
 *     snapshot (matched by composite key kind+field+ns_id — same pairing the
 *     surface-matcher in check #5 uses). The subagent rewrites the manifest, so
 *     without this immutable comparison it could clear the array and return
 *     DONE/DONE_WITH_CONCERNS, bypassing the check #6 BLOCKED enforcement
 *     entirely. Mirrors check #7's superset semantics for `affected_files`:
 *     subagent may ADD new violations (rare; would be subagent surfacing schema
 *     problems the script missed) but MUST NOT REMOVE script-stage violations.
 * 10. When `scriptVerificationFailures` is provided, the subagent-emitted
 *     `manifest.verification_failures` MUST contain every entry from the
 *     script-stage snapshot (matched by canonical JSON serialization, since
 *     verification_failure entries are small structured `{kind, ...}` shapes
 *     without a stable composite key). Mirrors check #9's preservation rule for
 *     `schema_violations` — without it, a subagent could clear the array and
 *     return DONE/DONE_WITH_CONCERNS, bypassing the check #8 BLOCKED enforcement
 *     for the exit-2 halt path (Type-signature / file-overlap / plan-identity
 *     mismatch / multi_pr_task_not_in_block).
 * 11. When `scriptSemanticWorkPending` is provided, the per-item pairing iteration
 *     (check #2) reads from the UNION of the script-stage snapshot AND the
 *     subagent-written array — NOT from the subagent array alone. Without this,
 *     a subagent could clear `manifest.semantic_work_pending` and return
 *     DONE/DONE_WITH_CONCERNS; the existing iteration would loop zero times
 *     and emit zero gaps, letting unaddressed semantic work pass validation.
 *     STRUCTURAL DIVERGENCE from checks #9/#10: those guard array-non-emptiness →
 *     BLOCKED state with a separate preservation check; this check feeds the
 *     existing per-item iteration with the immutable script set so the gap message
 *     stays semantically actionable ("X listed but unaddressed") in ONE round-trip
 *     instead of TWO (array-shrink gap → re-add → unaddressed). Subagent MAY add
 *     new pending items (the union catches those too).
 * 12. `manifest._script_stage` is the script-embedded immutable snapshot of the
 *     four checked arrays (affected_files / schema_violations /
 *     verification_failures / semantic_work_pending). The validator reads
 *     `_script_stage` directly from the manifest so the four preservation/iteration
 *     checks (#7 / #9 / #10 / #11) work end-to-end WITHOUT requiring the
 *     orchestrator to plumb scriptXXX params at every callsite. PRECEDENCE per
 *     field: explicit scriptXXX param > `manifest._script_stage[field]` > `null`
 *     (legacy fallback when neither source is available — preserves test fixtures
 *     that don't construct `_script_stage`). STRUCTURAL TAMPERING DETECTION: when
 *     ANY scriptXXX param is null (validator is relying on the manifest-embedded
 *     snapshot path), `manifest._script_stage` MUST be a non-array object whose
 *     four fields are each arrays — missing, scalar, array, or non-array-typed
 *     fields all surface as gaps. Without this guard, a subagent could (a) clear
 *     `manifest.schema_violations` AND (b) ALSO remove `_script_stage`, restoring
 *     the bypass class (validator finds no comparison source for checks
 *     #7/#9/#10/#11 → checks short-circuit on `Array.isArray(null)` → empty
 *     subagent arrays + cleared snapshot → DONE returned with no gaps). When ALL
 *     four scriptXXX params are passed (the explicit-orchestrator-plumbing path),
 *     the validator skips the structural-tampering check entirely — the snapshot
 *     source is external and untamperable, and `_script_stage` becomes decorative.
 *     Subagent contract: `_script_stage` is READ-ONLY; touching it surfaces here
 *     as a structural-tampering gap (per agent file + contract doc).
 *
 * @param {{ manifest: object, repoRoot?: string, scriptAffectedFiles?: string[], scriptSchemaViolations?: object[], scriptVerificationFailures?: object[], scriptSemanticWorkPending?: string[] }} opts
 *   `manifest._script_stage` (when present) shape: `{ affected_files: string[],
 *   schema_violations: object[], verification_failures: object[],
 *   semantic_work_pending: string[] }` — see contract doc §Manifest schema.
 * @returns {{ valid: true } | { valid: false, gaps: string[] }}
 */
export function validateManifestSubagentStage({
  manifest,
  repoRoot = process.cwd(),
  scriptAffectedFiles = null,
  scriptSchemaViolations = null,
  scriptVerificationFailures = null,
  scriptSemanticWorkPending = null,
}) {
  const gaps = [];

  // Check #12 — structural-shape tampering detection on `manifest._script_stage`.
  // When ANY scriptXXX param is null, the validator falls back to the
  // manifest-embedded snapshot for that field; if the snapshot is missing or
  // malformed the four preservation/iteration checks (#7/#9/#10/#11) silently
  // disable, restoring the bypass class where a subagent could clear emitted
  // arrays AND remove the snapshot to bypass BLOCKED enforcement. When ALL four
  // scriptXXX are passed (orchestrator-explicit-plumbing path), the snapshot
  // source is external and the structural check is skipped.
  const fromManifest = manifest._script_stage;
  const reliesOnManifestSnapshot =
    scriptAffectedFiles == null ||
    scriptSchemaViolations == null ||
    scriptVerificationFailures == null ||
    scriptSemanticWorkPending == null;
  if (reliesOnManifestSnapshot) {
    if (fromManifest === undefined || fromManifest === null) {
      gaps.push(
        `manifest._script_stage missing — subagent contract requires preserving the immutable script-stage snapshot; removing _script_stage circumvents preservation checks #7/#9/#10/#11`,
      );
    } else if (typeof fromManifest !== "object" || Array.isArray(fromManifest)) {
      const actualKind = Array.isArray(fromManifest) ? "array" : typeof fromManifest;
      gaps.push(
        `manifest._script_stage is not an object (got ${actualKind}) — structural tampering detected`,
      );
    } else {
      for (const field of [
        "affected_files",
        "schema_violations",
        "verification_failures",
        "semantic_work_pending",
      ]) {
        if (!Array.isArray(fromManifest[field])) {
          const actualKind =
            fromManifest[field] === undefined ? "undefined" : typeof fromManifest[field];
          gaps.push(
            `manifest._script_stage.${field} is not an array (got ${actualKind}) — structural tampering detected`,
          );
        }
      }
    }
  }

  // Resolve effective script-stage snapshot per-field with precedence:
  // (1) explicit scriptXXX param > (2) manifest._script_stage[field] > (3) null.
  // The (3) fallback only triggers when neither source is available — preserves
  // test fixtures that omit both. Defensive type-guards on _script_stage (only
  // treat as object if it survived the structural check above) prevent a
  // malformed snapshot from poisoning the resolved value with non-array data.
  const safeFromManifest =
    fromManifest && typeof fromManifest === "object" && !Array.isArray(fromManifest)
      ? fromManifest
      : null;
  const effScriptAffectedFiles =
    scriptAffectedFiles ??
    (Array.isArray(safeFromManifest?.affected_files) ? safeFromManifest.affected_files : null);
  const effScriptSchemaViolations =
    scriptSchemaViolations ??
    (Array.isArray(safeFromManifest?.schema_violations)
      ? safeFromManifest.schema_violations
      : null);
  const effScriptVerificationFailures =
    scriptVerificationFailures ??
    (Array.isArray(safeFromManifest?.verification_failures)
      ? safeFromManifest.verification_failures
      : null);
  const effScriptSemanticWorkPending =
    scriptSemanticWorkPending ??
    (Array.isArray(safeFromManifest?.semantic_work_pending)
      ? safeFromManifest.semantic_work_pending
      : null);

  // Sanitize each manifest array field ONCE here so every downstream loop
  // iterates a known-good array. Three distinct bug surfaces close in this
  // single block:
  //
  //   1. Container-type tampering: subagent emits an OBJECT or scalar
  //      instead of an array. `(field ?? []).entries()` / `.some()` / `.map()`
  //      would otherwise throw "is not a function". Treat as empty and
  //      surface a structural-tampering gap.
  //   2. Element-shape tampering: subagent emits an array but elements are
  //      null/scalars/arrays instead of objects. Downstream loops would
  //      otherwise dereference `.kind`/`.field`/`.addressing` and throw
  //      TypeError. Filter to objects; surface a structural-tampering gap
  //      per bad entry; iterate the cleaned set everywhere downstream.
  //
  // For arrays of plain strings (affected_files), only container-type +
  // element string-type matter (per-element string check lives inline at
  // the dedicated loop with locality-rich path-containment context). For
  // arrays of objects (schema_violations, concerns, verification_failures),
  // both axes apply.
  //
  // Centralizing the gating in two helpers prevents the bug class from
  // re-entering: a future contract-defined object-array field, or any new
  // callsite that re-iterates these fields, MUST consume the cleaned array.
  const cleanedSchemaViolations = sanitizeObjectArrayField(
    manifest.schema_violations,
    "manifest.schema_violations",
    "{kind, field?, ns_id?}",
    gaps,
  );
  const cleanedConcerns = sanitizeObjectArrayField(
    manifest.concerns,
    "manifest.concerns",
    "{kind, addressing, ...}",
    gaps,
  );
  const cleanedVerificationFailures = sanitizeObjectArrayField(
    manifest.verification_failures,
    "manifest.verification_failures",
    "{kind, ...}",
    gaps,
  );
  const cleanedAffectedFiles = sanitizeStringArrayField(
    manifest.affected_files,
    "manifest.affected_files",
    gaps,
  );
  // Same bug class as the object-array sanitizes above, applied to the
  // semantic_work_pending union below. The downstream `[...effScript, ...manifest]`
  // spread expands a non-iterable manifest field into "object is not iterable" at
  // runtime — `??` only coalesces null/undefined. Sanitize ONLY the manifest side
  // (untrusted subagent output); `effScriptSemanticWorkPending` is upstream-resolved
  // via Array.isArray so the spread on the script side is safe by construction —
  // do NOT symmetry-sanitize the script side or the trusted-vs-untrusted distinction
  // collapses.
  const cleanedSemanticWorkPending = sanitizeStringArrayField(
    manifest.semantic_work_pending,
    "manifest.semantic_work_pending",
    gaps,
  );

  // Check #1 — canonical exit-state enforcement.
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
  // would force false-gap round-trips. Other checks (placeholders,
  // schema_violations, affected_files superset) still apply.
  const haltedBeforeCompletion =
    manifest.result === "BLOCKED" || manifest.result === "NEEDS_CONTEXT";

  if (!haltedBeforeCompletion) {
    // When scriptSemanticWorkPending is provided (resolved via precedence:
    // explicit param > manifest._script_stage.semantic_work_pending > null),
    // iterate the UNION of script-stage snapshot + subagent-written array. The
    // script snapshot is the immutable contract (subagent CANNOT bypass by
    // clearing); the subagent's additions are also iterated (subagent committed
    // to address anything they added). Falls back to subagent-only when both
    // snapshot sources are null (legacy callsites + tests that don't plumb the
    // snapshot).
    const pendingItems =
      effScriptSemanticWorkPending != null
        ? Array.from(
            new Set([...(effScriptSemanticWorkPending ?? []), ...cleanedSemanticWorkPending]),
          )
        : cleanedSemanticWorkPending;
    for (const item of pendingItems) {
      // hasOwnProperty alone admits shapes like
      // `semantic_edits.compose_status_completion_prose = undefined` — key-present
      // but no payload. Contract responsibility #5 requires "an entry containing the
      // composed output", so we require a meaningful payload (not null/undefined/empty).
      const keyPresent =
        manifest.semantic_edits &&
        Object.prototype.hasOwnProperty.call(manifest.semantic_edits, item);
      const editValue = manifest.semantic_edits?.[item];
      const inEdits = keyPresent && isMeaningfulPayload(editValue);
      const inConcerns = cleanedConcerns.some((c) => c.addressing === item);
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

  for (const [idx, path] of cleanedAffectedFiles.entries()) {
    // Defensive type-check BEFORE forwarding to assertRepoRelative — its first
    // call is `isAbsolute(path)`, which throws TypeError on non-string input
    // (null, number, object). A tampered manifest must surface as a
    // structural-tampering gap, not crash the orchestrator mid-validation.
    // Contract violations route through gap-collection so Phase E can
    // re-dispatch the subagent rather than halt with an unhandled exception.
    // typeof-check + idx-position keys the gap so a Reviewer can locate the bad
    // entry without re-parsing the manifest.
    if (typeof path !== "string") {
      gaps.push(
        `affected_files[${idx}] is not a string (got ${path === null ? "null" : typeof path}); subagent contract requires string path entries`,
      );
      continue;
    }
    // Reject absolute or parent-traversal paths BEFORE the existsSync read. The
    // validator must enforce the contract clause "affected_files entries are
    // repo-relative" — otherwise a malformed manifest (`/etc/passwd`,
    // `../../private`) bypasses validation and dead-ends step-7
    // `git add <affected_files>` with an "outside repository pathspec" error.
    // See `assertRepoRelative` JSDoc for the threat model and
    // lexical-vs-realpath rationale.
    const containment = assertRepoRelative(path, repoRoot);
    if (!containment.ok) {
      gaps.push(`${containment.gap} (declared in affected_files)`);
      continue;
    }
    const full = containment.full;
    if (!existsSync(full)) {
      // Bare existsSync gate with no else-branch silently skips any
      // non-existent path, so a subagent that deletes a declared file (e.g.
      // cross-plan-dependencies.md) would pass validation. The contract clause
      // "affected_files ⊇ files actually edited" implies post-edit existence —
      // deletion is a contract violation. Surface as a gap, then skip the
      // placeholder read.
      gaps.push(
        `${path} declared in affected_files but missing from disk — destructive out-of-scope behavior (subagent contract: affected_files MUST exist; deletion is not permitted via the housekeeper subagent surface)`,
      );
      continue;
    }
    // Guard against non-regular files (directories, symlinks pointing at
    // directories, sockets, etc). readFileSync would throw EISDIR on a
    // directory; the contract says affected_files entries are FILES (the script
    // edits line-level content). Surface as a gap rather than crashing the
    // orchestrator — a subagent contract violation must route through the
    // validator's gap-collection path so Phase E can re-dispatch (NOT halt with
    // an unhandled exception).
    let stats;
    try {
      stats = statSync(full);
    } catch (e) {
      gaps.push(
        `${path} declared in affected_files but stat failed (${e.code ?? e.message}); subagent contract requires regular files`,
      );
      continue;
    }
    if (!stats.isFile()) {
      gaps.push(
        `${path} declared in affected_files but is not a regular file (directory or other non-file kind); subagent contract requires regular files for line-level edits`,
      );
      continue;
    }
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch (e) {
      // Defense in depth — even after isFile() passes, readFileSync could fail on
      // permissions, encoding, or transient I/O errors. Surface as a gap, not a crash.
      gaps.push(
        `${path} declared in affected_files but readFileSync failed (${e.code ?? e.message}); subagent contract requires readable file content`,
      );
      continue;
    }
    if (text.includes(PLACEHOLDER))
      gaps.push(`${PLACEHOLDER} placeholder still present in ${path}`);
  }

  // Scan semantic_edits VALUES for leftover placeholders.
  for (const [field, value] of Object.entries(manifest.semantic_edits ?? {})) {
    walkForPlaceholder(value, [field], (path) => {
      gaps.push(`${PLACEHOLDER} placeholder still present in semantic_edits.${path.join(".")}`);
    });
  }

  // schema_violations × concerns reconciliation. Each schema_violations entry MUST
  // surface as its OWN concerns entry. Match key is `kind` + `field` + `ns_id`,
  // each compared verbatim. The `kind` discriminator closes a loophole: when both
  // sv and a generic concern lack `field`, `c.field !== sv.field` was trivially
  // `false` (undefined !== undefined), letting a single generic concern absorb
  // shapes like `{kind: "auto_create_title_seed_underivable"}` that the script
  // emits as singletons without `field`/`ns_id`. By requiring kind alignment,
  // distinct-kind violations cannot share a concern.
  for (const sv of cleanedSchemaViolations) {
    const matched = cleanedConcerns.some((c) => {
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

  // Check #6 — BLOCKED-when-schema-violations enforcement.
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

  // Check #8 — BLOCKED-when-verification_failures enforcement.
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
  // stage-1 affected_files (resolved via precedence: explicit
  // scriptAffectedFiles param > manifest._script_stage.affected_files > null),
  // the subagent's stage-2 list MUST include every entry. Dropping a file is a
  // contract violation (the subagent may not narrow scope; it may only justify
  // expansion via `affected_files_extension`).
  if (Array.isArray(effScriptAffectedFiles)) {
    const subagentSet = new Set(cleanedAffectedFiles);
    for (const path of effScriptAffectedFiles) {
      if (!subagentSet.has(path)) {
        gaps.push(
          `${path} declared by script but absent from subagent-emitted affected_files (D-7 row 14: subagent affected_files MUST be a superset of script affected_files)`,
        );
      }
    }
  }

  // Check #9 — schema_violations preservation.
  // The subagent rewrites the manifest, so without this immutable comparison it
  // could clear `manifest.schema_violations` and return DONE/DONE_WITH_CONCERNS,
  // bypassing check #6's BLOCKED enforcement. Mirror check #7 (scriptAffectedFiles
  // superset) — the subagent's stage-2 schema_violations MUST contain every
  // script-stage entry, matched by composite key kind+field+ns_id (same pairing
  // the check #5 matcher uses). The subagent MAY add new violations (rare) but
  // MUST NOT remove script-stage ones.
  if (Array.isArray(effScriptSchemaViolations)) {
    // Sanitize script-side ELEMENTS before iteration. Container-type was already
    // gated by Array.isArray, but elements can still be null/scalar/array under
    // a tampered `manifest._script_stage.schema_violations`. The loop body
    // dereferences `sv.kind` / `sv.field` / `sv.ns_id` and would TypeError on a
    // null entry — same crash class as the manifest-side sanitize above. Push
    // the same structural-tampering gap the consumer would emit so a malformed
    // snapshot surfaces a recoverable contract violation rather than crashing
    // the validator.
    const cleanedScriptSchemaViolations = sanitizeObjectArrayField(
      effScriptSchemaViolations,
      "manifest._script_stage.schema_violations",
      "{kind, field?, ns_id?}",
      gaps,
    );
    const violationKey = (v) => `${v.kind ?? ""}|${v.field ?? ""}|${v.ns_id ?? ""}`;
    // Use the pre-cleaned subagent array (sanitized once near the top with
    // structural-tampering gaps surfaced for null/non-object entries). Both
    // this preservation loop and the reconciliation loop above iterate the
    // same known-good array, so a tampered manifest can't crash either with
    // TypeError on element dereference.
    const subagentViolationKeys = new Set(cleanedSchemaViolations.map(violationKey));
    for (const sv of cleanedScriptSchemaViolations) {
      if (!subagentViolationKeys.has(violationKey(sv))) {
        const idLabel = [
          sv.kind && `kind=${sv.kind}`,
          sv.field && `field=${sv.field}`,
          sv.ns_id && `ns_id=${sv.ns_id}`,
        ]
          .filter(Boolean)
          .join(" ");
        gaps.push(
          `script-stage schema_violation (${idLabel}) absent from subagent-emitted schema_violations — subagent MUST NOT clear script-stage violations; check #6 BLOCKED enforcement requires the array to remain populated`,
        );
      }
    }
  }

  // Check #10 — verification_failures preservation.
  // Mirror check #9 for the exit-2 halt path. verification_failure entries are
  // small structured `{kind: "..."}` shapes (some carry additional fields like
  // colliding_with) without a stable composite key, so canonical JSON serialization
  // (with sorted keys) is the comparison key — entries are small enough that
  // whole-object comparison is fine. Without this check, a subagent could clear
  // manifest.verification_failures and return DONE/DONE_WITH_CONCERNS, bypassing
  // check #8's BLOCKED enforcement for Type-signature / file-overlap / plan-identity
  // mismatch / multi_pr_task_not_in_block.
  if (Array.isArray(effScriptVerificationFailures)) {
    // Sanitize script-side ELEMENTS before iteration. The `failureKey` closure
    // calls `Object.keys(f)` which throws on a null/undefined element — and the
    // structural check #12 only verifies the container is an array, not that
    // elements are objects. A tampered `manifest._script_stage.verification_failures`
    // containing `[null]` would crash the validator instead of surfacing a
    // structural-tampering gap. Filter to objects, surface a gap per bad entry,
    // iterate the cleaned set so the loop body can safely dereference.
    const cleanedScriptVerificationFailures = sanitizeObjectArrayField(
      effScriptVerificationFailures,
      "manifest._script_stage.verification_failures",
      "{kind, ...}",
      gaps,
    );
    const failureKey = (f) => JSON.stringify(f, Object.keys(f).sort());
    const subagentFailureKeys = new Set(cleanedVerificationFailures.map(failureKey));
    for (const vf of cleanedScriptVerificationFailures) {
      if (!subagentFailureKeys.has(failureKey(vf))) {
        gaps.push(
          `script-stage verification_failure (${JSON.stringify(vf)}) absent from subagent-emitted verification_failures — subagent MUST NOT clear script-stage failures; check #8 BLOCKED enforcement requires the array to remain populated`,
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
 * `hasOwnProperty` returns true for keys whose value is `null` / `undefined` /
 * `""` / `[]` / `{}`, which lets pending items pass the validator with zero
 * payload. This helper rejects those empty shapes so the subagent's
 * DONE/DONE_WITH_CONCERNS cannot ship with unresolved semantic work.
 *
 * Strings are trimmed before the length check so whitespace-only values do not
 * satisfy the contract. Booleans and numbers are rejected because the contract
 * is composed completion-prose; accepting `false`/`0` would let a subagent
 * satisfy `semantic_work_pending` without emitting any output-bearing payload.
 *
 * @param {unknown} value
 * @returns {boolean}
 */

function isMeaningfulPayload(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return false;
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

/**
 * Sanitize a manifest array field whose elements are expected to be plain
 * objects. Surfaces structural-tampering gaps to `gaps` for two failure
 * modes that Array.isArray()-only structural checks miss:
 *
 *   1. Container-type tampering — `manifest.field` is an object/scalar/null
 *      instead of an array. Downstream `(field ?? []).method()` patterns
 *      would otherwise throw "is not a function". Returns `[]` and surfaces
 *      one container-type gap.
 *   2. Element-shape tampering — array elements are null/scalars/arrays
 *      instead of plain objects. Downstream loops would otherwise dereference
 *      `.kind`/`.field`/`.addressing` and throw TypeError. Each bad element
 *      gets an idx-keyed structural-tampering gap and is filtered out.
 *
 * `pretendShape` is the contract-anchored hint embedded in the gap message
 * (e.g., `{kind, field?, ns_id?}`) so the Reviewer / re-dispatched subagent
 * sees the EXPECTED element shape inline with the violation.
 *
 * @param {unknown} field
 * @param {string} fieldLabel - dotted manifest path used in gap messages
 * @param {string} pretendShape - contract-anchored shape hint
 * @param {string[]} gaps - mutable gap array (side-effect target)
 * @returns {object[]}
 */
function sanitizeObjectArrayField(field, fieldLabel, pretendShape, gaps) {
  if (field === undefined || field === null) return [];
  if (!Array.isArray(field)) {
    gaps.push(
      `${fieldLabel} is not an array (got ${field === null ? "null" : typeof field}); subagent contract requires an array of ${pretendShape} entries`,
    );
    return [];
  }
  const cleaned = [];
  for (const [idx, v] of field.entries()) {
    if (v == null || typeof v !== "object" || Array.isArray(v)) {
      gaps.push(
        `${fieldLabel}[${idx}] is not an object (got ${v === null ? "null" : Array.isArray(v) ? "array" : typeof v}); subagent contract requires ${pretendShape} object entries`,
      );
      continue;
    }
    cleaned.push(v);
  }
  return cleaned;
}

/**
 * Sanitize a manifest array field whose elements are expected to be strings.
 * Same threat model as `sanitizeObjectArrayField` but for string-element
 * arrays (e.g., `manifest.affected_files`). Returns the cleaned array of
 * strings; per-element string-type gaps are pushed by the consumer loop
 * (which carries additional path-containment / existsSync context inline)
 * so this helper only handles the container-type axis.
 *
 * @param {unknown} field
 * @param {string} fieldLabel
 * @param {string[]} gaps
 * @returns {unknown[]}
 */
function sanitizeStringArrayField(field, fieldLabel, gaps) {
  if (field === undefined || field === null) return [];
  if (!Array.isArray(field)) {
    gaps.push(
      `${fieldLabel} is not an array (got ${field === null ? "null" : typeof field}); subagent contract requires an array of string entries`,
    );
    return [];
  }
  return field;
}

/**
 * Assert a manifest-declared path is repo-relative AND lexically contained
 * under `repoRoot`. Returns a discriminated union the caller pattern-matches:
 * `{ ok: true, full }` for the joined absolute path, or `{ ok: false, gap }`
 * with a contract-anchored explanation suitable for `gaps.push()`.
 *
 * The `affected_files` loop joins each declared path against `repoRoot` and
 * reads it; without first checking the path was repo-relative, a malformed
 * subagent manifest emitting an absolute path (`/etc/passwd`) or a
 * parent-traversal (`../../private/keys`) bypasses validation — the script's
 * later step-7 `git add <affected_files>` then fails with "outside repository
 * pathspec", dead-ending housekeeping after a supposedly `valid: true`
 * manifest signal.
 *
 * Containment check is purely lexical (no `realpath`, no symlink resolution).
 * Threat model: subagent malformed-path bug, not symlink TOCTOU; lexical
 * `relative()` is cheap, deterministic, and sufficient.
 *
 * `path.join("/root", "/etc/x")` returns "/root/etc/x" (NOT "/etc/x") because
 * `join` lacks `resolve`'s absolute-path short-circuit. So `isAbsolute` must
 * gate FIRST; otherwise `relative()` reports the joined path is contained and
 * we'd silently accept an absolute path the subagent never had authority to
 * declare.
 *
 * @param {string} path - manifest-declared path
 * @param {string} repoRoot - absolute repo root (orchestrator-supplied)
 * @returns {{ok: true, full: string} | {ok: false, gap: string}}
 */
export function assertRepoRelative(path, repoRoot) {
  if (isAbsolute(path)) {
    return {
      ok: false,
      gap: `${path} is an absolute path; subagent contract requires repo-relative paths under ${repoRoot}`,
    };
  }
  const full = join(repoRoot, path);
  const rel = relative(repoRoot, full);
  if (rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..${"\\"}`)) {
    return {
      ok: false,
      gap: `${path} resolves outside the repository (resolved: ${full}); subagent contract requires repo-relative paths under ${repoRoot}`,
    };
  }
  return { ok: true, full };
}

/**
 * Decide whether Phase E should dispatch the housekeeper subagent or halt to
 * the user, based on the script's exit code.
 *
 * SKILL.md Phase E step 4 used to dispatch the subagent unconditionally after
 * manifest validation, but `references/post-merge-housekeeper-contract.md`
 * § Exit codes classifies several exits as orchestrator-stage halts (operator
 * action required, NOT subagent work). Dispatching over a malformed/absent
 * manifest routes a script crash or orchestrator misdispatch into
 * subagent-stage handling, where the LLM is forced to interpret garbage and
 * emit a `RESULT:` tag based on hallucinated state — incorrect routing +
 * wasted round-trips, instead of surfacing the required halt to the user.
 *
 * This helper is the single source of truth for the dispatch/halt mapping.
 * SKILL.md step 4, the contract's § Exit codes table, and any future audit
 * script all delegate here so the mapping cannot drift across surfaces.
 *
 * Mapping (per § Exit codes):
 *   - 0  success                             → dispatch (happy path)
 *   - 1  --candidate-ns NS-XX not found      → HALT (orchestrator misdispatch)
 *   - 2  candidate verification failed       → dispatch (subagent surfaces BLOCKED)
 *   - 3  Done Checklist absent / fully ticked → dispatch (semantic work still applies)
 *   - 4  multi-PR shape, --task arg missing  → HALT (orchestrator misdispatch)
 *   - 5  schema_violations                   → dispatch (subagent surfaces BLOCKED)
 *   - ≥6 crash / IO error / arg-validation   → HALT (script crash)
 *
 * Defensive fallback: any exit code outside the documented set (negative,
 * non-integer, NaN) returns `halt` with `exitClass: "unknown-exit-code"`. The
 * default-deny posture is intentional — dispatching the subagent over an
 * unrecognized state is the bug class this helper exists to prevent.
 *
 * The `surfacePromptTemplate` on halt-states is the verbatim user-facing
 * message the orchestrator should relay (mirrors `detectAffectedFilesSprawl`'s
 * `redispatchPromptTemplate` pattern — halt-prose encoded in code, not
 * paraphrased on the fly).
 *
 * @param {{ scriptExitCode: number }} opts
 * @returns {{ action: "dispatch", exitClass: "subagent-handled" }
 *          | { action: "halt", exitClass: "orchestrator-misdispatch" | "script-crash" | "unknown-exit-code", reason: string, surfacePromptTemplate: string }}
 */
export function decideHousekeeperRouting({ scriptExitCode }) {
  if (
    scriptExitCode === 0 ||
    scriptExitCode === 2 ||
    scriptExitCode === 3 ||
    scriptExitCode === 5
  ) {
    return { action: "dispatch", exitClass: "subagent-handled" };
  }

  if (scriptExitCode === 1 || scriptExitCode === 4) {
    const reason =
      scriptExitCode === 1
        ? "exit 1 — `--candidate-ns NS-XX` not found in `docs/architecture/cross-plan-dependencies.md` §6 (orchestrator dispatched the script with an NS that does not exist in the catalog)"
        : "exit 4 — candidate has multi-PR shape but `--task <task-id>` arg was missing (orchestrator dispatched `--candidate-ns` mode without the required task selector for a multi-PR entry)";
    return {
      action: "halt",
      exitClass: "orchestrator-misdispatch",
      reason,
      surfacePromptTemplate:
        `Phase E aborted: script returned exit ${scriptExitCode} — orchestrator misdispatch. ${reason}. ` +
        `Operator action required: re-run Phase E step 1 (candidate-lookup) with corrected flags. ` +
        `Do NOT dispatch the housekeeper subagent — the manifest reflects a dispatch bug, not semantic work.`,
    };
  }

  if (
    typeof scriptExitCode === "number" &&
    Number.isInteger(scriptExitCode) &&
    scriptExitCode >= 6
  ) {
    return {
      action: "halt",
      exitClass: "script-crash",
      reason: `exit ${scriptExitCode} — script crash / IO error / arg-validation failure (per contract § Exit codes ≥6)`,
      surfacePromptTemplate:
        `Phase E aborted: script returned exit ${scriptExitCode} — crash / IO error / arg-validation failure. ` +
        `Inspect script stderr + manifest at \`.agents/tmp/housekeeper-manifest-PR<N>.json\` (manifest may be malformed or absent). ` +
        `Operator action required — do NOT dispatch the housekeeper subagent over a crashed script's output.`,
    };
  }

  return {
    action: "halt",
    exitClass: "unknown-exit-code",
    reason: `unrecognized script exit code: ${scriptExitCode} (contract § Exit codes documents 0-5 and ≥6 only)`,
    surfacePromptTemplate:
      `Phase E aborted: script returned unrecognized exit code \`${scriptExitCode}\`. ` +
      `Contract § Exit codes documents 0-5 and ≥6 only. ` +
      `Inspect script source for an undocumented exit path or manifest tampering. Operator action required.`,
  };
}
