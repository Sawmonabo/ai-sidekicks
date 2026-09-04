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
// The ban applies to `src/renderer/src/**/*.{ts,tsx}` AND to
// `src/shared/**/*.{ts,tsx}` — the main and preload processes legitimately
// depend on `electron`, `node:*`, and friends, and must remain free to import
// them, but a shared module is bundled into the renderer and so carries exactly
// the renderer's constraints. Scope is narrowed by the `files` selectors on the
// override blocks below.
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
//
// The console/shell block below is the one place a file IS matched by two
// `no-restricted-imports` objects, and it is written knowing that: it restates the
// renderer ban by SPREADING the two arrays hoisted directly beneath this comment
// rather than by copying them, so the replace-not-merge semantics above cost the
// console nothing and a ban added to the renderer list reaches the console with it.
// The one thing that block adds is `zod` — see its own comment.
import root from "../../eslint.config.mjs";

/**
 * The bare specifiers renderer source may not import. Hoisted so the console/shell
 * block can extend the list instead of restating it: flat config REPLACES a rule's
 * options at the last matching object, so a second block that spelled out its own
 * shorter list would silently delete every entry it forgot.
 */
const RENDERER_RESTRICTED_PATHS = [
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
];

/** The specifier GROUPS renderer source may not import. Hoisted for the same reason. */
const RENDERER_RESTRICTED_PATTERNS = [
  {
    // Electron subpath entrypoints (`electron/renderer`, `electron/main`,
    // `electron/common`, and any nested subpath) sit alongside the bare
    // `electron` specifier banned in `paths` above. `no-restricted-imports`
    // treats bare specifiers and subpaths as distinct, so the
    // `paths: "electron"` entry does NOT cover `electron/renderer` et al. The
    // `**` glob uses gitignore-style semantics (via the `ignore` package) and
    // matches across slashes, so this catches every documented and future
    // Electron subpath at once.
    group: ["electron/**"],
    message:
      "Spec-023 §Trust Stance: renderer is untrusted — `electron` (and any `electron/*` subpath) must NEVER be imported from renderer source. Route through the preload bridge (`window.sidekicks`) instead. See apps/desktop/src/preload/index.ts.",
  },
  {
    // `no-restricted-imports` does NOT auto-cover `node:fs` from a `fs` ban
    // (nor vice versa) — the rule treats `fs` and `node:fs` as distinct
    // specifiers. We list both: `paths` for the bare forms above, and this
    // glob for the entire `node:*` protocol family AND its subpaths. `**`
    // matches across slashes (gitignore-style) so this single pattern catches
    // both leaf imports (`node:fs`, `node:os`) and subpath imports
    // (`node:fs/promises`, `node:stream/web`, `node:dns/promises`,
    // `node:readline/promises`, `node:stream/consumers`).
    group: ["node:**"],
    message:
      "Spec-023 §Trust Stance: renderer is untrusted — `node:*` protocol imports (and their subpaths, e.g. `node:fs/promises`) are forbidden in renderer source. Route through the preload bridge.",
  },
  {
    // Subpath entrypoints of the two banned workspace packages.
    // `no-restricted-imports` treats a bare specifier and its subpaths as
    // distinct, so the `paths` entries above do NOT cover
    // `@ai-sidekicks/control-plane/router` et al. Same gitignore-style `**`
    // semantics as the `electron/**` group.
    group: ["@ai-sidekicks/runtime-daemon/**", "@ai-sidekicks/control-plane/**"],
    message:
      "Plan-003 CP-003-3 / Spec-023 §Trust Stance: renderer is untrusted — daemon / control-plane package subpaths are forbidden in renderer source. Route through the preload bridge (`window.sidekicks`).",
  },
  {
    // Relative-path escape into the main/preload subtrees. `**` matches
    // zero-or-more path segments so this catches any depth: `../main/x`,
    // `../../main/x`, `../../../main/x`, etc., and the same for `preload`. The
    // renderer-untrusted boundary means renderer source must NEVER reach into
    // another process's source — the only legitimate channel is the
    // preload-exposed `window.sidekicks` bridge.
    group: ["**/main/**", "**/preload/**"],
    message:
      "Spec-023 §Trust Stance: renderer is untrusted — relative-path imports into `main/**` or `preload/**` are forbidden. The renderer's only cross-process surface is the `window.sidekicks` bridge.",
  },
];

export default [
  ...root,
  // `src/shared/**` is imported by BOTH processes (see
  // `src/shared/auxiliary-routes.ts`), which means every byte of it is bundled
  // into the RENDERER. The renderer-untrusted ban below is scoped to
  // `src/renderer/src/**`, so without this block a `node:fs` import could reach
  // the renderer bundle through a shared module and pass lint — the exact
  // transitive shape the BL-131 addition to that block exists to close, arriving
  // through a different door. The ban restated here is the shipped-renderer one;
  // there is no test carve-out, because a shared test file is not bundled either
  // way and a shared module has no reason to touch a Node builtin at all.
  {
    files: ["src/shared/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "electron",
              message:
                "Spec-023 §Trust Stance: `src/shared/**` is bundled into the RENDERER — `electron` must never be imported here. Put main-process code in `src/main/**` and share only data and pure functions.",
            },
            {
              name: "@ai-sidekicks/runtime-daemon",
              message:
                "Plan-003 CP-003-3 / Spec-023 §Trust Stance: `src/shared/**` is bundled into the renderer — the daemon package must never be imported here. Route through the preload bridge.",
            },
            {
              name: "@ai-sidekicks/control-plane",
              message:
                "Plan-003 CP-003-3 / Spec-023 §Trust Stance: `src/shared/**` is bundled into the renderer — the control-plane package must never be imported here. Route through the preload bridge.",
            },
          ],
          patterns: [
            {
              group: ["electron/**"],
              message:
                "Spec-023 §Trust Stance: `src/shared/**` is bundled into the renderer — `electron` and every `electron/*` subpath are forbidden here.",
            },
            {
              group: ["node:**"],
              message:
                "Spec-023 §Trust Stance: `src/shared/**` is bundled into the renderer — `node:*` protocol imports (and their subpaths) are forbidden here.",
            },
            {
              group: ["@ai-sidekicks/runtime-daemon/**", "@ai-sidekicks/control-plane/**"],
              message:
                "Plan-003 CP-003-3: daemon / control-plane subpaths are forbidden in `src/shared/**`, which is bundled into the renderer.",
            },
            {
              group: ["**/main/**", "**/preload/**"],
              message:
                "Spec-023 §Trust Stance: `src/shared/**` is bundled into the renderer — it must never reach into `main/**` or `preload/**`. Dependencies point the other way: main imports shared, never the reverse.",
            },
          ],
        },
      ],
    },
  },
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
        { paths: RENDERER_RESTRICTED_PATHS, patterns: RENDERER_RESTRICTED_PATTERNS },
      ],
    },
  },
  // The CONSOLE and the shell subtree it composes seats for. One entry more than
  // the renderer block above, and one subtree less.
  //
  // WHAT IT ADDS. `zod`. Every daemon reply the console reads is parsed at one
  // door — `console/bridge/daemon-reply.ts`, against the schemas
  // `console/bridge/daemon-reply-registry.ts` binds to each method — and a surface
  // that could reach the validator directly could parse a second time, differently,
  // or skip the parse and keep the fulfilled `unknown`. That is not hypothetical:
  // the per-family parsers this chokepoint replaces were three different readings
  // of one seam, and one of them did no parsing at all. A surface needing a shape
  // asks for the method, not for a schema.
  //
  // WHY `console/bridge/**` IS EXEMPT RATHER THAN THE CHOKEPOINT FILE ALONE. The
  // registry composes contracts-exported schemas, the run-stream projector decodes
  // a subscription payload, and the wire-truth scenarios assert against the wire's
  // own shapes — three modules in one family, all of them below every surface. The
  // family is the honest unit: a file-scoped exemption would have to grow a line
  // per module and would say nothing about which layer may hold a validator.
  //
  // WHY IT RESTATES THE RENDERER BAN. Flat config replaces a rule's options at the
  // last matching object, so this block must carry every entry that block carries
  // or the console silently loses the renderer-untrusted boundary. It SPREADS the
  // hoisted arrays rather than copying them, so the two cannot drift.
  //
  // WHY IT SITS HERE AND NOT LAST. The `__tests__` block below must keep winning
  // for the files it names, exactly as it does today. Nothing under `console/`
  // carries a `__tests__` directory — the package's own structure rules put a
  // console test beside its module — so this ordering changes no file's verdict
  // and leaves that block's asymmetry to say what it already says.
  {
    files: ["src/renderer/src/console/**/*.{ts,tsx}", "src/renderer/src/shell/**/*.{ts,tsx}"],
    ignores: ["src/renderer/src/console/bridge/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: RENDERER_RESTRICTED_PATHS,
          patterns: [
            ...RENDERER_RESTRICTED_PATTERNS,
            {
              // Bare specifier and every subpath (`zod/v4`, `zod/mini`) in one
              // group: `no-restricted-imports` treats them as distinct, and a ban
              // on the bare form alone would be one import away from useless.
              group: ["zod", "zod/**"],
              message:
                "Spec-023 §Console Design (Meridian): a console surface never parses a wire value itself. Reach the daemon through `callDaemon` from `console/bridge/`, which parses the reply against the method's registered schema and answers `served` or `refused`; a value that needs a shape needs a registry row, not a local validator.",
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
  // The console's two single-reading chokepoints, enforced as SYNTAX because they are
  // not import bans and `no-restricted-imports` cannot express any of them. This is the
  // package's first and only `no-restricted-syntax` invocation: flat config replaces a
  // rule's options at the LAST matching config object, so a later block that also
  // configures this rule for any file under `console/` or `shell/` must restate every
  // selector below rather than add to them.
  //
  // A FOURTH selector lived here and is gone. It banned importing
  // `normalizeWireRejection` from `src/shared/wire-errors.ts`, back when a function of
  // that name lived in both that module and `console/core/wire-rejection.ts` with two
  // different return types — an import from the wrong one compiled wherever the result
  // was only rendered. The shared function is now `wireRejectionToError`, named for
  // what it answers, so the collision is closed at its source. What the selector used
  // to catch, `tsc` now catches first and better: the stale import is
  // `error TS2305: Module ... has no exported member 'normalizeWireRejection'`
  // (measured against the real typecheck script, not assumed). A lint rule whose only
  // reachable target is a symbol that does not exist guards nothing.
  //
  // Scope is `console/**` and `shell/**`, tests included. `shell/**` matches nothing on
  // this branch and is named anyway: it is a `console-unit` resident by
  // `apps/desktop/AGENTS.md`, and a gate that arrives after the code it governs arrives
  // too late. A `files` pattern matching no file is not an ESLint error.
  //
  // Four files are exempt, and each is exempt for its own reason rather than by
  // convenience: `core/instant.ts` and `core/wire-rejection.ts` are the readings the
  // rules point at; `core/clock.ts` is the console's one `Date.now` seam; and the two
  // tests are the negative controls, which have to CALL the banned API to demonstrate
  // that `Date.parse` answers a number for a value RFC 3339 refuses. A ban nobody can
  // show the cost of is a ban nobody keeps.
  {
    files: ["src/renderer/src/console/**/*.{ts,tsx}", "src/renderer/src/shell/**/*.{ts,tsx}"],
    ignores: [
      "src/renderer/src/console/core/instant.ts",
      "src/renderer/src/console/core/instant.test.ts",
      "src/renderer/src/console/core/clock.ts",
      "src/renderer/src/console/core/wire-rejection.ts",
      "src/renderer/src/console/primitives/wire-figures.time.test.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'CallExpression[callee.object.name="Date"][callee.property.name="parse"]',
          message:
            "`Date.parse` is not a validator: it reads a timezone-less stamp in the HOST's zone, reads a date-only string in UTC, and normalizes a day that does not exist (`2026-02-30T10:00:00Z` becomes March 2). Each answers a NUMBER, so the `Number.isNaN` guard passes and a surface renders an instant the wire never sent. Read the stamp with `parseInstant` from `console/core/instant.ts`, and order two of them with `compareInstants`.",
        },
        {
          // A string-shaped argument only. `new Date(<milliseconds>)` is how a fixture
          // composes an instant from a base and an offset and stays legitimate; a
          // numeric literal can carry none of `-`, `:`, or `T`, and a negative one is a
          // `UnaryExpression` rather than a `Literal`, so neither matches.
          selector:
            'NewExpression[callee.name="Date"] > :matches(TemplateLiteral, Literal[value=/[-:T]/])',
          message:
            "`new Date(<string>)` is `Date.parse` with a wrapper and carries the same leniency. Read the stamp with `parseInstant` from `console/core/instant.ts`; build a fixture instant from `Date.UTC(...)` instead of parsing one.",
        },
        {
          // Any `String(...)` inside a `catch`, not only one applied to the binding:
          // `String(thrown.detail)` runs the same ToPrimitive on the same untrusted
          // value. `lossyStringify` is total, so nothing is given up by the width.
          selector: 'CatchClause CallExpression[callee.name="String"]',
          message:
            "`String(...)` inside a `catch` is not total: it runs ToPrimitive, which throws on a null-prototype value carrying no `toString` and on any hostile accessor — inside the expression that exists to report a failure, and inside a `catch` that has already been left. Use `lossyStringify` from `src/shared/wire-errors.ts`, or `normalizeWireRejection` from `console/core/wire-rejection.ts` where the result is a refusal.",
        },
      ],
    },
  },
];
