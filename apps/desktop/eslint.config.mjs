// Package-scoped ESLint flat-config for `@ai-sidekicks/desktop`
// — Plan-023 Phase 1 (T-023p-1-6).
//
// Purpose: enforce the renderer-untrusted boundary at the import surface per
// Spec-023 §Trust Stance. The renderer process is the untrusted surface;
// every Node / Electron / main-process / preload-process capability MUST
// reach the renderer ONLY via the `window.sidekicks` bridge declared by
// `apps/desktop/src/preload/index.ts`. This config makes that boundary
// structurally unbypassable: any direct import of Node/Electron APIs (or any
// relative-path escape into `src/main/**` or `src/preload/**`) from renderer
// source fails `pnpm --filter @ai-sidekicks/desktop lint`. A reviewer or
// future contributor cannot silently introduce such an import without CI
// turning red.
//
// The ban applies ONLY to `src/renderer/src/**/*.{ts,tsx}` — the main and
// preload processes legitimately depend on `electron`, `node:*`, and friends,
// and must remain free to import them. Scope is narrowed by the `files`
// selector on the override block below.
//
// Tier-1 ban list (this task): `electron`, the `node:*` protocol family,
// the bare-specifier Node built-ins (`fs`, `child_process`, `net`, `os`,
// `path`, `process`), and relative-path escapes into `**/main/**` /
// `**/preload/**`. The full extended ban list (`keytar`, `@napi-rs/keyring`,
// `@sentry/electron`) lands at Plan-023 Tier 8 remainder — those modules do
// not yet exist in the workspace, so banning them now would be inert.
//
// BL-131 addition (2026-08-25, PR #355 Codex round 1): the two server-side
// workspace packages, `@ai-sidekicks/runtime-daemon` and
// `@ai-sidekicks/control-plane`. `Plan-003 §Cross-Plan Obligations` CP-003-3
// requires the renderer to reach both ONLY through the bridge, but nothing
// enforced it — the Plan-003 renderer suites scanned each component's own
// source text, which cannot see a violation reached through a local helper
// (component → `./helper.js` → `@ai-sidekicks/control-plane` scans clean).
// Lint traverses every renderer file, so it catches the transitive shape the
// per-component scan structurally cannot. Both packages exist in the
// workspace today, so unlike the Tier-8 list above this ban is live, not
// inert. It is asserted against the REAL rule — not a reimplementation — by
// `src/renderer/src/runtime-node-attach/__tests__/renderer-import-boundary.test.ts`.
//
// This config spreads the repo-root `eslint.config.mjs` first, so this package
// inherits its `@eslint/js` recommended baseline, `typescript-eslint`
// recommended, the repo-wide `ignores`, and the shared `languageOptions`. It
// inherits NO `no-restricted-imports`: the root's two blocks are path-scoped to
// files under `packages/control-plane/src/sessions/` and `packages/contracts/src/`,
// so neither selector matches a file in this app (verified against the resolved
// config — for a renderer file the root's `pg` entry and its Buffer
// `no-restricted-globals` entry are both absent). Every import restriction that
// applies here is declared below, in full.
//
// Flat-config resolution, since the two blocks below configure the same rule:
// for a given file ESLint applies the LAST config object in the array whose
// `files` match, and an object that supplies rule OPTIONS replaces the earlier
// options wholesale — no deep merge, no union of `paths` / `patterns`. A
// `files` selector decides only WHETHER an object matches; its narrowness or
// breadth has no bearing on how options combine, and there is no such thing as
// a "merge conflict" between two selectors. Each block below is therefore
// self-contained by necessity. The replace-not-merge semantics are pinned
// against the real engine by `renderer-import-boundary.test.ts` ("a later
// config object's rule options replace, never merge").
import root from "../../eslint.config.mjs";

export default [
  ...root,
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
    // Scope is the SHIPPED renderer surface. `__tests__/**` is excluded here
    // and re-covered by the narrower block below, mirroring the repo-root
    // `packages/contracts` isomorphism block, which excludes its own tests for
    // the same reason: the ban exists to keep Node/Electron capability out of
    // the renderer BUNDLE, and test files are never bundled — they run under
    // vitest, where a Node builtin is legitimate (this package's own
    // `renderer-import-boundary.test.ts` lints the tree via the ESLint Node
    // API and so must import `node:path`). The renderer-untrusted guarantee
    // for shipped code is unaffected: every non-test renderer file is still
    // matched by this block.
    ignores: ["src/renderer/src/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "electron",
              message:
                "Spec-023 §Trust Stance: renderer is untrusted — `electron` must NEVER be imported from renderer source. Route through the preload bridge (`window.sidekicks`) instead. See apps/desktop/src/preload/index.ts.",
            },
            {
              name: "fs",
              message:
                "Spec-023 §Trust Stance: renderer is untrusted — Node built-in `fs` is forbidden in renderer source. Route through the preload bridge.",
            },
            {
              name: "child_process",
              message:
                "Spec-023 §Trust Stance: renderer is untrusted — Node built-in `child_process` is forbidden in renderer source. Route through the preload bridge.",
            },
            {
              name: "net",
              message:
                "Spec-023 §Trust Stance: renderer is untrusted — Node built-in `net` is forbidden in renderer source. Route through the preload bridge.",
            },
            {
              name: "os",
              message:
                "Spec-023 §Trust Stance: renderer is untrusted — Node built-in `os` is forbidden in renderer source. Route through the preload bridge.",
            },
            {
              name: "path",
              message:
                "Spec-023 §Trust Stance: renderer is untrusted — Node built-in `path` is forbidden in renderer source. Route through the preload bridge.",
            },
            {
              name: "process",
              message:
                "Spec-023 §Trust Stance: renderer is untrusted — Node built-in `process` is forbidden in renderer source. Route through the preload bridge.",
            },
            {
              name: "@ai-sidekicks/runtime-daemon",
              message:
                "Plan-003 CP-003-3 / Spec-023 §Trust Stance: renderer is untrusted — the daemon package must NEVER be imported from renderer source (directly or through a local helper). Route through the preload bridge (`window.sidekicks.daemon`).",
            },
            {
              name: "@ai-sidekicks/control-plane",
              message:
                "Plan-003 CP-003-3 / Spec-023 §Trust Stance: renderer is untrusted — the control-plane package must NEVER be imported from renderer source (directly or through a local helper). Route through the preload bridge (`window.sidekicks.controlPlane`).",
            },
          ],
          patterns: [
            {
              // Electron subpath entrypoints (`electron/renderer`,
              // `electron/main`, `electron/common`, and any nested subpath)
              // sit alongside the bare `electron` specifier banned in
              // `paths` above. `no-restricted-imports` treats bare specifiers
              // and subpaths as distinct, so the `paths: "electron"` entry
              // does NOT cover `electron/renderer` et al. The `**` glob uses
              // gitignore-style semantics (via the `ignore` package) and
              // matches across slashes, so this catches every documented and
              // future Electron subpath at once.
              group: ["electron/**"],
              message:
                "Spec-023 §Trust Stance: renderer is untrusted — `electron` (and any `electron/*` subpath) must NEVER be imported from renderer source. Route through the preload bridge (`window.sidekicks`) instead. See apps/desktop/src/preload/index.ts.",
            },
            {
              // `no-restricted-imports` does NOT auto-cover `node:fs` from a
              // `fs` ban (nor vice versa) — the rule treats `fs` and
              // `node:fs` as distinct specifiers. We list both: `paths` for
              // the bare forms above, and this glob for the entire `node:*`
              // protocol family AND its subpaths. `**` matches across
              // slashes (gitignore-style) so this single pattern catches
              // both leaf imports (`node:fs`, `node:os`) and subpath imports
              // (`node:fs/promises`, `node:stream/web`, `node:dns/promises`,
              // `node:readline/promises`, `node:stream/consumers`).
              group: ["node:**"],
              message:
                "Spec-023 §Trust Stance: renderer is untrusted — `node:*` protocol imports (and their subpaths, e.g. `node:fs/promises`) are forbidden in renderer source. Route through the preload bridge.",
            },
            {
              // Subpath entrypoints of the two banned workspace packages.
              // `no-restricted-imports` treats a bare specifier and its
              // subpaths as distinct, so the `paths` entries above do NOT
              // cover `@ai-sidekicks/control-plane/router` et al. Same
              // gitignore-style `**` semantics as the `electron/**` group.
              group: ["@ai-sidekicks/runtime-daemon/**", "@ai-sidekicks/control-plane/**"],
              message:
                "Plan-003 CP-003-3 / Spec-023 §Trust Stance: renderer is untrusted — daemon / control-plane package subpaths are forbidden in renderer source. Route through the preload bridge (`window.sidekicks`).",
            },
            {
              // Relative-path escape into the main/preload subtrees. `**`
              // matches zero-or-more path segments so this catches any
              // depth: `../main/x`, `../../main/x`, `../../../main/x`, etc.,
              // and the same for `preload`. The renderer-untrusted boundary
              // means renderer source must NEVER reach into another
              // process's source — the only legitimate channel is the
              // preload-exposed `window.sidekicks` bridge.
              group: ["**/main/**", "**/preload/**"],
              message:
                "Spec-023 §Trust Stance: renderer is untrusted — relative-path imports into `main/**` or `preload/**` are forbidden. The renderer's only cross-process surface is the `window.sidekicks` bridge.",
            },
          ],
        },
      ],
    },
  },
  // Renderer TEST files: the Node/Electron builtin ban above is deliberately
  // lifted (they are not bundled — see that block's comment), but the
  // CP-003-3 workspace-package boundary is NOT. No renderer test has any
  // reason to import the daemon or control-plane package, and leaving the
  // exclusion total would hand test files a hole in the very boundary the
  // sibling `renderer-import-boundary.test.ts` exists to enforce. This block
  // RESTATES the two CP-003-3 entries rather than inheriting them, because
  // nothing is inherited: the block above `ignores` `__tests__/**` and so does
  // not match these files at all, and even where two objects did both match,
  // the later one's options would replace the earlier one's wholesale (see the
  // header note on flat-config resolution). Drop either entry from this block
  // and that half of the boundary silently disappears for test files.
  {
    files: ["src/renderer/src/**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@ai-sidekicks/runtime-daemon",
              message:
                "Plan-003 CP-003-3: the daemon package is forbidden in renderer source, tests included — assert against the bridge contract (`@ai-sidekicks/contracts`) instead.",
            },
            {
              name: "@ai-sidekicks/control-plane",
              message:
                "Plan-003 CP-003-3: the control-plane package is forbidden in renderer source, tests included — assert against the bridge contract (`@ai-sidekicks/contracts`) instead.",
            },
          ],
          patterns: [
            {
              group: ["@ai-sidekicks/runtime-daemon/**", "@ai-sidekicks/control-plane/**"],
              message:
                "Plan-003 CP-003-3: daemon / control-plane subpaths are forbidden in renderer source, tests included.",
            },
          ],
        },
      ],
    },
  },
];
