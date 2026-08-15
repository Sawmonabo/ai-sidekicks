#!/usr/bin/env node
// rebuild-shipment-manifest.mjs
//
// Recovery tool: rebuild a plan's `### Shipment Manifest` block from gh PR
// history. Use cases:
//   1. Plan pre-dates the housekeeper's structured-manifest write path
//      (Plan-001 / Plan-007 backfill — see Commit 5 of the cozy-crafting-
//      hummingbird plan).
//   2. Post-merge-housekeeper crashed mid-manifest-write and the on-disk
//      manifest drifted from git history.
//   3. Operator wants to cross-validate a hand-curated manifest against
//      gh ground truth (the Commit 5 cross-check pattern).
//
// Plan Invariant I-3 boundary: post-merge-housekeeper.mjs imports only
// node:fs/path/process and never shells out (asserted by an `I-3 invariant`
// test). This script is intentionally separate so the housekeeper invariant
// stays local; this rebuild script is a one-time / on-demand operator tool
// that DOES use child_process to query gh.
//
// CLI:
//   node --experimental-strip-types \
//     .claude/skills/plan-execution/scripts/rebuild-shipment-manifest.mjs \
//     --plan NNN [--dry-run] [--force] [--include-body-matches]
//
// Exit codes:
//   0  success (entries appended OR --dry-run produced YAML)
//   1  arg-validation failure (missing --plan, malformed value)
//   2  gh runner failure (gh not installed, auth error, network)
//   3  plan file not found at docs/plans/NNN-*.md
//   4  manifest write conflict — entry exists for a PR; pass --force to
//      overwrite (default: refuse to clobber existing entries)
//   5  parse failure — proposed entry failed validateEntry() (caller should
//      inspect output, fix gh data or use --force to skip the bad entry)
//   6  fetch saturation — `gh pr list --limit FETCH_LIMIT` returned exactly
//      FETCH_LIMIT matches, so the result MAY be truncated and completeness
//      cannot be guaranteed. Raise FETCH_LIMIT in this script (or migrate
//      to gh-api-with-pagination) and re-run. This is the loud-failure
//      replacement for the silent truncation that the manifest refactor
//      eliminated from the preflight hot path; the recovery script's cold
//      path inherits the same anti-silent-truncation discipline.

import { execSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  parseManifestBlock,
  appendManifestEntry,
  validateEntry,
  serializeEntry,
  serializeNonShipmentPrs,
} from "./lib/manifest.mjs";
import { resolvePlanFile } from "./lib/plan-file.mjs";
import { MATERIAL_PATH_PREFIXES, hasPlanTitleToken } from "./preflight.mjs";
// MATERIAL_PATH_PREFIXES is one HALF of the skip predicate: a material
// path forces synthesis (fail-open toward validation), but its absence
// alone never justifies a skip — deploy/-only plan tasks exist
// (Plan-025 T-025d-14-1). The other half is the synthesizer's own task
// discriminator. See the predicate comment at the skip site.

// ---------- arg parsing ----------

class ArgError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv) {
  const result = { plan: null, dryRun: false, force: false, includeBodyMatches: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--plan": {
        const value = argv[i + 1];
        if (!value || !/^\d{3}$/.test(value)) {
          throw new ArgError(`--plan requires a 3-digit value (got: ${value ?? "<missing>"})`);
        }
        result.plan = value;
        i += 1;
        break;
      }
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--force":
        result.force = true;
        break;
      case "--include-body-matches":
        result.includeBodyMatches = true;
        break;
      default:
        throw new ArgError(`unknown flag: ${flag}`);
    }
  }
  if (!result.plan) throw new ArgError("--plan is required");
  return result;
}

// ---------- gh runner (default) ----------

function defaultGhRunner(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = new Error(`gh runner failed: ${cmd}\nstderr: ${e.stderr ?? "<no stderr>"}`);
    err.cause = e;
    throw err;
  }
}

// ---------- pure parsing helpers ----------

// Parse phase number from PR title/body. Returns integer >= 1 or null.
// Checks (title first, body second; first match wins):
//   "Phase N" / "phase N"
//   "P5.1"   (Plan-001 phase-number-with-task-suffix style — REQUIRES the
//             `.M` task suffix; bare `P1`/`P2`/`P5` are intentionally NOT
//             matched because they collide with Codex review-priority
//             badges (P1/P2/P3) that can appear in PR bodies. Codex P2
//             finding on PR #35 round 5.)
//
// Cross-plan defense (Codex P2 finding on PR #35 round 6 — mirrors the
// parseTaskFromPr defense from round 1): neither phase pattern carries the
// plan id inline, so a PR body citing "see Plan-001 Phase 5" in a Plan-024
// PR could leak phase 5 into Plan-024's manifest. When the matched text
// (title or body) contains a Plan-NNN reference NOT equal to the target
// plan, that text is skipped. Texts with no Plan-NNN reference at all
// remain captured (most PR titles are bare "Phase N" with no Plan ref —
// the script already surfaces ambiguity for unconfirmed phase mappings).
export function parsePhaseFromPr({ title, body, plan }) {
  const patterns = [/\bPhase\s+(\d+)\b/i, /\bP(\d+)\.\d+\b/];
  const planRefPattern = /\bPlan-(\d{3})\b/g;
  for (const text of [title, body]) {
    if (!text) continue;
    if (plan != null) {
      const planRefs = new Set([...text.matchAll(planRefPattern)].map((m) => m[1]));
      const otherPlanRefs = [...planRefs].filter((r) => r !== plan);
      if (otherPlanRefs.length > 0) continue;
    }
    for (const re of patterns) {
      const m = re.exec(text);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

// Parse task ID(s) from PR title/body. Returns:
//   single string when exactly one task found
//   string[] when multiple distinct task IDs found (legacy multi-task PRs)
//   null when no task ID present
//
// Recognized shapes:
//   T-NNN-N-N or T-NNNp-N-N (audit-runbook style, e.g. T-007p-3-1) — carries
//                            the plan id inline, so always safe to capture.
//   TN.M       (Plan-001 phase-task style, e.g. T5.1) — does NOT carry the
//                            plan id, so capture is gated by a same-text
//                            Plan-${plan} reference (see below).
//
// Cross-plan defense: TN.M is only captured from a text (title or body)
// when that text contains EXACTLY ONE Plan-NNN reference and it equals the
// target plan. This blocks cross-plan citations like "see Plan-001 T5.1
// for context" from leaking into a different plan's shipment manifest
// (the Codex P2 finding on PR #35). Texts with no Plan-NNN ref or with
// mixed Plan-NNN refs surface as ambiguity for operator confirmation
// rather than auto-mapping.
export function parseTaskFromPr({ title, body, plan }) {
  // The optional series letter covers every corpus id family: T-007p-2-4
  // (primary), T-025d-14-1 (deploy), and future letters — the survey's
  // boundary rule already treats letters as id-extending characters, so the
  // extractor must parse what the boundary protects (Codex P2 round 4).
  const planScopedPattern = new RegExp(`\\bT-${plan}[a-z]?-\\d+-\\d+\\b`, "g");
  // Multi-segment: Plan-001's TN.M (T5.1) and Plan-022's TN.M.K (T22.4.4)
  // are both live corpus grammars — a two-segment-only pattern silently
  // TRUNCATES T22.4.4 to "T22.4" and writes a wrong manifest task id
  // (surfaced by the Codex-r4 docs-only shipment test).
  const tnmPattern = /\bT\d+\.\d+(?:\.\d+)*\b/g;
  const planRefPattern = /\bPlan-(\d{3})\b/g;
  const found = new Set();
  for (const text of [title, body]) {
    if (!text) continue;
    const scoped = text.match(planScopedPattern);
    if (scoped) for (const m of scoped) found.add(m);
    const planRefs = new Set([...text.matchAll(planRefPattern)].map((m) => m[1]));
    if (planRefs.size === 1 && planRefs.has(plan)) {
      const tnm = text.match(tnmPattern);
      if (tnm) for (const m of tnm) found.add(m);
    }
  }
  if (found.size === 0) return null;
  const sorted = [...found].sort();
  return sorted.length === 1 ? sorted[0] : sorted;
}

// Build a manifest-entry candidate from a PR's gh JSON. Returns
// { entry, ambiguities: string[] } where ambiguities is non-empty when
// any field needed operator confirmation (and the entry's `notes` field
// records the same).
export function buildEntryFromPr({ pr, details, plan }) {
  const ambiguities = [];
  const phase = parsePhaseFromPr({ ...details, plan });
  const task = parseTaskFromPr({ ...details, plan });
  const sha = (details.mergeCommit?.oid ?? "").slice(0, 7);
  const mergedAt = details.mergedAt ? details.mergedAt.split("T")[0] : null;
  const files = (details.files ?? []).map((f) => f.path).sort();

  if (phase === null) ambiguities.push("phase not in title/body");
  if (task === null) ambiguities.push("no task-id in title/body — phase-level entry");
  if (!sha) ambiguities.push("missing mergeCommit.oid");
  if (!mergedAt) ambiguities.push("missing mergedAt");

  const noteLines = [`Backfill from PR #${pr}.`];
  if (ambiguities.length > 0) {
    noteLines.push(`Operator confirmed: ${ambiguities.join("; ")}.`);
  }

  // The entry shape mirrors lib/manifest.mjs validator. When phase or task
  // can't be derived we still emit the entry (caller decides whether to
  // skip on validateEntry failure or hand-edit before commit).
  const entry = {
    phase: phase ?? 0,
    task: task ?? "",
    pr,
    sha,
    merged_at: mergedAt ?? "",
    files,
    verifies_invariant: [],
    spec_coverage: [],
    notes: noteLines.join(" "),
  };
  return { entry, ambiguities };
}

// ---------- gh fetch (uses ghRunner) ----------

// `gh pr list --limit N` returns at most N matches with no in-band signal
// when the result was truncated. fetchMergedPrNumbers detects saturation
// (`data.length === FETCH_LIMIT`) and throws an error tagged with
// `exitCode = 6` so main fails loudly rather than silently omitting older
// merged PRs (Codex P1 finding on PR #35). Headroom: every plan in this
// repo currently sits well under 100 matches; 1000 mirrors the original
// preflight ceiling that the hot-path manifest refactor eliminated, so
// the cold-path recovery script inherits the same anti-silent-truncation
// discipline. To handle a future plan that legitimately exceeds 1000,
// raise FETCH_LIMIT or migrate to gh-api-with-pagination.
export const FETCH_LIMIT = 1000;

export function fetchMergedPrNumbers({ plan, ghRunner = defaultGhRunner }) {
  // `in:title,body` constrains the GitHub search to PR titles and bodies; without
  // it, the default search also matches review comments / discussion threads, so
  // an unrelated merged PR that mentions "Plan-001" in passing would land in the
  // result set and produce a wrong-phase/wrong-task entry (or stop the backfill
  // with a validation error). Codex P2 finding on PR #35 round 2.
  const cmd = `gh pr list --state merged --search "Plan-${plan} in:title,body" --json number --limit ${FETCH_LIMIT}`;
  const data = JSON.parse(ghRunner(cmd));
  if (data.length === FETCH_LIMIT) {
    const err = new Error(
      `gh pr list returned the maximum ${FETCH_LIMIT} matches for Plan-${plan} — ` +
        `result MAY be truncated; cannot guarantee manifest completeness. ` +
        `Raise FETCH_LIMIT in rebuild-shipment-manifest.mjs or paginate via gh api.`,
    );
    err.exitCode = 6;
    throw err;
  }
  return data.map((p) => p.number).sort((a, b) => a - b);
}

export function fetchPrDetails({ pr, ghRunner = defaultGhRunner }) {
  // changedFiles is the authoritative file-count exposed via GraphQL alongside
  // files. `gh pr view --json files` issues a single `pullRequest.files(first: 100)`
  // GraphQL query — there is no internal pagination, so PRs above the 100-file
  // ceiling silently truncate the returned list. Compare lengths and halt loudly
  // (exit 7) rather than commit a partial files: array to the manifest. Codex
  // P2 finding on PR #35 round 4. Migrating to gh api with cursor pagination is
  // the long-term fix; AI Sidekicks PRs currently sit well under 100 files.
  const cmd = `gh pr view ${pr} --json title,body,mergedAt,mergeCommit,files,changedFiles`;
  const data = JSON.parse(ghRunner(cmd));
  const filesReturned = (data.files ?? []).length;
  if (typeof data.changedFiles === "number" && filesReturned < data.changedFiles) {
    const err = new Error(
      `gh pr view ${pr} returned ${filesReturned} of ${data.changedFiles} changed files — ` +
        `result is truncated; cannot guarantee shipment-manifest file-trace completeness. ` +
        `Migrate fetchPrDetails to gh api with files pagination.`,
    );
    err.exitCode = 7;
    throw err;
  }
  return data;
}

// ---------- plan-file resolver ----------

// Implementation moved to ./lib/plan-file.mjs (2026-07-27) so
// post-merge-housekeeper.mjs can share it without importing this module —
// this one pulls in node:child_process, which the housekeeper's Plan
// Invariant I-3 forbids. Re-exported here because this module's public
// surface is what the rebuild tests import.
//
// THIS MODULE IS BARE-NUMBER-ONLY. `parseArgs` admits `--plan` only as
// `/^\d{3}$/`, so the `NNN-partial` dispatch qualifier the housekeeper accepts
// cannot reach here. That is deliberate, not an oversight: `plan` is
// interpolated into the identity regexes `parseTaskFromPr` and `titleTokenRe`
// build, and `T-023-partial-\d+-\d+` matches no task id in the corpus.
// `resolvePlanFile` normalizes `-partial` for the callers that DO permit it,
// which is why exit 3's message below interpolates `plan` raw — at that point
// `plan` is already the bare number, and normalizing it there would advertise
// a `-partial` capability this module refuses one function above.
export { resolvePlanFile };

// ---------- main ----------

export async function rebuildManifest({
  plan,
  dryRun,
  force,
  includeBodyMatches = false,
  ghRunner = defaultGhRunner,
  plansDir = "docs/plans",
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  const planFile = resolvePlanFile({ plan, plansDir });
  if (!planFile) {
    return { exitCode: 3, message: `plan file not found: ${plansDir}/${plan}-*.md` };
  }

  const prNumbers = fetchMergedPrNumbers({ plan, ghRunner });
  if (prNumbers.length === 0) {
    return { exitCode: 0, message: `no merged PRs found for Plan-${plan}` };
  }

  // PRs the on-disk manifest already records are known lane-1 shipments — a
  // body-only title never demotes them (legacy squash titles pre-date the
  // title-token mandate: Plan-001 shipped via PR #6/#8/#9/#10 with no token;
  // Codex P2 round 2, PR #187). Their on-disk entries are REUSED VERBATIM,
  // never re-synthesized: legacy squash text often carries no parseable
  // Phase/T-markers, so synthesis would degrade a known-good entry to
  // phase 0 / empty task and fail validation (Codex P2 round 3). An
  // unparseable block yields the empty map — the write path re-parses later
  // and fails loudly there where it matters.
  const preParsed = parseManifestBlock(readFileSync(planFile, "utf8"));
  const existingEntryByPr = new Map(
    preParsed.ok ? preParsed.shipped.map((entry) => [entry.pr, entry]) : [],
  );
  // PRs the operator has already ratified as NON-shipments (see lib/manifest.mjs
  // §non_shipment_prs). They are exactly the PRs this tool must NOT propose an
  // entry for: preflight Gate 6 has stopped demanding one, so emitting a
  // candidate here would invite the operator to undo their own ratification.
  //
  // Same empty-on-unparseable fallback as the entry map above, with one extra
  // consequence worth naming: an unparseable block loses the ratifications too,
  // so the `--dry-run` stream both re-proposes entries for them and omits the
  // `non_shipment_prs:` line — pasting that stream back would silently re-arm
  // the Gate 6 halt the key suppresses. Acceptable because an unparseable
  // manifest is itself a hard halt upstream (preflight Gate 3, and the
  // docs-corpus plan-manifest-presence CI guard): the operator fixes the block
  // first, then rebuilds against a manifest this tool can actually read.
  const ratifiedNonShipmentPrs = new Set(preParsed.ok ? preParsed.nonShipmentPrs : []);

  const built = [];
  for (const pr of prNumbers) {
    // Ahead of the title probe: a ratified non-shipment needs no gh round-trip,
    // and the operator already knows why it is absent — they wrote the reason
    // into the manifest.
    if (ratifiedNonShipmentPrs.has(pr)) {
      stderr.write(
        `skipped (ratified non-shipment): PR #${pr} — listed in the plan manifest's non_shipment_prs\n`,
      );
      continue;
    }
    // Candidate precision (2026-07-07): the in:title,body search keeps broad
    // recall for the operator, but only TITLE-tokened PRs are the manifest
    // population — G6 freshness is title-only, and lane-2 enhancement PRs
    // (CONTRIBUTING §How Code Lands) carry `Refs: Plan-NNN` in the BODY by
    // design. Synthesizing entries from body-only matches would fabricate
    // shipped[] state and make preflight Gate 3 silently skip unshipped tasks.
    // The predicate is IMPORTED from preflight.mjs rather than re-declared, so
    // this tool and Gate 6 cannot disagree on the population. They did while it
    // was a local copy: on 2026-08-15 Gate 6 halted naming PR #216 (a compound
    // `Plan-007/025` title GitHub's tokenizer matched for Plan-025) while this
    // tool declined to emit an entry for it — a halt with no remedy. See
    // preflight.mjs §hasPlanTitleToken for the full sync contract, including
    // why the "i" flag is load-bearing on both sides.
    // The probe is title-ONLY and runs BEFORE fetchPrDetails: the full fetch
    // halts loudly (exit 7) when files truncate at the 100-file GraphQL page,
    // and a body-only PR outside the manifest population must not be able to
    // trip that halt (Codex P2, PR #187).
    // Diagnostics go to stderr — dry-run stdout is a pure YAML stream that
    // operators redirect and diff (Codex P2 round 3). Two rescue paths keep
    // body-only shipments in: verbatim reuse of an existing on-disk entry,
    // and --include-body-matches for fresh pre-mandate backfills.
    const { title } = JSON.parse(ghRunner(`gh pr view ${pr} --json title`));
    if (!hasPlanTitleToken(title, plan)) {
      const existingEntry = existingEntryByPr.get(pr);
      if (existingEntry) {
        stderr.write(`reused existing manifest entry (body-only title): PR #${pr} — "${title}"\n`);
        built.push({ entry: existingEntry, ambiguities: [], reused: true });
        continue;
      }
      if (includeBodyMatches) {
        stderr.write(
          `included body-only match (--include-body-matches; operator MUST confirm lane-1 shipment): PR #${pr} — "${title}"\n`,
        );
        try {
          const details = fetchPrDetails({ pr, ghRunner });
          built.push({ ...buildEntryFromPr({ pr, details, plan }), bodyOnly: true });
        } catch (e) {
          if (e.exitCode !== 7) throw e;
          // 100-file truncation: legacy scaffold PRs — the include path's
          // whole audience — routinely exceed the page (Plan-001 PR #6 is a
          // monorepo bootstrap). Rebuild the candidate from a files-free
          // fetch and FORCE it into the operator-confirmation block: a
          // partial files[] must never land as a live entry (Codex P2
          // round 5, PR #187).
          const light = JSON.parse(
            ghRunner(`gh pr view ${pr} --json title,body,mergedAt,mergeCommit`),
          );
          built.push({
            ...buildEntryFromPr({ pr, details: { ...light, files: [] }, plan }),
            bodyOnly: true,
            forcedErrors: [
              "file list truncated at the 100-file GraphQL page — fill files[] by hand (gh api with cursor pagination)",
            ],
          });
          stderr.write(
            `  file list truncated at the 100-file page — PR #${pr} routed to operator confirmation\n`,
          );
        }
        continue;
      }
      stderr.write(
        `skipped (no title token): PR #${pr} — "${title}" (body-only match; enhancement-lane or passing mention — legacy pre-mandate shipments need --include-body-matches)\n`,
      );
      continue;
    }
    const details = fetchPrDetails({ pr, ghRunner });
    // A title-tokened PR is a shipment iff the synthesizer can anchor a
    // manifest entry on it. File shape cannot make that call — three Codex
    // rounds each broke a path allow-list (deploy/-only shipments, root
    // config shipments like Plan-001 T1.1/T1.4, docs-only shipment tasks
    // like Plan-022 T22.4.4/T22.4.5) — so the skip keys on the
    // synthesizer's own discriminator instead: a candidate with NO
    // plan-scoped task token in title/body AND no MATERIAL_PATH_PREFIXES
    // path is a governance/closure PR (Plan-001's #1/#29 shapes: doc-first
    // closure, plan-doc restructures), not a shipment. Everything else
    // synthesizes: a docs-only PR that names its task ships a real entry,
    // and a token-less MATERIAL PR still enters synthesis and
    // validation-fails loudly (the legacy-PR appendix owns those shapes)
    // instead of skipping silently. When a skipped PR already has an
    // on-disk manifest entry, that ground truth is REUSED verbatim
    // (mirroring the body-only reuse path) rather than re-synthesized
    // (Codex P2 round 1). The exit-7 truncation halt fires in
    // fetchPrDetails BEFORE this filter — a truncated file list cannot
    // prove anything, so it stays fail-closed.
    const filePaths = (details.files ?? []).map((f) => f.path);
    const taskToken = parseTaskFromPr({ ...details, plan });
    const hasMaterialPath = filePaths.some((path) =>
      MATERIAL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
    );
    if (taskToken === null && !hasMaterialPath) {
      const existingEntry = existingEntryByPr.get(pr);
      if (existingEntry) {
        stderr.write(
          `reused existing manifest entry (no task token, no material paths): PR #${pr} — "${title}"\n`,
        );
        built.push({ entry: existingEntry, ambiguities: [], reused: true });
        continue;
      }
      stderr.write(`skipped (no task token, no material paths): PR #${pr} — "${title}"\n`);
      continue;
    }
    built.push(buildEntryFromPr({ pr, details, plan }));
  }

  // Validate every entry; collect failures. Caller can pass --force to
  // skip failed entries (rare — usually means a PR has no merge SHA yet,
  // i.e. it was queued and reverted). Reused entries bypass validation —
  // they are the on-disk ground truth being preserved, not synthesized
  // candidates. Body-only candidates admitted by --include-body-matches
  // route their validation failures to the operator-confirmation block
  // instead of exit 5: pre-mandate squash text usually lacks parseable
  // Phase/T-markers, and the flag exists precisely to emit editable YAML
  // for those (Codex P2 round 3).
  const validated = [];
  const validationFailures = [];
  const operatorConfirm = [];
  for (const item of built) {
    if (item.reused) {
      validated.push(item);
      continue;
    }
    const v = validateEntry(item.entry);
    const forcedErrors = item.forcedErrors ?? [];
    if (forcedErrors.length > 0) {
      // Truncated-fetch candidates are unconditionally operator-confirmed —
      // even when the entry otherwise validates, its files[] is incomplete.
      operatorConfirm.push({
        pr: item.entry.pr,
        errors: [...forcedErrors, ...(v.ok ? [] : v.errors)],
        entry: item.entry,
      });
    } else if (v.ok) {
      validated.push({ entry: item.entry, ambiguities: item.ambiguities });
    } else if (item.bodyOnly) {
      operatorConfirm.push({ pr: item.entry.pr, errors: v.errors, entry: item.entry });
    } else {
      validationFailures.push({ pr: item.entry.pr, errors: v.errors });
    }
  }
  if (validationFailures.length > 0 && !force) {
    return {
      exitCode: 5,
      message:
        `validation failures (use --force to skip):\n` +
        validationFailures.map((f) => `  PR #${f.pr}: ${f.errors.join(" | ")}`).join("\n"),
    };
  }

  if (dryRun) {
    stdout.write(`# Rebuilt manifest for Plan-${plan} (dry run)\n`);
    stdout.write(`manifest_schema_version: 1\n`);
    // Round-trip the ratified non-shipments. This stream is what the operator
    // applies to the plan file, so dropping the key would silently re-arm every
    // Gate 6 halt it suppresses — and the YAML carries no comments, so re-add
    // the rationale comment by hand when pasting a whole block back.
    if (ratifiedNonShipmentPrs.size > 0) {
      stdout.write(`${serializeNonShipmentPrs([...ratifiedNonShipmentPrs])}\n`);
    }
    stdout.write(`shipped:\n`);
    for (const { entry } of validated) {
      for (const line of serializeEntry(entry)) stdout.write(`${line}\n`);
    }
    if (validationFailures.length > 0) {
      stdout.write(`\n# Skipped (validation failures, --force was passed):\n`);
      for (const f of validationFailures) {
        stdout.write(`#   PR #${f.pr}: ${f.errors.join(" | ")}\n`);
      }
    }
    if (operatorConfirm.length > 0) {
      // Commented YAML keeps the stream parseable: the operator fills in the
      // unresolved fields and moves each entry into shipped[] by hand.
      stdout.write(`\n# Operator confirmation needed (body-only matches, unparseable markers):\n`);
      stdout.write(
        `# Edit the fields below, then move each entry into shipped[] once confirmed.\n`,
      );
      for (const oc of operatorConfirm) {
        for (const line of serializeEntry(oc.entry)) stdout.write(`# ${line}\n`);
        stdout.write(`#   ^ unresolved: ${oc.errors.join(" | ")}\n`);
      }
    }
    return {
      exitCode: 0,
      message:
        `${validated.length} entries emitted` +
        (operatorConfirm.length > 0
          ? `; ${operatorConfirm.length} body-only candidates need operator confirmation (commented block above)`
          : ""),
    };
  }

  // Write mode: read plan file, append each entry idempotently. If an
  // entry already exists for a PR, default behavior refuses to overwrite
  // (returns exitCode 4 with detail); --force replaces (NOT YET — current
  // appendManifestEntry is no-op on collision; force-overwrite would need
  // a separate replace helper).
  let source = readFileSync(planFile, "utf8");
  const existing = parseManifestBlock(source);
  if (!existing.ok) {
    return {
      exitCode: 3,
      message: `plan ${planFile} has no parseable manifest block: ${existing.reason}`,
    };
  }
  // Reused entries collide with themselves by construction — appendManifestEntry
  // is an idempotent no-op for them, so they are exempt from the halt.
  const existingPrs = new Set(existing.shipped.map((e) => e.pr));
  const collisions = validated.filter(({ entry, reused }) => !reused && existingPrs.has(entry.pr));
  if (collisions.length > 0 && !force) {
    return {
      exitCode: 4,
      message:
        `manifest already has entries for: ${collisions.map((c) => `#${c.entry.pr}`).join(", ")}\n` +
        `Pass --force to skip these (current --force is no-overwrite skip; in-place replace is not yet supported).`,
    };
  }

  let appended = 0;
  for (const { entry } of validated) {
    const before = source;
    source = appendManifestEntry(source, entry);
    if (source !== before) appended += 1;
  }
  writeFileSync(planFile, source);
  return {
    exitCode: 0,
    message:
      `appended ${appended} new entries to ${planFile} (${validated.length - appended} were already present)` +
      (operatorConfirm.length > 0
        ? `\n${operatorConfirm.length} body-only candidates were NOT written — they need operator confirmation; run with --dry-run to see the commented block`
        : ""),
  };
}

// ---------- CLI entry ----------

/**
 * Direct-invocation guard — same form as
 * `tools/docs-corpus/bin/pre-commit-runner.ts` § isDirectlyInvoked.
 *
 * NOT `import.meta.url === \`file://${process.argv[1]}\``: that compares a
 * percent-ENCODED URL against a raw path, so a checkout under a directory
 * containing a space (or `#`, `?`, non-ASCII) makes them unequal and this script
 * silently does nothing while exiting 0. `realpathSync` on both sides also
 * survives a symlinked invocation (macOS `/tmp` → `/private/tmp`).
 */
function isDirectlyInvoked() {
  const invokedPath = process.argv[1];
  if (typeof invokedPath !== "string") return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that will not resolve to a real file was not this module's entry
    // point, so `false` is the correct answer rather than a swallowed failure.
    return false;
  }
}

if (isDirectlyInvoked()) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(e.exitCode ?? 1);
  }
  rebuildManifest(args)
    .then((r) => {
      // Summary goes to stderr: dry-run stdout is a pure YAML stream that
      // operators redirect (`--dry-run > manifest.yml`), and an uncommented
      // "N entries emitted" line would corrupt it (Codex P2 round 4, PR #187).
      process.stderr.write(`${r.message}\n`);
      process.exit(r.exitCode);
    })
    .catch((e) => {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(e.exitCode ?? 2);
    });
}
