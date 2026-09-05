// Plan-003 CP-003-3 renderer-boundary enforcement — BL-131 exit criterion (b),
// the transitive half.
//
// WHY THIS FILE EXISTS (PR #355 Codex round 1). The four Plan-003 view suites
// each scan their own component's source text for banned imports. That scan is
// real but structurally shallow: it sees only DIRECT imports. Refactor a view
// to call a local helper —
//
//     MixedVersionStatus.tsx → ./runtime-node-data.js → @ai-sidekicks/control-plane
//
// — and every per-component scan still passes while the renderer has in fact
// reached the control-plane package. The boundary needs an enforcement that
// traverses files rather than one string, which is what ESLint's
// `no-restricted-imports` over `src/renderer/src/**` gives: the helper is a
// renderer file too, so ITS import is what fails.
//
// This file drives the REAL rule from `apps/desktop/eslint.config.mjs` through
// the ESLint API. It deliberately does not re-implement the ban — a test that
// re-encoded the pattern list would pass even if the config were deleted, which
// is precisely the failure mode it is here to prevent. The config is loaded
// from disk by `ESLint` itself.
//
// What this suite asserts is the rule's TEETH, on synthetic sources, per the
// `router-no-sql.test.ts` precedent (`packages/control-plane/src/sessions/__tests__/`):
// without a positive control a green suite is ambiguous between "the rule has
// teeth" and "the rule silently matched nothing".
//
// WHAT IT DELIBERATELY DOES NOT ASSERT, AND WHO DOES. Whether the LIVE renderer
// tree is clean is owned by this package's own `lint` script — `eslint build
// scripts src test`, which runs this same flat config at `error` over `src/`, a
// superset of the renderer sub-tree, in the required `test-node22` job's
// "Lint per-package" step. That step runs BEFORE the step that runs this file, so
// a violation turns it red first and a case here could never be the run that
// caught one: it was a strict re-run of a gate that had already fired.
//
// The re-run was not free. Under the advisory `coverage (informational)` job —
// where `@vitest/coverage-v8` instruments the TypeScript parser and every rule
// visitor while turbo runs five packages' suites on a 2-vCPU runner — linting the
// 302-file renderer tree took 34 294 ms against this file's 30 000 ms budget and
// rendered that job red on every pull request (GitHub Actions runs 33703788077,
// 33707808528, 33914273796). The same file costs 1 654 ms in the ordinary
// uninstrumented test step, and it contributes nothing to the measurement it was
// costing: it executes no renderer module, it reads them through ESLint. Measured
// locally, the instrumentation alone is 2.5x — 1 287 ms uninstrumented against
// 3 255 ms instrumented, best of three alternating passes.
//
// This suite runs in the `renderer` project (happy-dom) but is a pure Node
// program: it lints files rather than rendering components, so it imports no
// React. `node:*` is banned in renderer PRODUCTION source by the very rule
// under test. Writing this file surfaced that the ban's `files` selector also
// covered `__tests__/**`, which is wrong for the reason `packages/contracts`'
// isomorphism block already documents: the ban keeps Node capability out of
// the renderer BUNDLE, and tests are never bundled. The config now excludes
// `__tests__/**` from the builtin ban and re-applies the CP-003-3 workspace-
// package half to tests in a second block — so this file may import
// `node:path`, but no renderer test may import the daemon or control-plane
// package. That asymmetry is itself covered by a case below — as is the
// flat-config resolution rule that forces the second block to RESTATE the
// CP-003-3 entries instead of inheriting them.
//
// Refs: docs/plans/003-runtime-node-attach.md §Cross-Plan Obligations CP-003-3,
//       docs/specs/023-desktop-shell-and-renderer.md §Trust Stance.
import { ESLint } from "eslint";

// Paths are derived from `import.meta.url` rather than `node:path`, on purpose.
// This program is typechecked by `src/renderer/tsconfig.test.json`, whose
// `types` is `["vitest/globals"]` ALONE — deliberately, so the renderer's
// typegraph stays hermetic. Importing `node:path` (or reading
// `import.meta.dirname`) would force `@types/node` into that config and hand
// every renderer test file the Node surface, which is a bigger loosening than
// this one path computation is worth. `URL` is web-standard and already in the
// lib. (The imports resolve at RUNTIME either way — vitest runs happy-dom
// inside Node — so this is purely about what the typegraph admits.)
function packageRelativePath(relativeToThisFile: string): string {
  const { pathname } = new URL(relativeToThisFile, import.meta.url);
  // A Windows file URL yields `/C:/…`; strip the leading slash before the
  // drive letter so ESLint receives a native absolute path. No-op on POSIX.
  return decodeURIComponent(pathname).replace(/^\/(?=[A-Za-z]:)/, "");
}

// __tests__/ → runtime-node-attach/ → src/ → renderer/ → src/ → desktop/
const DESKTOP_PACKAGE_ROOT = packageRelativePath("../../../../../");

// A renderer file path that the config's `files` selector matches. The lint
// result depends on the path (that is the point — the ban is path-scoped), so
// the synthetic sources below are linted AS this file.
const SYNTHETIC_RENDERER_PATH = packageRelativePath("../../__synthetic__/boundary-probe.ts");

function createLinter(): ESLint {
  // `cwd` anchors flat-config discovery on the desktop package, so the config
  // under test (`apps/desktop/eslint.config.mjs`, which itself spreads the repo
  // root config) is the one that runs.
  return new ESLint({ cwd: DESKTOP_PACKAGE_ROOT });
}

function restrictedImportMessages(results: readonly ESLint.LintResult[]): string[] {
  return results
    .flatMap((result) => result.messages)
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map((message) => message.message);
}

/**
 * The per-case budget this file installs for all ten of its cases.
 *
 * Sized to the MACHINE, not to the work. Every case here drives the REAL ESLint
 * engine over the REAL flat config, and whichever case runs FIRST additionally
 * pays that config's entire module graph: `apps/desktop/eslint.config.mjs`
 * spreads the repo-root config, which imports `typescript-eslint`, which pulls
 * in `typescript`. Node caches ESM by URL, so exactly one case pays it and every
 * sibling then lints in single-digit milliseconds. Measured directly, outside
 * vitest: importing that config graph costs 385ms; a fresh `ESLint` instance's
 * first `lintText` costs 376ms and its second costs 9ms.
 *
 * That lopsided first case is the whole exposure, and it is the only one left:
 * under a full-workspace `pnpm test` this file's first case died with a bare
 * "Test timed out in 5000ms" while the other ten passed, and on the coverage
 * runner it still costs 3911ms while every sibling costs 15-75ms. The budget is
 * file-scoped rather than aimed at that one case because which case runs first
 * is an ordering detail, not a property worth encoding: whichever it is pays the
 * graph. Hoisting the warm-up into a shared hook would move the same exposure
 * onto `hookTimeout`, whose default is 10s — a TIGHTER budget than this one — in
 * exchange for no pass/fail difference at all.
 *
 * Reproduced deliberately with CPU burners on an 8-core host: the first case ran
 * 414ms alone and 7304ms at 2x oversubscription over a cold module graph
 * (17.6x), which is the run that timed out. Notably it ran only 2.3s at 4x
 * oversubscription once that graph was warm in the page cache — so the worst
 * case is COLD-PLUS-CONTENDED rather than merely contended, which is exactly the
 * shape of a full `pnpm test`: every package's vitest pool forking at once, over
 * a module graph nothing has read yet.
 *
 * 30s is therefore ~4x the worst per-case figure measured (7304ms), so the
 * budget holds even if this file's entire real-world cost landed inside a single
 * case. It is unchanged by the removal of the whole-tree case above: that case
 * never sized this number — the cold-plus-contended warm-up did, and it is still
 * here. Deliberately not the 15000ms that `packages/control-plane` and
 * `packages/client-sdk` set package-wide: that is barely 2x the worst figure
 * measured here, and those two are buying a floor for every suite they own
 * rather than a ceiling for one. The headroom above it costs nothing. Unlike
 * `packages/runtime-daemon/src/git/__tests__/turn-snapshot-service.test.ts`,
 * whose budget is sized above a 30s INNER subprocess deadline so a hung spawn
 * fails naming its own leg, nothing inside `lintText` has a deadline for this
 * one to sit above — and no failure this suite exists to catch is a hang.
 * Delete or weaken the rule under test and these cases ASSERT: instantly, and
 * just as loudly at 30s as at 5s. The only thing the timeout itself catches is
 * a genuinely wedged lint, which a CI job timeout catches as well.
 *
 * Installed file-scoped rather than in `vitest.config.ts`, and that boundary is
 * the point: the renderer project's other seven suites render React components
 * and pay none of this, so re-budgeting them on this file's evidence would buy
 * silence rather than confidence. Exactly two suites in the workspace drive
 * ESLint programmatically — this one and the `router-no-sql.test.ts` precedent
 * named in the header, which pays the same warm-up but sits under its own
 * package's 15000ms budget and so never surfaced it. `apps/desktop` declares no
 * `testTimeout` at all, which is why the exposure landed here first.
 */
const ESLINT_CASE_TIMEOUT_MS = 30_000;

vi.setConfig({ testTimeout: ESLINT_CASE_TIMEOUT_MS });

// Enforces the Plan-003 CP-003-3 renderer import boundary.
describe("renderer import boundary", () => {
  describe("the rule has teeth (positive controls)", () => {
    // Each case is a shape the per-component source scan would MISS or that a
    // partial ban would let through: bare package, subpath, type-only import,
    // dynamic import, and the transitive-helper shape that motivated the rule.
    const violatingSources: readonly (readonly [string, string])[] = [
      [
        "bare daemon package",
        `import { x } from "@ai-sidekicks/runtime-daemon";\nexport const a = x;\n`,
      ],
      [
        "bare control-plane package",
        `import { x } from "@ai-sidekicks/control-plane";\nexport const a = x;\n`,
      ],
      [
        "daemon subpath",
        `import { x } from "@ai-sidekicks/runtime-daemon/projector";\nexport const a = x;\n`,
      ],
      [
        "control-plane subpath",
        `import { x } from "@ai-sidekicks/control-plane/sessions/session-router.js";\nexport const a = x;\n`,
      ],
      [
        "type-only control-plane import",
        `import type { X } from "@ai-sidekicks/control-plane";\nexport type A = X;\n`,
      ],
    ];

    it.each(violatingSources)("reports %s", async (_label, source) => {
      const results = await createLinter().lintText(source, {
        filePath: SYNTHETIC_RENDERER_PATH,
      });
      const messages = restrictedImportMessages(results);
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.join("\n")).toContain("CP-003-3");
    });

    it("reports the helper-hop shape the per-component scans cannot see", async () => {
      // The motivating case: this file is NOT a view component, so no view's
      // source scan would ever read it. The path-scoped lint rule still fires
      // because the helper lives in the renderer tree.
      const helperSource = [
        `import { queryRoster } from "@ai-sidekicks/control-plane";`,
        `export function loadRoster(): unknown {`,
        `  return queryRoster();`,
        `}`,
        ``,
      ].join("\n");
      const results = await createLinter().lintText(helperSource, {
        filePath: packageRelativePath("../helper.ts"),
      });
      expect(restrictedImportMessages(results).length).toBeGreaterThan(0);
    });

    it("leaves a NON-renderer path alone (the ban is path-scoped, not global)", async () => {
      // The main process legitimately imports these packages. If this started
      // failing, the `files` selector had been widened past the renderer and
      // the rule would be wrong in the other direction.
      const results = await createLinter().lintText(
        `import { x } from "@ai-sidekicks/control-plane";\nexport const a = x;\n`,
        { filePath: packageRelativePath("../../../../main/boundary-probe.ts") },
      );
      expect(restrictedImportMessages(results)).toHaveLength(0);
    });
  });

  // Plan-003 CP-003-3 package ban.
  it("keeps the package ban on renderer TEST files too", async () => {
    // The builtin ban is lifted for `__tests__/**` (tests are not bundled), but
    // the cross-plan package boundary is not — otherwise the exclusion would
    // hand test files a hole in the boundary this very suite enforces.
    const results = await createLinter().lintText(
      `import { x } from "@ai-sidekicks/control-plane";\nexport const a = x;\n`,
      {
        filePath: packageRelativePath("./probe.test.ts"),
      },
    );
    expect(restrictedImportMessages(results).length).toBeGreaterThan(0);
  });

  it("still allows node: builtins in renderer TEST files", async () => {
    // The other half of the same asymmetry — asserted so a future tightening
    // that re-bans builtins in tests fails HERE, naming the tradeoff, rather
    // than breaking this suite's own import with an opaque lint error.
    const results = await createLinter().lintText(
      `import { resolve } from "node:path";\nexport const a = resolve(".");\n`,
      {
        filePath: packageRelativePath("./probe.test.ts"),
      },
    );
    expect(restrictedImportMessages(results)).toHaveLength(0);
  });

  it("a later config object's rule options replace, never merge", async () => {
    // The config's two `no-restricted-imports` blocks are each self-contained
    // because a later flat-config object that supplies rule OPTIONS replaces the
    // earlier options wholesale — no deep merge, no union of `paths` — no matter
    // how narrow its `files` selector is. That is load-bearing: it is the reason
    // the `__tests__/**` block restates the CP-003-3 entries rather than relying
    // on the block above, and the config's header comment now says so.
    //
    // One file class in the shipped config IS matched by two
    // `no-restricted-imports` objects — console and shell source, which the
    // console block re-states the renderer ban for by SPREADING the two hoisted
    // arrays, and whose spread `daemon-reply-chokepoint.test.ts` asserts is still
    // there. No file is matched by two blocks that DISAGREE, though, so the
    // semantics stay unobservable from the config alone. This case makes them
    // observable by appending one STRICTLY NARROWER block through
    // `overrideConfig` (ESLint appends it to the end of the config array) and
    // watching the shipped ban disappear. Under merge semantics both bans would
    // fire; under replace semantics only the appended one does.
    const linter = new ESLint({
      cwd: DESKTOP_PACKAGE_ROOT,
      overrideConfig: {
        // Strictly narrower than the shipped block's
        // `src/renderer/src/**/__tests__/**/*.{ts,tsx}`.
        files: ["src/renderer/src/**/__tests__/**/replace-semantics-probe.test.ts"],
        rules: {
          "no-restricted-imports": [
            "error",
            { paths: [{ name: "sentinel-package", message: "SENTINEL" }] },
          ],
        },
      },
    });
    const results = await linter.lintText(
      [
        `import "sentinel-package";`,
        `import { x } from "@ai-sidekicks/control-plane";`,
        `export const a = x;`,
        ``,
      ].join("\n"),
      { filePath: packageRelativePath("./replace-semantics-probe.test.ts") },
    );
    const messages = restrictedImportMessages(results).join("\n");
    // Both halves are load-bearing: without the first the case passes vacuously
    // when the appended block fails to match; without the second it says nothing
    // about merge-vs-replace.
    expect(messages).toContain("SENTINEL");
    expect(messages).not.toContain("CP-003-3");
  });
});
