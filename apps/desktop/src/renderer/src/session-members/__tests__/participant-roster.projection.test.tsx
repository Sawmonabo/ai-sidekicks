// Plan-002 CP-002-5 — the ParticipantRoster view reaches the daemon only through the
// bridge, read out of its own source text.
//
// A DIFFERENT KIND OF CLAIM from the cases next door, and that is why it is its own
// program — the seam, not a line count. `participant-roster.test.tsx` renders the
// component and asserts what a participant sees, `participant-roster.failures.test.tsx`
// asserts how a refused read reaches them, and this asserts something about the module's
// TEXT: it needs no DOM, mounts nothing, and carries the ambient `ImportMeta`
// augmentation the raw read depends on — which is module-scoped, so keeping it here is
// what stops it leaking into a suite that renders. The fixtures and the mock bridge are
// a fourth job and live in `participant-roster.test-support.ts`; neither is needed here.
//
// Vitest 4 `globals: true` (renderer project) supplies `describe`/`it`/`expect`; the
// renderer test tsconfig adds `vitest/globals` to `types`.

// --------------------------------------------------------------------------
// CP-002-5 source-text read — Vite `import.meta.glob` raw form.
// --------------------------------------------------------------------------
//
// See invite-accept-view.test.tsx for the full rationale. In short: the
// bridge-projection assertion needs the view's source TEXT; Vite's
// `import.meta.glob(..., { query: "?raw" })` inlines it as a string at transform
// time with NO module import, which is the only lint-clean / typecheck-clean
// option here (`node:fs` is doubly banned — by the renderer
// `no-restricted-imports` rule and by the renderer test typegraph's `types: []`
// posture). The local `ImportMeta` augmentation declares the single signature we
// use; it is scoped to this test program and does not leak into the production
// renderer typecheck.
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ) => Record<string, string>;
  }
}

const rendererViewSources = import.meta.glob("../participant-roster.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});
describe("ParticipantRoster — bridge projection", () => {
  // Spec-023 §Trust Stance + Plan-002 CP-002-5 operational enforcement. The
  // renderer is the UNTRUSTED surface: it must reach the daemon / control-plane
  // ONLY through the `window.sidekicks` preload bridge, NEVER by importing the
  // node-side packages directly. This assertion reads the view's own source
  // text (via the Vite `import.meta.glob` raw form declared inline above — a
  // lint-clean / typecheck-clean alternative to `node:fs`, which is doubly
  // banned in renderer source: by `no-restricted-imports` AND by the renderer
  // test typegraph's `types: []`/no-`@types/node` posture) and asserts no
  // import statement targets the banned packages.
  //
  // THIS IS NOT THE ENFORCEMENT, AND IT NEVER FIRES FIRST. The claim this file
  // used to carry — that the workspace-package ban is deferred and this tripwire
  // is all there is — is false: `apps/desktop/eslint.config.mjs` bans
  // `@ai-sidekicks/runtime-daemon` and `@ai-sidekicks/control-plane` at `error`
  // for renderer source today, beside `electron` / `node:*` / the `main`/`preload`
  // escapes, and the package's own `lint` script runs that config over `src/` in
  // CI ahead of this suite. That ban is also TRANSITIVE where this read cannot be:
  // a view refactored to reach the package through a local renderer helper passes
  // every source-text scan, and the helper's own import is what ESLint fails on.
  // `runtime-node-attach/__tests__/renderer-import-boundary.test.ts` drives that
  // real rule through the ESLint API with positive controls.
  //
  // WHAT THIS FILE ADDS is one module's DIRECT-import surface, read as text and
  // asserted per shape — a second, narrower reading that names which shape matched
  // when it fires. Being narrower is the reason it must still catch every
  // realistic direct-import form rather than the bare-exact one.
  //
  // The four regexes below cover (the same shapes as invite-accept-view.test.tsx,
  // which carries its own copy of this table and no negative control):
  //   1. `bannedBareImport` — `from "@ai-sidekicks/<pkg>"` AND any subpath
  //      (`from "@ai-sidekicks/<pkg>/internal"`) — the optional `(?:/…)?` group
  //      is what closes the subpath-evasion gap a trailing-quote-only anchor left.
  //   2. `bannedRelativeImport` — `from "…/packages/<pkg>/…"` (exact or subpath).
  //   3. `bannedSideEffectImport` — a `from`-less side-effect import
  //      (`import "@ai-sidekicks/<pkg>"` or its relative form). A REAL gap for
  //      control-plane, which (unlike runtime-daemon's native bindings) pulls
  //      nothing that would crash on a bare side-effect import.
  //   4. `bannedDynamicImport` — `import("@ai-sidekicks/<pkg>")` (or relative).
  // where `<pkg>` is `runtime-daemon | control-plane`.
  //
  // All four anchor on the IMPORT SURFACE (`from "…"` / `import "…"` /
  // `import("…")`), NOT bare words: participant-roster.tsx mentions "the local
  // daemon" / "daemon → client" in PROSE comments, which a naive substring on
  // the package nickname would false-positive. The set is verified empirically
  // in the implementer's report: all violation shapes match; allowed imports
  // (`react`, `@testing-library/react`, type-only `@ai-sidekicks/contracts`) and
  // prose do not.
  const bannedBareImport =
    /from\s*["'`]@ai-sidekicks\/(?:runtime-daemon|control-plane)(?:\/[^"'`]*)?["'`]/;
  const bannedRelativeImport = /from\s*["'`][^"'`]*packages\/(?:runtime-daemon|control-plane)\//;
  const bannedSideEffectImport =
    /import\s*["'`](?:@ai-sidekicks\/(?:runtime-daemon|control-plane)(?:\/[^"'`]*)?|[^"'`]*packages\/(?:runtime-daemon|control-plane)\/[^"'`]*)["'`]/;
  const bannedDynamicImport =
    /import\s*\(\s*["'`](?:@ai-sidekicks\/(?:runtime-daemon|control-plane)(?:\/[^"'`]*)?|[^"'`]*packages\/(?:runtime-daemon|control-plane)\/[^"'`]*)["'`]/;
  // `[patternName, pattern, violatingImportSample]` tuples drive both `it.each`
  // blocks below. Naming each pattern means a future regression reports WHICH
  // shape matched (the case title interpolates the name) instead of a bare
  // `expected true to be false` that forces a manual bisect across the four
  // regexes — and carrying a synthetic VIOLATION beside each one is what makes
  // the clean result mean something: four patterns that matched nothing and four
  // patterns that cannot match are the same green. This is the shape the deleted
  // `runtime-node-attach` view suites carried, and it caught exactly the class it
  // is here for: without it, deleting the `packages/…` alternation from
  // `bannedSideEffectImport` leaves every case in this file passing.
  const bannedDirectImportPatterns: ReadonlyArray<readonly [string, RegExp, string]> = [
    [
      "bannedBareImport",
      bannedBareImport,
      'import { Daemon } from "@ai-sidekicks/runtime-daemon";',
    ],
    [
      "bannedRelativeImport",
      bannedRelativeImport,
      'import { Router } from "../../../../packages/control-plane/src/router.js";',
    ],
    [
      "bannedSideEffectImport",
      bannedSideEffectImport,
      'import "../../../../packages/control-plane/src/register.js";',
    ],
    [
      "bannedDynamicImport",
      bannedDynamicImport,
      'const daemon = await import("@ai-sidekicks/runtime-daemon");',
    ],
  ];

  // Glob-key-drift guard, hoisted to run ONCE before the `it.each`: if the
  // `import.meta.glob` key ever drifts, this throws loudly here rather than
  // letting every case vacuously pass against an `undefined` source. After the
  // narrowing throw, `participantRosterSource` is `string` for all cases below.
  const participantRosterSource = rendererViewSources["../participant-roster.tsx"];
  if (typeof participantRosterSource !== "string") {
    throw new Error("participant-roster.tsx source was not loaded by import.meta.glob");
  }

  // Negative control: a tripwire that has never fired positive proves nothing.
  it.each(bannedDirectImportPatterns)(
    "%s matches a synthetic violating import (negative control)",
    (_bannedImportPatternName, bannedImportPattern, violatingImportSample) => {
      expect(bannedImportPattern.test(violatingImportSample)).toBe(true);
    },
  );

  it.each(bannedDirectImportPatterns)(
    "participant-roster.tsx source matches no %s direct daemon/control-plane import",
    (_bannedImportPatternName, bannedImportPattern) => {
      expect(bannedImportPattern.test(participantRosterSource)).toBe(false);
    },
  );
});
