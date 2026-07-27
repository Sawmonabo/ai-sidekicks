// plan-file.mjs
//
// Shared resolver for `docs/plans/NNN-*.md`. Hoisted here 2026-07-27 so
// post-merge-housekeeper.mjs and rebuild-shipment-manifest.mjs share ONE
// implementation instead of the two divergent copies that existed before
// (the housekeeper's private `findPlanFile` was deleted as a dead duplicate
// when its only caller — the never-firing plan-checklist tick — was retired).
//
// Why a new module rather than importing from rebuild-shipment-manifest.mjs:
// that script top-level-imports `node:child_process` (it shells out to `gh`)
// and the ~223KB preflight.mjs. Plan Invariant I-3 requires the housekeeper's
// module graph to stay on node:fs/path/process and never reach a shell, and
// rebuild-shipment-manifest.mjs's own header names that boundary as the reason
// the two scripts are separate files. The I-3 test greps housekeeper source
// text only, so importing the rebuild script would have satisfied the test
// while breaking the invariant it stands for — a silent violation. This module
// imports node:fs and node:path exclusively, so both callers stay inside I-3.
//
// Node builtins are imported explicitly rather than assumed global: the repo
// eslint config grants node globals to `tools/**`, `*.config.*` and root-level
// `*.{mjs,cjs}` only, which does not reach `.claude/skills/**` subdirectories.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// IDENTITY TOKEN vs FILESYSTEM KEY
// --------------------------------
// A `--plan` value is a DISPATCH token, not a filename fragment. Two shapes are
// legal (post-merge-housekeeper.mjs § PLAN_RE): `NNN` and `NNN-partial`. The
// `-partial` qualifier marks a PR that ships only part of a phase, and it IS
// part of plan IDENTITY — NS headings in docs/architecture/cross-plan-dependencies.md
// literally read `### NS-03: Plan-023-partial Tier 1 — Electron + React skeleton`.
// It is NEVER part of a filename: no file under docs/plans/ carries the suffix,
// so the token `023-partial` must look up `docs/plans/023-*.md`.
//
// Everything that matches identity keeps the FULL token — `verifyPlanIdentity`
// against NS headings, `deriveTitleSeed`, the manifest's provenance `plan`
// field, and rebuild-shipment-manifest.mjs's `gh pr list --search "Plan-<token>"`.
// Only the filesystem lookup is keyed on the bare number.
//
// The normalization lives INSIDE `resolvePlanFile`, not in its callers: a
// caller-applied strip is one a future caller can forget, which is how this bug
// reached a shipped resolver in the first place. `planFilesystemKey` is exported
// only so callers can render the glob they were searched under in error and
// warning text.
export function planFilesystemKey(planToken) {
  // Anchored and single-shot by construction. The resolver TRUSTS its input
  // shape rather than validating it, because both CLI entry points already
  // validate: `PLAN_RE` admits `NNN` and `NNN-partial` for the housekeeper, and
  // rebuild-shipment-manifest.mjs's `parseArgs` is stricter still at `/^\d{3}$/`.
  // A programmatic caller that skips both simply fails to resolve and gets null,
  // which every caller already handles as "no unambiguous plan file".
  return String(planToken).replace(/-partial$/, "");
}

// Returns the path to the single plan file for `plan` (a dispatch token such as
// "024" or "023-partial"), or null when the directory is absent, no file
// matches, or more than one does. Callers cannot distinguish those three
// null causes; every one of them means "this run has no unambiguous plan
// file", which is the only distinction any caller has needed so far.
//
// `plansDir` is joined as given: pass a repo-relative "docs/plans" (the
// default, for cwd-rooted operator tools) or an absolute path under a known
// repo root (what the housekeeper passes, since it never assumes cwd).
export function resolvePlanFile({ plan, plansDir = "docs/plans" }) {
  if (!existsSync(plansDir)) return null;
  const filesystemKey = planFilesystemKey(plan);
  const candidates = readdirSync(plansDir).filter(
    (f) => f.startsWith(`${filesystemKey}-`) && f.endsWith(".md"),
  );
  if (candidates.length !== 1) return null;
  return join(plansDir, candidates[0]);
}
