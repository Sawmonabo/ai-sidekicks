import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

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
 * Decide whether Phase E continues or halts to the user, based on the script's
 * exit code.
 *
 * Mapping:
 *   - 0  success                             -> proceed
 *   - >=6 crash / IO error / arg-validation  -> HALT (script crash)
 *
 * Defensive fallback: any exit code outside that set returns `halt` with
 * `exitClass: "unknown-exit-code"`. The default-deny posture is intentional —
 * continuing over an unrecognized state is the bug class this helper exists to
 * prevent.
 *
 * The `surfacePromptTemplate` on halt-states is the verbatim user-facing
 * message the orchestrator should relay — halt-prose encoded in code, not
 * paraphrased on the fly.
 *
 * @param {{ scriptExitCode: number }} opts
 * @returns {{ action: "proceed" }
 *          | { action: "halt", exitClass: "script-crash" | "unknown-exit-code", reason: string, surfacePromptTemplate: string }}
 */
export function decideHousekeeperRouting({ scriptExitCode }) {
  if (scriptExitCode === 0) {
    return { action: "proceed" };
  }

  if (
    typeof scriptExitCode === "number" &&
    Number.isInteger(scriptExitCode) &&
    scriptExitCode >= 6
  ) {
    return {
      action: "halt",
      exitClass: "script-crash",
      reason: `exit ${scriptExitCode} — script crash / IO error / arg-validation failure`,
      surfacePromptTemplate:
        `Phase E aborted: script returned exit ${scriptExitCode} — crash / IO error / arg-validation failure. ` +
        `Inspect script stderr + the manifest at \`.agents/tmp/housekeeper-manifest-PR<N>.json\` (it may be malformed or absent). ` +
        `Operator action required.`,
    };
  }

  return {
    action: "halt",
    exitClass: "unknown-exit-code",
    reason: `unrecognized script exit code: ${scriptExitCode} (the script emits 0 and >=6 only)`,
    surfacePromptTemplate:
      `Phase E aborted: script returned unrecognized exit code \`${scriptExitCode}\`. ` +
      `The script emits 0 and >=6 only. ` +
      `Inspect the script source for an undocumented exit path or manifest tampering. Operator action required.`,
  };
}

// ---------- Shipment-manifest entry assembly (Phase E step 6) ----------
//
// Background: the post-merge-housekeeper script emits a `proposed_manifest_entry`
// in its JSON manifest output (see post-merge-housekeeper.mjs § buildProposedManifestEntry).
// That entry has the script-knowable fields populated (phase, task, pr, sha,
// merged_at, files) but leaves `verifies_invariant: []` and `spec_coverage: []`
// empty — those come from the audit Tasks-block, which the script has no
// access to (Plan Invariant I-3 forbids git/network and the script has no DAG
// reference). The orchestrator merges those audit-derived fields in here, then
// hands the final entry to `appendManifestEntry` from scripts/lib/manifest.mjs.
//
// The orchestrator-side write path is the canonical pattern: script proposes,
// orchestrator owns the plan-file edit.

/**
 * Pull the script's `proposed_manifest_entry` field out of a parsed
 * housekeeper-manifest object. Returns null when the script ran without
 * `--squash-sha` / `--merged-at` / sufficient task identity (the script's
 * graceful-degradation contract).
 *
 * @param {object} housekeeperManifest — parsed JSON of `.agents/tmp/housekeeper-manifest-PR<N>.json`
 * @returns {object|null}
 */
export function extractProposedEntry(housekeeperManifest) {
  if (!housekeeperManifest || typeof housekeeperManifest !== "object") return null;
  const entry = housekeeperManifest.proposed_manifest_entry;
  if (entry === undefined) return null;
  return entry;
}

/**
 * Merge audit-derived fields (verifies_invariant, spec_coverage) from the DAG
 * task into the script-emitted proposed entry. The DAG task is the analyst's
 * output (see SKILL.md § Phase A); its `verifies_invariant` and `spec_coverage`
 * fields mirror the audit Tasks-block convention 1:1.
 *
 * Optional `notesOverride` lets the orchestrator attach free-form per-PR
 * context (round-trip count, lane label, partial-ship caveats). Omit to leave
 * `notes` unset on the entry.
 *
 * Throws when the proposed entry is null (caller should have short-circuited
 * earlier — null indicates the script ran without manifest-emit args, which
 * is a Phase E configuration bug, not a runtime branch).
 *
 * @param {object} proposedEntry — non-null entry from `extractProposedEntry`
 * @param {object} dagTask — analyst-output task with `verifies_invariant: string[]` + `spec_coverage: string[]`
 * @param {string} [notesOverride] — optional notes block (multi-line allowed)
 * @returns {object} — final entry shape ready for `appendManifestEntry`
 */
export function enrichEntryWithDag(proposedEntry, dagTask, notesOverride) {
  if (!proposedEntry || typeof proposedEntry !== "object") {
    throw new Error(
      "enrichEntryWithDag: proposedEntry is null — script ran without --squash-sha/--merged-at; orchestrator must pass both flags in Phase E step 2",
    );
  }
  if (!dagTask || typeof dagTask !== "object") {
    throw new Error("enrichEntryWithDag: dagTask is required");
  }
  const verifies = Array.isArray(dagTask.verifies_invariant) ? dagTask.verifies_invariant : [];
  const spec = Array.isArray(dagTask.spec_coverage) ? dagTask.spec_coverage : [];
  const out = {
    ...proposedEntry,
    verifies_invariant: verifies,
    spec_coverage: spec,
  };
  if (typeof notesOverride === "string" && notesOverride.length > 0) {
    out.notes = notesOverride;
  }
  return out;
}

/**
 * Convenience: read the housekeeper manifest from disk, extract the proposed
 * entry, and enrich with DAG fields. Returns the final entry or null when the
 * script emitted no proposed entry (graceful-degradation path).
 *
 * @param {object} params
 * @param {string} params.housekeeperManifestPath — absolute path to `.agents/tmp/housekeeper-manifest-PR<N>.json`
 * @param {object} params.dagTask — analyst-output task
 * @param {string} [params.notesOverride] — optional notes block
 * @returns {object|null}
 */
export function buildFinalManifestEntry({ housekeeperManifestPath, dagTask, notesOverride }) {
  if (!housekeeperManifestPath || !existsSync(housekeeperManifestPath)) {
    throw new Error(`buildFinalManifestEntry: manifest not found at ${housekeeperManifestPath}`);
  }
  const raw = readFileSync(housekeeperManifestPath, "utf8");
  const manifest = JSON.parse(raw);
  const proposed = extractProposedEntry(manifest);
  if (proposed === null) return null;
  return enrichEntryWithDag(proposed, dagTask, notesOverride);
}
