#!/usr/bin/env -S node --experimental-strip-types
// pre-commit-runner — single entry point for the doc-corpus regression hooks.
//
// Composes the lib/ check functions into one process so the lefthook chain has
// one job instead of one per check (path-canonical-ripple, plan-manifest-
// presence, mermaid-set-coherence, cite-target-existence). Same coverage; one
// less layer of config.
//
// argv: zero or more file paths, partitioned by extension into two disjoint
// per-file lanes: staged `.md` governance docs (mermaid + cite) and staged
// `packages/**`+`apps/**` TypeScript (the label-cite floor).
// path-canonical-ripple and plan-manifest-presence run unconditionally (each
// does its own whole-repo enumeration — path-ripple greps the registry `scope`
// globs, manifest-presence walks `git ls-files docs/plans/`).
//
// Optional `--min-md=N` / `--min-code=N` arm a per-lane floor (see
// `parseRunnerArguments`). Off by default, which is the pre-commit posture;
// CI arms both because there an empty lane means enumeration failed rather
// than "this commit touched nothing of that kind".
//
// Cite-target-existence runs against the staged `.md` files PLUS any
// governance-corpus file whose outbound `:NNN` cites resolve into the staged
// set — see `../lib/inbound-cite-discovery.ts`. This widens local pre-commit
// coverage to match the inbound-ripple class CI's `custom-checks` repo-wide
// sweep catches.
//
// label-cite runs against staged code files: governance LABEL cites
// (`Spec-NNN:LL`) in comments get the SAME deterministic floor as markdown
// `file.md:NNN` cites — closing the gap where a spec amendment silently
// invalidated code-comment line cites (PR #139). See `../lib/label-cite.ts`.
//
// table-total-coherence runs against staged `.md` files: a breakdown table
// marked `<!-- corpus:total-check column="..." -->` has that column re-summed
// and reconciled against the in-table **Total** row and any declared prose
// total — failing the census-drift class from the PR #152 retrospective (a
// summary asserting a count while its own column summed to a different one).
// Opt-in by marker, within-document only. See `../lib/table-total-coherence.ts`.
//
// table-arity runs against staged `.md` files: every row of a RECOGNIZED GFM
// table must carry its header's cell count. Unlike table-total it needs no
// opt-in marker — the invariant is structural, true of any table, rather than
// something a document declares. Recognition, however, is a deliberately
// CONSERVATIVE subset of GFM: each table shape outside it is a disclosed and
// measured bound in that module's header, and the gate never fails on markup it
// cannot confidently classify. Catches the unescaped-`|` corruption that
// prettier then makes permanent and formatting-stable. See
// `../lib/table-arity.ts`.

import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  checkCiteTargetExistence,
  formatCiteTargetViolations,
} from "../lib/cite-target-existence.ts";
import {
  expandToInboundCiteCorpus,
  findGovernanceCitersOfCode,
  getRepoRoot,
  makeCommitSnapshotReader,
} from "../lib/inbound-cite-discovery.ts";
import {
  checkLabelCiteTargets,
  checkMarkdownVolatileCites,
  checkSectionCites,
  extractLabelCites,
  formatLabelCiteViolations,
} from "../lib/label-cite.ts";
import { checkMermaidSetCoherence, formatMermaidViolations } from "../lib/mermaid-set-coherence.ts";
import {
  checkPathCanonicalRipple,
  formatPathRippleViolations,
} from "../lib/path-canonical-ripple.ts";
import {
  checkPlanManifestPresence,
  formatPlanManifestViolations,
} from "../lib/plan-manifest-presence.ts";
import { checkTableArity, formatTableArityViolations } from "../lib/table-arity.ts";
import {
  checkTableTotalCoherence,
  formatTableTotalViolations,
} from "../lib/table-total-coherence.ts";

function isMdFile(p: string): boolean {
  try {
    return statSync(p).isFile() && p.endsWith(".md");
  } catch {
    return false;
  }
}

// Per-file checks (mermaid + cite) are scoped to governance corpus only.
// `docs/archive/` is frozen historical content (CLAUDE.md "Documentation
// Corpus") and `docs/reference/` is excerpted upstream materials (CLAUDE.md
// non-governance docs). Citations there describe other projects' source
// files, not ours, so cite-target-existence's missing-target check would
// generate false positives on path-shapes that happen to coincide with our
// own. path-canonical-ripple has its own per-entry scope/exclude in the
// registry and is unaffected.
const PER_FILE_CHECK_EXCLUDED_PREFIXES = ["docs/archive/", "docs/reference/"];

function isInGovernanceCorpus(p: string): boolean {
  return !PER_FILE_CHECK_EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

// Code files carry governance LABEL cites (`Spec-NNN:LL`) in comments; they get
// the deterministic floor via label-cite, NOT the markdown-only per-file checks
// (mermaid, inbound-expansion). Scoped to first-party TypeScript under
// `packages/` + `apps/`; `dist/` is generated output and `.d.ts` are emitted
// declarations — neither hand-authored, so both are excluded to keep the
// required gate to source a developer actually edits.
const CODE_FILE_RE = /\.(ts|tsx|mts|cts)$/;

function isCodeFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
  } catch {
    return false;
  }
  if (!CODE_FILE_RE.test(p) || p.endsWith(".d.ts")) return false;
  if (p.includes("/dist/") || p.startsWith("dist/")) return false;
  return p.startsWith("packages/") || p.startsWith("apps/");
}

export interface RunnerArguments {
  files: string[];
  minimumMd: number;
  minimumCode: number;
}

const LANE_FLOOR_RE = /^--min-(md|code)(?:=(.*))?$/;

/**
 * Split argv into file paths and the two optional per-lane floors.
 *
 * The floors default to `0` — OFF — because the same runner serves two callers
 * for which an empty lane means opposite things. At pre-commit, lefthook passes
 * `{staged_files}`: a commit touching only `.json` derives an empty `.md` lane
 * legitimately, and a hook that refused it would block work it has nothing to
 * say about. In CI the argv comes from `git ls-files` over the whole tracked
 * tree, so an empty lane is an enumeration failure — the `|| true` on those
 * pipelines converts a broken `git ls-files` into an empty array and the
 * required check goes green having validated almost nothing. The flag is what
 * tells the two apart; see `tools/run-node-tests.mjs` `--min-files` for the
 * same floor against the same class (a required gate passing over a zero-match
 * glob).
 */
export function parseRunnerArguments(argv: string[]): RunnerArguments {
  const files: string[] = [];
  let minimumMd = 0;
  let minimumCode = 0;

  for (const argument of argv) {
    const floorMatch = LANE_FLOOR_RE.exec(argument);
    if (floorMatch) {
      const lane = floorMatch[1];
      const rawValue = floorMatch[2];
      // Validate the SHAPE, then convert — never convert then validate.
      // `Number()` maps every whitespace-only string to `0` ("", " ", "\t"),
      // which is an integer and non-negative, so a `--min-md=` or a
      // quoted/config-generated `--min-md=" "` would parse as a silently
      // DISARMED floor: the exact failure this flag exists to close,
      // reintroduced inside its own parser. Number-then-validate also admits
      // `1e3` and `0x10`.
      //
      // `/^\d+$/` allowlists the one legal spelling instead of enumerating
      // illegal ones, so it subsumes all of those in a single bounded rule —
      // the same inversion as the `import.meta` allowlist (PR #265 round 5):
      // ban the capability, do not chase the spellings. A value too large to
      // represent fails CLOSED (an unreachable floor breaches loudly), so the
      // unbounded digit run needs no separate ceiling.
      if (rawValue === undefined || !/^\d+$/.test(rawValue)) {
        throw new Error(
          `--min-${lane} requires a non-negative integer in \`--min-${lane}=N\` form, got: ${argument}`,
        );
      }
      const parsed = Number(rawValue);
      if (lane === "md") minimumMd = parsed;
      else minimumCode = parsed;
      continue;
    }
    // Unknown options THROW rather than falling through to the file list. Both
    // lane filters stat their argument, so a `--min-mb=200` typo would be
    // silently discarded as a nonexistent path, leaving the floor at 0 and the
    // gate reporting clean over a run nothing enforced.
    if (argument.startsWith("-")) {
      throw new Error(`unknown option: ${argument}`);
    }
    files.push(argument);
  }

  return { files, minimumMd, minimumCode };
}

export interface RunChecksResult {
  exitCode: number;
  messages: string[];
  laneCounts: { md: number; code: number };
}

export interface LaneFloors {
  minimumMd?: number;
  minimumCode?: number;
}

export function runChecks(args: string[], floors: LaneFloors = {}): RunChecksResult {
  const stagedMd = args.filter(isMdFile).filter(isInGovernanceCorpus);
  const stagedCode = args.filter(isCodeFile);
  const laneCounts = { md: stagedMd.length, code: stagedCode.length };
  const messages: string[] = [];
  let exitCode = 0;

  // Lane floors are enforced on the PARTITIONED lanes, not on raw argv, and
  // before any check runs.
  //
  // The partition is exactly where a collapse stops being visible. CI passes
  // `"${md_files[@]}" "${code_files[@]}"` as one flat argv, so if the `.md`
  // enumeration collapses while the code one survives, argv is still hundreds
  // of entries long and an argv-total floor passes — while five of the six
  // argv-scoped checks (mermaid, table-total, cite-target, section-cite, md
  // deny) are skipped by their `stagedMd.length > 0` guards and the required
  // check reports success. Only a per-lane count can see that.
  //
  // Returns BEFORE running anything, unlike the per-check failures below: a
  // verdict computed over a collapsed lane is precisely the false clean the
  // floor exists to prevent, and printing it beside the breach invites reading
  // it as coverage.
  const { minimumMd = 0, minimumCode = 0 } = floors;
  const floorBreaches: string[] = [];
  if (stagedMd.length < minimumMd) {
    floorBreaches.push(
      `  .md lane resolved ${stagedMd.length} file(s), --min-md=${minimumMd} required`,
    );
  }
  if (stagedCode.length < minimumCode) {
    floorBreaches.push(
      `  code lane resolved ${stagedCode.length} file(s), --min-code=${minimumCode} required`,
    );
  }
  if (floorBreaches.length > 0) {
    messages.push(
      [
        "docs-corpus: a lane resolved fewer files than its floor — refusing to report a verdict.",
        ...floorBreaches,
        "Either the corpus lost files or the caller's enumeration stopped matching them.",
        "Checks scoped to a collapsed lane are SKIPPED, so the run would otherwise exit 0 having validated almost nothing.",
      ].join("\n"),
    );
    return { exitCode: 1, messages, laneCounts };
  }

  const pathHits = checkPathCanonicalRipple();
  if (pathHits.length > 0) {
    messages.push(formatPathRippleViolations(pathHits));
    exitCode = 1;
  }

  // Whole-repo, like path-canonical-ripple above: enforces a parseable Shipment
  // Manifest on every dispatchable plan regardless of which files are staged, so
  // a plan can never reach review/approved/completed without one (preflight
  // Gate 3 would otherwise HALT mid-run).
  const manifestHits = checkPlanManifestPresence();
  if (manifestHits.length > 0) {
    messages.push(formatPlanManifestViolations(manifestHits));
    exitCode = 1;
  }

  if (stagedMd.length > 0) {
    const mermaidHits = checkMermaidSetCoherence(stagedMd);
    if (mermaidHits.length > 0) {
      messages.push(formatMermaidViolations(mermaidHits));
      exitCode = 1;
    }
  }

  // Arithmetic guard for opt-in `<!-- corpus:total-check ... -->` breakdown
  // tables: re-sum the marked column and reconcile it against the in-table
  // **Total** row and any declared prose total. Closes the F-4 gap from the
  // PR #152 retrospective (a census summary that drifted from its own column).
  if (stagedMd.length > 0) {
    const totalHits = checkTableTotalCoherence(stagedMd);
    if (totalHits.length > 0) {
      messages.push(formatTableTotalViolations(totalHits));
      exitCode = 1;
    }
  }

  // Every content-reading check below validates the COMMIT, not the editor
  // buffer: ONE commit-snapshot reader serves table-arity, the cite floors,
  // §-verification, and both volatile-cite denies. Citers and targets alike
  // read the git INDEX (`git show :path`) — the staged blob is what ships, so
  // a raw cite that is staged-but-fixed-only-in-worktree still blocks, clean
  // staged content is never blamed for unstaged WIP, and a staged heading
  // rename verifies against the staged target (Codex, PR #207 round 2 for the
  // md deny; extended to every pass in round 3 — a split-reader runner re-opens
  // the same staged-vs-worktree divergence in whichever lane keeps the worktree
  // read, which is why table-arity joined it rather than keeping its own
  // `readFileSync`: PR #269 round 2). The disk fallback applies ONLY to files
  // named in THIS invocation's argv (probes, previews) — any other index miss
  // throws, so neither a staged deletion with a restored worktree copy nor a
  // staged citer citing an untracked target can pass (see
  // makeCommitSnapshotReader, rounds 3-4). Both per-file lanes are subsets of
  // argv, so every file they hand the reader is on that allowlist and an index
  // miss falls back to disk instead of throwing. CI invokes this same runner on
  // a clean checkout where index and worktree are identical, so the reader is
  // invocation-agnostic. Constructed here, ahead of its first consumer: it
  // opens no subprocess until a path is actually read, and it memoizes, so the
  // two lanes share one `git show` per file rather than one each.
  const repoRoot = getRepoRoot();
  const reader = makeCommitSnapshotReader(repoRoot, args);

  // Structural guard on EVERY table (no marker opt-in): each row must carry its
  // header's cell count. An unescaped `|` inside a cell — a code span included,
  // since backticks do not shield it — silently re-splits the row, and prettier
  // then reflows the table around the stray pipe and passes every subsequent
  // `--check` on the corrupted result. Formatting-stable is not correct.
  if (stagedMd.length > 0) {
    const arityHits = checkTableArity(stagedMd, reader);
    if (arityHits.length > 0) {
      messages.push(formatTableArityViolations(arityHits));
      exitCode = 1;
    }
  }

  if (stagedMd.length > 0) {
    // §-form citers reach the expansion via the extractor callback — their
    // cite shape lives in label-cite, not extractCites (a staged heading
    // rename must pull in the unstaged `Spec-NNN §Old Heading` citer).
    const sectionCiteTargets = (candidate: string): string[] =>
      extractLabelCites(candidate, reader)
        .filter((cite) => cite.section !== undefined)
        .map((cite) => cite.targetPath);
    const expanded = expandToInboundCiteCorpus(stagedMd, repoRoot, reader, sectionCiteTargets);
    const citeHits = checkCiteTargetExistence(expanded, reader);
    if (citeHits.length > 0) {
      messages.push(formatCiteTargetViolations(citeHits));
      exitCode = 1;
    }
    // Backticked `Spec-NNN §Heading` cites in DOCS verify against the
    // resolved doc's headings, same as code citers — a section-only walk
    // (frozen-pin md floors stay cite-target-existence's beat above; raw
    // volatile md spellings are the deny's beat below).
    const sectionHits = checkSectionCites(expanded, reader);
    if (sectionHits.length > 0) {
      messages.push(formatLabelCiteViolations(sectionHits));
      exitCode = 1;
    }
    // Volatile line-cite DENY for md citers (post-sweep ratchet, 2026-07
    // corpus-wide sweep): raw label / docs-path / link colon and line-word
    // spellings — including wrap-split pairs — are denied outside the named
    // exemptions (frozen targets, exempt citer trees, plan Tasks-block
    // grammar, waiver-marked example lines, fences). Scoped to argv-staged
    // md, NOT the expanded corpus: the deny gates INTRODUCTION, and blaming
    // a bystander commit for an unstaged citer's pre-existing pin would
    // block developers on debt they did not write. CI passes the full
    // tracked md tree through this same runner, so corpus-wide enforcement
    // still holds on every PR. Content comes from the shared commit-
    // snapshot (index-first) reader above.
    const mdDenyHits = checkMarkdownVolatileCites(stagedMd, reader);
    if (mdDenyHits.length > 0) {
      messages.push(formatLabelCiteViolations(mdDenyHits));
      exitCode = 1;
    }
  }

  if (stagedCode.length > 0) {
    // Governance LABEL cites (`Spec-NNN:LL`) — the deterministic floor the
    // markdown-only walk never reached. Citers and their resolved doc
    // targets both read the shared commit-snapshot reader: the code lane's
    // deny (passes 5-6) gates introduction on the staged blob exactly like
    // the md deny above. No inbound-expansion for code: CI's full-tree
    // sweep re-checks every code cite on each PR, the backstop for the doc-
    // only-amend case (a spec shifts with no code file staged), so code-side
    // inbound discovery would only duplicate it.
    //
    // Backtick PATH-form cites (`docs/specs/003-x.md:12`) are deliberately NOT
    // floored here: that extractor resolves the target repo-root-relative —
    // correct for governance docs, but it mints false positives on the
    // package-relative code-to-code refs that dominate comments
    // (`internal/branded.ts:25` → `packages/contracts/src/internal/branded.ts`).
    // The lone governance path-cite in code was normalized to the LABEL form;
    // NEW path / basename line-word spellings are denied by label-cite
    // passes 5-6 (CAT-07 ratchet), wrap-split pairs included — the
    // audit-layer residual via /ripple-check is what no static key reaches
    // (label-less continuations; semantic drift under an intact anchor).
    const labelHits = checkLabelCiteTargets(stagedCode, reader);
    if (labelHits.length > 0) {
      messages.push(formatLabelCiteViolations(labelHits));
      exitCode = 1;
    }

    // C-lite reverse-direction advisory (never blocks): a staged code file
    // that governance docs cite may have moved/removed the cited content —
    // tell the developer which citers to eyeball. CI's full sweep remains
    // the enforcement backstop.
    const reverseCiters = findGovernanceCitersOfCode(stagedCode, repoRoot, reader);
    if (reverseCiters.size > 0) {
      const warnLines = [
        "WARNING (advisory): staged code is cited by governance docs — if this edit moved or removed the cited content, update the citing docs:",
      ];
      for (const [citer, targets] of reverseCiters) {
        warnLines.push(`  ${citer} → ${targets.join(", ")}`);
      }
      messages.push(warnLines.join("\n"));
      // exitCode deliberately NOT set.
    }
  }

  return { exitCode, messages, laneCounts };
}

function main(): number {
  let parsed: RunnerArguments;
  try {
    parsed = parseRunnerArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`docs-corpus: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const { files, minimumMd, minimumCode } = parsed;
  const { exitCode, messages, laneCounts } = runChecks(files, { minimumMd, minimumCode });
  // Disclosed only when a floor is armed, which is the enforcement context.
  // A floor that is merely CLEARED still hides a partial drop — 260 `.md`
  // files falling to 40 passes `--min-md=20` silently — so the resolved counts
  // are printed for a human to notice, the same reason run-node-tests prints
  // its resolved file count. The hook path stays quiet: unarmed means
  // per-commit, where the counts are noise on every single commit.
  if (minimumMd > 0 || minimumCode > 0) {
    console.log(
      `docs-corpus: lanes resolved — ${laneCounts.md} .md file(s), ${laneCounts.code} code file(s)`,
    );
  }
  if (messages.length > 0) {
    console.error(messages.join("\n\n"));
  }
  return exitCode;
}

// Direct-invocation guard so `import { runChecks } from "..."` in tests
// doesn't trigger `process.exit`. Compare via `realpathSync` so symlinked
// invocations match (string-comparing `file://${argv[1]}` against
// `import.meta.url` fails on macOS `/tmp` → `/private/tmp` and any repo
// checked out under a symlink — the URL resolves symlinks, raw argv[1] does
// not). Silent guard misfire would disable every pre-commit check.
function isDirectlyInvoked(): boolean {
  const arg = process.argv[1];
  if (typeof arg !== "string") return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectlyInvoked()) {
  process.exit(main());
}
