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
// This config extends the repo-root `eslint.config.mjs` (which provides the
// `@eslint/js` recommended baseline + `typescript-eslint` recommended +
// repo-wide ignores + the Plan-008 control-plane `no-restricted-imports`
// block). The disjoint `files` selectors mean there is no merge conflict
// between this block and the Plan-008 block.
import root from "../../eslint.config.mjs";

export default [
  ...root,
  {
    files: ["src/renderer/src/**/*.{ts,tsx}"],
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
];
