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

import {
  BANNED_DIRECT_IMPORT_FOILS,
  BANNED_DIRECT_IMPORT_PATTERNS,
} from "./renderer-import-ban.test-support.js";

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
  // THIS IS NOT THE ENFORCEMENT, AND IT NEVER FIRES FIRST. The claim this file used to
  // carry — that the workspace-package ban is deferred to a Tier-8 remainder and this
  // tripwire is all there is — is false: `apps/desktop/eslint.config.mjs` bans
  // `@ai-sidekicks/runtime-daemon` and `@ai-sidekicks/control-plane`, and their
  // subpaths, at `error` for renderer source today, beside the `electron` / `node:*` /
  // `main` / `preload` escapes, and the package's `lint` script runs that config over
  // `src/` in CI ahead of this suite. That ban is also TRANSITIVE where this read cannot
  // be: a view refactored to reach the package through a local renderer helper passes
  // every source-text scan, and the helper's own import is what ESLint fails on. What
  // this file ADDS is one module's DIRECT-import surface, read as text and reported per
  // shape — narrower, which is why it still has to catch every realistic form.
  //
  // THE SHAPES COME FROM ONE HOME. `BANNED_DIRECT_IMPORT_PATTERNS` in
  // `renderer-import-ban.test-support.ts` holds the four regexes and their names, and
  // `BANNED_DIRECT_IMPORT_FOILS` flattens them against one synthetic violation per
  // BRANCH each admits. Both this suite and `invite-accept-view.test.tsx` carried a
  // private copy of that set and neither carried a foil, which is two ways for the same
  // tripwire to go quietly wide; that module's header says which shapes they are, which
  // axes the foils cover, and why each is anchored on the import surface rather than on
  // the package nickname — participant-roster.tsx mentions "the local daemon" and
  // "daemon → client" in prose, and a substring match would report the explanation as
  // the defect.

  // Glob-key-drift guard, hoisted to run ONCE before the `it.each`: if the
  // `import.meta.glob` key ever drifts, this throws loudly here rather than
  // letting every case vacuously pass against an `undefined` source. After the
  // narrowing throw, `participantRosterSource` is `string` for all cases below.
  const participantRosterSource = rendererViewSources["../participant-roster.tsx"];
  if (typeof participantRosterSource !== "string") {
    throw new Error("participant-roster.tsx source was not loaded by import.meta.glob");
  }

  // Negative control: four patterns that matched nothing and four patterns that CANNOT
  // match are the same green, so each is driven against every line that is a violation
  // of it. ONE case per foil rather than per pattern, because a pattern still matches a
  // single sample after an alternation is deleted — that is exactly how deleting the
  // `packages/…` arm from `bannedSideEffectImport`, or the subpath group from
  // `bannedBareImport`, left every case here passing.
  it.each(BANNED_DIRECT_IMPORT_FOILS)(
    "$patternName matches its foil $violatingImportSample (negative control)",
    ({ pattern, violatingImportSample }) => {
      expect(pattern.test(violatingImportSample)).toBe(true);
    },
  );

  it.each(BANNED_DIRECT_IMPORT_PATTERNS)(
    "participant-roster.tsx source matches no %s direct daemon/control-plane import",
    (_bannedImportPatternName, bannedImportPattern) => {
      expect(bannedImportPattern.test(participantRosterSource)).toBe(false);
    },
  );
});
