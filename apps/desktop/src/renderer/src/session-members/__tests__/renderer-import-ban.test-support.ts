// The direct daemon / control-plane import shapes a renderer view may not carry, once.
//
// ONE HOME BECAUSE TWO SUITES ASK THE SAME QUESTION. `invite-accept-view.test.tsx` and
// `participant-roster.projection.test.tsx` each read their own view's source text and
// each asserted it against a private copy of the same four regexes. Two copies of one
// pattern set is the drift `apps/desktop/AGENTS.md` §Shared code names: the day one is
// tightened the other stays wide, both suites stay green, and nothing anywhere says the
// two disagree about what a banned import looks like.
//
// A SIBLING RATHER THAN A ROOM IN `participant-roster.test-support.ts`, which owns the
// roster's branded-id fixtures and its mock bridge and says so in its own first line.
// This table is about neither view in particular — it is the shape of a ban — so it
// takes a module named for the role, which is what lets a third view's suite reach for
// it without importing a roster's presence snapshots to get there.
//
// EACH PATTERN CARRIES ONE FOIL PER BRANCH IT ADMITS, and that is what makes a clean
// result mean anything: four patterns that matched nothing and four patterns that
// CANNOT match are the same green. ONE foil per pattern was not enough, and the gap was
// not theoretical — a pattern still matches its single sample after an alternation is
// deleted, so all three of the narrowings that most obviously widen the hole passed
// green: the subpath group off `BANNED_BARE_IMPORT` (which re-opens
// `from "@ai-sidekicks/runtime-daemon/internal"`), the `@ai-sidekicks/…` arm off
// `BANNED_SIDE_EFFECT_IMPORT`, and the `packages/…` arm off `BANNED_DYNAMIC_IMPORT`.
// The samples therefore cover every branch each pattern admits — both packages, a
// subpath present and absent wherever the pattern allows one, both top-level import
// shapes wherever it carries two, and all three quote spellings of its character class
// — and the negative control in each consuming suite drives EVERY sample, one case
// apiece. Deleting any one branch leaves a sample its pattern no longer matches, and
// that case turns red naming the branch that went missing.
//
// THE BACKTICK SAMPLES SIT ON THE STATIC FORMS TOO, because the character class admits
// them there. Only the dynamic form can carry one in source a parser would accept; on
// `from "…"` and `import "…"` the spelling is unreachable, so its foil is not closing
// an evasion — it holds the class where it is, so narrowing those two to `["']` is a
// deliberate edit that deletes the sample with it rather than a silent widening in the
// other direction.
//
// THIS IS NOT THE ENFORCEMENT, AND IT NEVER FIRES FIRST. `apps/desktop/eslint.config.mjs`
// bans `@ai-sidekicks/runtime-daemon` and `@ai-sidekicks/control-plane` at `error` for
// renderer source today, beside `electron` / `node:*` / the `main` / `preload` escapes,
// and the package's `lint` script runs that config over `src/` in CI ahead of these
// suites. That ban is also TRANSITIVE where a source-text read cannot be: a view
// refactored to reach the package through a local renderer helper passes every scan
// here, and the helper's own import is what ESLint fails on. What these suites add is
// one module's DIRECT-import surface, read as text and reported per shape.
//
// ALL FOUR ANCHOR ON THE IMPORT SURFACE (`from "…"` / `import "…"` / `import("…")`) and
// never on bare words: both views mention "the local daemon" and "control-plane" in
// PROSE comments, and a substring match on the package nickname would report the
// explanation as the defect.

/**
 * One banned shape: what to call it, how to recognise it, and every line that is one.
 *
 * The name is interpolated into both case titles, so a regression reports WHICH shape
 * matched instead of a bare `expected true to be false` that forces a bisect across four
 * regexes. The samples are the negative control's whole subject — one per alternation
 * branch, per the header, so the list is a CENSUS of what its pattern admits rather than
 * an illustration of it.
 */
export type BannedDirectImportPattern = readonly [
  patternName: string,
  pattern: RegExp,
  violatingImportSamples: readonly string[],
];

/** One pattern beside ONE of its foils — the shape of a single negative-control case. */
export interface BannedDirectImportFoil {
  readonly patternName: string;
  readonly pattern: RegExp;
  readonly violatingImportSample: string;
}

/** `from "@ai-sidekicks/<pkg>"` and any subpath of it. */
const BANNED_BARE_IMPORT =
  /from\s*["'`]@ai-sidekicks\/(?:runtime-daemon|control-plane)(?:\/[^"'`]*)?["'`]/;

/** `from "…/packages/<pkg>/…"`, exact or subpath. */
const BANNED_RELATIVE_IMPORT = /from\s*["'`][^"'`]*packages\/(?:runtime-daemon|control-plane)\//;

/**
 * A `from`-less side-effect import, in either spelling.
 *
 * A REAL gap for `control-plane`, which — unlike `runtime-daemon`'s native bindings —
 * pulls nothing that would crash on a bare side-effect import, so nothing but this
 * pattern would report one.
 */
const BANNED_SIDE_EFFECT_IMPORT =
  /import\s*["'`](?:@ai-sidekicks\/(?:runtime-daemon|control-plane)(?:\/[^"'`]*)?|[^"'`]*packages\/(?:runtime-daemon|control-plane)\/[^"'`]*)["'`]/;

/** `import("@ai-sidekicks/<pkg>")`, or its relative form. */
const BANNED_DYNAMIC_IMPORT =
  /import\s*\(\s*["'`](?:@ai-sidekicks\/(?:runtime-daemon|control-plane)(?:\/[^"'`]*)?|[^"'`]*packages\/(?:runtime-daemon|control-plane)\/[^"'`]*)["'`]/;

/**
 * Every shape a renderer view's source text is read against, with its foils.
 *
 * The four cover the bare specifier and its subpaths, the relative reach into
 * `packages/`, the `from`-less side effect, and the dynamic call — where `<pkg>` is
 * `runtime-daemon | control-plane`. The subpath group on the bare form is what closes
 * the evasion a trailing-quote-only anchor left open, and the sample carrying a subpath
 * is what stops that group from being deleted again.
 *
 * The comment above each sample list names the axes it covers, in the order the samples
 * appear, so a branch added to a pattern is visibly a branch with no foil.
 */
export const BANNED_DIRECT_IMPORT_PATTERNS: readonly BannedDirectImportPattern[] = [
  [
    "bannedBareImport",
    BANNED_BARE_IMPORT,
    // Quote " ' `; package runtime-daemon / control-plane; subpath absent / present.
    [
      'import { Daemon } from "@ai-sidekicks/runtime-daemon";',
      "import { createRouter } from '@ai-sidekicks/control-plane';",
      "import { internalDriver } from `@ai-sidekicks/runtime-daemon/internal`;",
      'import { sessionRouter } from "@ai-sidekicks/control-plane/router";',
    ],
  ],
  [
    "bannedRelativeImport",
    BANNED_RELATIVE_IMPORT,
    // Quote " ' `; package control-plane / runtime-daemon. The pattern has no closing
    // quote and no optional subpath: the trailing `/` after the package is mandatory.
    [
      'import { Router } from "../../../../packages/control-plane/src/router.js";',
      "import { Daemon } from '../../../packages/runtime-daemon/src/index.js';",
      "import { schema } from `../../packages/control-plane/src/schema.js`;",
    ],
  ],
  [
    "bannedSideEffectImport",
    BANNED_SIDE_EFFECT_IMPORT,
    // Bare arm: quote " ', package runtime-daemon / control-plane, subpath absent /
    // present. Relative arm: quote " `, package control-plane / runtime-daemon.
    [
      'import "@ai-sidekicks/runtime-daemon";',
      "import '@ai-sidekicks/control-plane/register';",
      'import "../../../../packages/control-plane/src/register.js";',
      "import `../../packages/runtime-daemon/src/preload.js`;",
    ],
  ],
  [
    "bannedDynamicImport",
    BANNED_DYNAMIC_IMPORT,
    // Bare arm: quote " ', package runtime-daemon / control-plane, subpath absent /
    // present. Relative arm: quote ` ", package control-plane / runtime-daemon.
    [
      'const daemon = await import("@ai-sidekicks/runtime-daemon");',
      "const registry = await import('@ai-sidekicks/control-plane/registry');",
      "const router = await import(`../../../../packages/control-plane/src/router.js`);",
      'const daemonModule = await import("../../packages/runtime-daemon/src/index.js");',
    ],
  ],
];

/**
 * Every (pattern, foil) pair, flattened, so exactly one case exists per sample.
 *
 * DERIVED AND NOT WRITTEN OUT, so a sample added to the table above cannot arrive
 * without a case driving it — which is the property the single-sample version lacked in
 * the other direction. Flattened rather than looped inside one case per pattern because
 * a loop of `expect` calls stops at the first sample that fails and reports nothing
 * about the rest, and WHICH branch went missing is the whole of the finding.
 *
 * Consumed through vitest's `$key` title form, so a failure names the pattern and prints
 * the exact line that stopped matching.
 */
export const BANNED_DIRECT_IMPORT_FOILS: readonly BannedDirectImportFoil[] =
  BANNED_DIRECT_IMPORT_PATTERNS.flatMap(([patternName, pattern, violatingImportSamples]) =>
    violatingImportSamples.map((violatingImportSample) => ({
      patternName,
      pattern,
      violatingImportSample,
    })),
  );
