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

// Returns the path to the single plan file for `plan` (a zero-padded plan
// number such as "024"), or null when the directory is absent, no file
// matches, or more than one does. Callers cannot distinguish those three
// null causes; every one of them means "this run has no unambiguous plan
// file", which is the only distinction any caller has needed so far.
//
// `plansDir` is joined as given: pass a repo-relative "docs/plans" (the
// default, for cwd-rooted operator tools) or an absolute path under a known
// repo root (what the housekeeper passes, since it never assumes cwd).
export function resolvePlanFile({ plan, plansDir = "docs/plans" }) {
  if (!existsSync(plansDir)) return null;
  const candidates = readdirSync(plansDir).filter(
    (f) => f.startsWith(`${plan}-`) && f.endsWith(".md"),
  );
  if (candidates.length !== 1) return null;
  return join(plansDir, candidates[0]);
}
