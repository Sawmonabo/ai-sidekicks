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
// EACH PATTERN CARRIES A SYNTHETIC VIOLATION, and that is what makes a clean result mean
// anything: four patterns that matched nothing and four patterns that CANNOT match are
// the same green. The negative control in each consuming suite drives every pattern
// against its own violation, so deleting an alternation — the `packages/…` arm of
// `BANNED_SIDE_EFFECT_IMPORT`, say — turns a case red instead of quietly widening the
// hole the tripwire is here to close.
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
 * One banned shape: what to call it, how to recognise it, and a line that is one.
 *
 * The name is interpolated into both case titles, so a regression reports WHICH shape
 * matched instead of a bare `expected true to be false` that forces a bisect across four
 * regexes. The sample is the negative control's whole subject.
 */
export type BannedDirectImportPattern = readonly [
  patternName: string,
  pattern: RegExp,
  violatingImportSample: string,
];

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
 * Every shape a renderer view's source text is read against, with its own foil.
 *
 * The four cover the bare specifier and its subpaths, the relative reach into
 * `packages/`, the `from`-less side effect, and the dynamic call — where `<pkg>` is
 * `runtime-daemon | control-plane`. The subpath group on the bare form is what closes
 * the evasion a trailing-quote-only anchor left open.
 */
export const BANNED_DIRECT_IMPORT_PATTERNS: readonly BannedDirectImportPattern[] = [
  [
    "bannedBareImport",
    BANNED_BARE_IMPORT,
    'import { Daemon } from "@ai-sidekicks/runtime-daemon";',
  ],
  [
    "bannedRelativeImport",
    BANNED_RELATIVE_IMPORT,
    'import { Router } from "../../../../packages/control-plane/src/router.js";',
  ],
  [
    "bannedSideEffectImport",
    BANNED_SIDE_EFFECT_IMPORT,
    'import "../../../../packages/control-plane/src/register.js";',
  ],
  [
    "bannedDynamicImport",
    BANNED_DYNAMIC_IMPORT,
    'const daemon = await import("@ai-sidekicks/runtime-daemon");',
  ],
];
