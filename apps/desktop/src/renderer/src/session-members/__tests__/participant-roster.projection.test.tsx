// Plan-002 CP-002-5 — the ParticipantRoster view reaches the daemon only through the
// bridge, read out of its own source text.
//
// A DIFFERENT KIND OF CLAIM from the cases next door, and that is why it is its own
// program. `participant-roster.test.tsx` renders the component and asserts what a
// participant sees; this asserts something about the module's TEXT, needs no DOM, and
// carries the ambient `ImportMeta` augmentation the raw read depends on — which is
// module-scoped, so keeping it here is what stops it leaking into a suite that renders.
// The split came when the single file passed the package's ceiling; the fixtures and the
// mock bridge live in `participant-roster.test-support.ts` and neither is needed here.
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
  // THIS IS THE SOLE OPERATIONAL ENFORCEMENT of the daemon/control-plane import
  // ban for renderer source: `apps/desktop/eslint.config.mjs` bans `electron` /
  // `node:*` / `main`/`preload` escapes, but the `@ai-sidekicks/runtime-daemon`
  // / `@ai-sidekicks/control-plane` ban is deferred to the Plan-023 Tier 8
  // remainder (those would be inert today). Until that lands, this regex tripwire
  // is the only thing that turns CI red on a direct import — so it must catch
  // EVERY realistic direct-import shape, not just the bare-exact form.
  //
  // The four regexes below cover (identical set to invite-accept-view.test.tsx):
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
  // `[patternName, pattern]` tuples drive the `it.each` below. Naming each
  // pattern means a future regression reports WHICH shape matched (the case
  // title interpolates the name) instead of a bare `expected true to be false`
  // that forces a manual bisect across the four regexes.
  const bannedDirectImportPatterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["bannedBareImport", bannedBareImport],
    ["bannedRelativeImport", bannedRelativeImport],
    ["bannedSideEffectImport", bannedSideEffectImport],
    ["bannedDynamicImport", bannedDynamicImport],
  ];

  // Glob-key-drift guard, hoisted to run ONCE before the `it.each`: if the
  // `import.meta.glob` key ever drifts, this throws loudly here rather than
  // letting every case vacuously pass against an `undefined` source. After the
  // narrowing throw, `participantRosterSource` is `string` for all cases below.
  const participantRosterSource = rendererViewSources["../participant-roster.tsx"];
  if (typeof participantRosterSource !== "string") {
    throw new Error("participant-roster.tsx source was not loaded by import.meta.glob");
  }

  it.each(bannedDirectImportPatterns)(
    "participant-roster.tsx source matches no %s direct daemon/control-plane import",
    (_bannedImportPatternName, bannedImportPattern) => {
      expect(bannedImportPattern.test(participantRosterSource)).toBe(false);
    },
  );
});
