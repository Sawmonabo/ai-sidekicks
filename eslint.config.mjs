// ESLint 10 flat-config per ADR-022 §Decision row 5.
// Type-aware rules are CI-only per typescript-eslint perf guide; the local config
// runs the non-type-aware rule subset for sub-second feedback in lint-staged.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The daemon's `randomUUID` property ban, hoisted so a second block that also has to
 * configure `no-restricted-properties` for a daemon file can RESTATE it rather than
 * silently delete it.
 *
 * Flat config replaces a rule's options at the last matching config object, so the
 * `worktree-projector.ts` clock block below — which is inside the daemon-wide scope this
 * entry is declared for — would drop the v4 ban for exactly that file if it spelled out
 * only its own entries.
 */
const DAEMON_RANDOM_UUID_PROPERTY = {
  property: "randomUUID",
  message:
    "crypto.randomUUID() emits UUID v4. Daemon persisted-row ids and event ids must mint through mintUuidV7 (packages/runtime-daemon/src/ids/uuid-v7.ts), which the contracts package's ID-format rule requires. An id that is genuinely an ephemeral token — no row and no event stores it — earns an entry in the exemption block beside this one, reviewed on the diff that adds it.",
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      // electron-vite emits the desktop app's main/preload/renderer bundles to
      // `apps/desktop/out/`; ignore it like dist/ so a local build's artifacts
      // don't fail lint (CI lints a clean checkout that has no out/ present).
      "**/out/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/*.tsbuildinfo",
      // Three gitignored trees that a bare `eslint .` otherwise walks, because
      // ESLint's ignore list is independent of .gitignore. Measured 2026-07-27
      // on a clean checkout: 1001 errors, none of them about repo source —
      // `target/doc` contributed 973 (cargo-doc ships browser JS assets that
      // trip `no-undef` on `window`) and `.agents/tmp` 28. `.worktrees/`
      // measured 0 only because none existed at the time; a live worktree
      // re-adds the whole duplicated tree, and its files resolve outside the
      // typed-lint tsconfigRootDir, so they fail differently and en masse.
      "**/.worktrees/**",
      "**/target/**",
      // Scoped to `tmp/` deliberately, matching .gitignore — `.agents/` itself
      // is NOT gitignored, so a blanket `.agents/**` would silently exempt
      // future committed content under it.
      "**/.agents/tmp/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Node-globals scope for build tooling (`tools/`) and root-level config files.
  // Packages under `packages/*` and `apps/*` get their globals from
  // `@types/node` via the TS language server; this block covers `.mjs` /
  // tooling scripts that ESLint parses without TS type-info.
  {
    files: ["tools/**/*.{ts,mjs,js}", "*.config.{ts,mjs,js}", "*.{mjs,cjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
      },
    },
  },
  // Plan-008 §I-008-3 enforcement #2 — the tRPC session router + SSE
  // subscription factories must NEVER reach a database driver directly. They
  // route 100% through `SessionDirectoryService` (the wrapper Plan-001 owns).
  // These rules are the whole enforcement. `no-restricted-imports` covers the
  // static `import` / `export … from` forms; it does NOT see a dynamic
  // `import("pg")` (measured 2026-09-09 against ESLint 10.2.1 by planting all
  // three forms — only the two static ones were reported), so the
  // `ImportExpression` selector beside it closes the lazy-import escape hatch.
  // `no-restricted-syntax` is safe to configure here because no other config
  // object in this file sets that rule for `packages/control-plane/**` — flat
  // config REPLACES a rule's options at the last matching object, so a second
  // invocation for an overlapping scope would silently drop the first.
  // `session-directory-service.ts` is deliberately outside the `files` glob —
  // importing `pg` is that module's job.
  {
    files: [
      "packages/control-plane/src/sessions/session-router.ts",
      "packages/control-plane/src/sessions/session-router.factory.ts",
      "packages/control-plane/src/sessions/session-subscribe-sse.ts",
      "packages/control-plane/src/sessions/session-subscribe-sse.factory.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pg",
              message:
                "Plan-008 I-008-3 #2: session router + SSE factories must route through SessionDirectoryService — `pg` is forbidden here. See docs/plans/008-control-plane-relay-and-session-join.md §I-008-3.",
            },
          ],
          patterns: [
            {
              group: ["pg/*"],
              message:
                "Plan-008 I-008-3 #2: session router + SSE factories must route through SessionDirectoryService — `pg/*` subpaths are forbidden here.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^pg(\\/.*)?$/]",
          message:
            'Plan-008 I-008-3 #2: session router + SSE factories must route through SessionDirectoryService — a dynamic `import("pg")` is forbidden here just as the static form is.',
        },
      ],
    },
  },
  // Plan-002 Phase 3 — `@ai-sidekicks/contracts` isomorphism guard. Contracts
  // ships to Node, Cloudflare Workers, AND the browser (it is the shared wire
  // surface), so it must stay free of Node-only builtins. The shared
  // `deriveMainChannelId` derivation uses `@noble/hashes` (isomorphic) rather
  // than `node:crypto` / `Buffer` precisely so contracts can run on Workers.
  // This rule catches a regression at lint time. Its scope is the SHIPPED
  // surface only: `contracts` compiles non-test `src/*.ts` into `dist/`
  // (package.json `files: ["dist"]`), and `dist` is what runs on Workers /
  // browser. Test files are never shipped and run on Node via vitest, where
  // `Buffer` legitimately exists — `presence.test.ts` deliberately asserts that
  // `PresenceUpdateSchema` (`z.instanceof(Uint8Array)`) accepts a Node `Buffer`
  // (real coverage of the daemon→contracts Yjs-awareness producer path, since
  // `Buffer extends Uint8Array`). So `__tests__/**` is excluded: the production
  // isomorphism guarantee (R4) is unaffected by Node-only globals in tests.
  // (The `ignores` key alongside `files` is a LOCAL exclusion for this block,
  // not a global ignore.)
  {
    files: ["packages/contracts/src/**/*.ts"],
    ignores: ["packages/contracts/src/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message:
                "@ai-sidekicks/contracts must stay isomorphic (Node + Cloudflare Workers + browser): node: builtins are forbidden. Use @noble/hashes for hashing/hex. See Plan-002 Phase 3 shared channel-id derivation.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message:
            "@ai-sidekicks/contracts must stay isomorphic: Buffer is Node-only. Use Uint8Array + @noble/hashes/utils bytesToHex.",
        },
      ],
    },
  },
  // Plan-001 T1.12 — `event-core.ts` is the ACYCLIC LEAF of the contracts
  // module graph. `event.ts` imports it, so an import back into `./event.js`
  // from the leaf re-closes the cycle that hoist removed; under Vite's SSR
  // transform a module-scope read of the uninitialized binding surfaces as
  // `undefined` rather than throwing, so the breakage is silent until a
  // payload-schema union branch fails to construct.
  //
  // Carried on `no-restricted-syntax` and NOT on `no-restricted-imports`
  // because the block above already configures `no-restricted-imports` for
  // every contracts source file, and flat config REPLACES a rule's options at
  // the last matching config object — a second `no-restricted-imports`
  // invocation scoped to this one file would silently drop the `node:*`
  // isomorphism ban for exactly it. No other config object sets
  // `no-restricted-syntax` for `packages/contracts/**`, so this one is free of
  // that hazard. All four edge-carrying forms are denied: the static import,
  // the dynamic import expression, and both `export … from` re-export shapes
  // (a re-export closes the cycle exactly as an import does).
  {
    files: ["packages/contracts/src/event-core.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: 'ImportDeclaration[source.value="./event.js"]',
          message:
            "Plan-001 T1.12: event-core.ts is the acyclic leaf of the contracts module graph — importing ./event.js from it re-closes the cycle that hoist exists to remove.",
        },
        {
          selector: 'ImportExpression[source.value="./event.js"]',
          message:
            "Plan-001 T1.12: event-core.ts is the acyclic leaf of the contracts module graph — a dynamic import of ./event.js re-closes the cycle just as the static form does.",
        },
        {
          selector: 'ExportNamedDeclaration[source.value="./event.js"]',
          message:
            "Plan-001 T1.12: event-core.ts is the acyclic leaf of the contracts module graph — re-exporting from ./event.js closes the cycle exactly as importing it does.",
        },
        {
          selector: 'ExportAllDeclaration[source.value="./event.js"]',
          message:
            "Plan-001 T1.12: event-core.ts is the acyclic leaf of the contracts module graph — re-exporting from ./event.js closes the cycle exactly as importing it does.",
        },
      ],
    },
  },
  // `Plan-006 §T3.1 — Append-path service writing integrity columns + Plan-022 Path 1 shred callback`
  // precondition enforcement (PR #272 Codex round 3) — the unsigned-placeholder
  // append opt-in is TEST-ONLY. The `UnsignedPlaceholderAppendToken` type is
  // nominal and identity-checked, so the opt-in cannot be manufactured from
  // config or env DATA — but in-package code could still gate a genuine
  // `forTestsOnly()` call behind an environment check. This rule closes that
  // residual mechanically: outside `__tests__/`, runtime-daemon sources may
  // not call (or even name) the factory. Both the static and computed
  // (`["forTestsOnly"]`) member forms are denied; an aliased-class bypass
  // stays expressible and is left to review, where the loud name is the
  // signal (see the token's class doc in session/session-service.ts).
  {
    files: ["packages/runtime-daemon/src/**/*.ts"],
    ignores: ["packages/runtime-daemon/src/**/__tests__/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='UnsignedPlaceholderAppendToken'][property.name='forTestsOnly']",
          message:
            "UnsignedPlaceholderAppendToken.forTestsOnly() is TEST-ONLY (Plan-006 T3.1 precondition): production code must never enable SessionService.append's zero-filled placeholder writes. Durable writes belong to EventLogService.append.",
        },
        {
          selector:
            "MemberExpression[object.name='UnsignedPlaceholderAppendToken'][property.value='forTestsOnly']",
          message:
            "UnsignedPlaceholderAppendToken['forTestsOnly'] is TEST-ONLY (Plan-006 T3.1 precondition): production code must never enable SessionService.append's zero-filled placeholder writes. Durable writes belong to EventLogService.append.",
        },
      ],
    },
  },
  // `crypto.randomUUID()` emits a v4 UUID — 122 random bits with no time
  // ordering. `packages/contracts/src/session.ts` and `event.ts` both state
  // that daemon-assigned ids are RFC 9562 UUID **v7**, and the wire schemas
  // accept any version on purpose (control-plane rows are Postgres
  // `gen_random_uuid()` v4), so nothing downstream rejects a v4: a new id
  // factory written the old way is wrong and silent. Every daemon persisted-row
  // id and event id mints through `mintUuidV7` (`src/ids/uuid-v7.ts`).
  //
  // Carried on `no-restricted-properties` + `no-restricted-imports` rather than
  // `no-restricted-syntax`, because the block above already configures
  // `no-restricted-syntax` for this exact scope and flat config REPLACES a
  // rule's options at the last matching config object — adding these selectors
  // in a second `no-restricted-syntax` invocation would silently drop the
  // unsigned-placeholder append guard. Neither of the two rules used here is
  // configured for `packages/runtime-daemon/**` anywhere else in this file.
  //
  // `no-restricted-properties` with a bare `property` restricts `.randomUUID`
  // on ANY object, so the global (`crypto.randomUUID()`), namespaced
  // (`nodeCrypto.randomUUID()`) and `globalThis`-qualified forms are all
  // denied; `no-restricted-imports` with `importNames` denies the named-import
  // form (`import { randomUUID } from "node:crypto"`) while leaving that
  // module's other exports — `createHash`, `randomBytes` — available.
  {
    files: ["packages/runtime-daemon/src/**/*.ts"],
    ignores: ["packages/runtime-daemon/src/**/__tests__/**"],
    rules: {
      "no-restricted-properties": ["error", DAEMON_RANDOM_UUID_PROPERTY],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:crypto",
              importNames: ["randomUUID"],
              message:
                "crypto.randomUUID() emits UUID v4. Daemon persisted-row ids and event ids must mint through mintUuidV7 (packages/runtime-daemon/src/ids/uuid-v7.ts). node:crypto's other exports are unrestricted.",
            },
            {
              name: "crypto",
              importNames: ["randomUUID"],
              message:
                "crypto.randomUUID() emits UUID v4. Daemon persisted-row ids and event ids must mint through mintUuidV7 (packages/runtime-daemon/src/ids/uuid-v7.ts). Use the `node:` prefix for the other builtins.",
            },
          ],
        },
      ],
    },
  },
  // The four daemon modules that mint an EPHEMERAL token — a correlation id, a
  // subscription handle, a PTY handle, a scratch filename — where no row and no
  // event stores the value and nothing sorts a set of them, so uniqueness is
  // the whole requirement and v4 supplies it. Each is exempt as a FILE, which
  // is the granularity a lint rule has: the rule cannot say "this call site but
  // not the next one added beside it", so a second mint added inside one of
  // these four files passes lint and is caught only in review. That residual is
  // deliberate and is the reason the exemption set is kept to four files out of
  // 123 rather than grown by convenience.
  //
  // Only the two rules from the block above are turned off; the
  // unsigned-placeholder `no-restricted-syntax` guard is on a different rule
  // and is unaffected.
  {
    files: [
      // Scratch git-index filename, unlinked in the same call.
      "packages/runtime-daemon/src/git/turn-snapshot-service.ts",
      // In-memory subscription id, alive for one transport connection.
      "packages/runtime-daemon/src/ipc/streaming-primitive.ts",
      // In-flight correlation token for one outbound frame.
      "packages/runtime-daemon/src/provider/drivers/outbound-frame.ts",
      // Host-local PTY handle; the Rust sidecar backend mints `s-{n}` here.
      "packages/runtime-daemon/src/pty/node-pty-host.ts",
    ],
    rules: {
      "no-restricted-properties": "off",
      "no-restricted-imports": "off",
    },
  },
  // Plan-009 / Plan-010 — the two read-side projectors are PURE: no database,
  // no temp directory, no clock. Every caller treats each as a side-effect-free
  // fold over already-read rows, and every test in their suites drives them by
  // handing over a row and a probe result directly. The realistic purity break
  // is not a direct `node:fs` import but a sibling import (a service module,
  // the database layer) that pulls I/O in behind it, so the rule is an
  // ALLOW-LIST expressed as a negative-lookahead `regex` pattern rather than a
  // denylist of builtins: `@ai-sidekicks/contracts` is the one permitted
  // specifier, and it is itself held isomorphic by the contracts block above. A
  // future legitimately-pure import widens this pattern in the same diff that
  // adds it.
  //
  // This block REPLACES the daemon-wide `no-restricted-imports` options for
  // these two files, which is correct here rather than merely tolerable: the
  // allow-list already forbids `node:crypto` outright, so it is strictly
  // stronger than the `randomUUID` import ban it displaces, and the
  // `no-restricted-properties` half of that guard is on a different rule and
  // still applies.
  //
  // NAMED RESIDUAL: `no-restricted-imports` does not see a dynamic
  // `import("node:fs")` (measured 2026-09-09 against ESLint 10.2.1), and the
  // `no-restricted-syntax` rule that could is already configured for this whole
  // scope by the append guard above — a second invocation for these two files
  // would silently drop that guard for them, and a copy of it kept in sync by
  // hand is worse config than a stated gap. A lazy import into a pure fold is a
  // review finding, not a lint one.
  {
    files: [
      "packages/runtime-daemon/src/workspace/workspace-projector.ts",
      "packages/runtime-daemon/src/git/worktree-projector.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!@ai-sidekicks/contracts$).*$",
              message:
                "The read-side projectors are pure (Plan-009 / Plan-010): @ai-sidekicks/contracts is the only import they may carry, because any other specifier can reach I/O transitively. Widen this allow-list in eslint.config.mjs in the same diff that adds a genuinely pure import.",
            },
          ],
        },
      ],
    },
  },
  // Plan-005 T3.21 — the memo projection floor is the same PURITY claim as the two
  // projectors above, stated the same way. `memo-projection.ts` is a fold over an
  // already-read canonical projection: it builds the memo turn and hands it to a
  // writer, and it persists nothing. Its import set is pinned at five specifiers
  // (`@noble/hashes` twice, `@ai-sidekicks/contracts`, the outbound-frame module, and
  // its own transform pipeline), so the allow-list ENUMERATES those five rather than
  // admitting a shape. A relative-path shape was measured and rejected: `../../db/`
  // reaches the database layer and is spelled exactly like the sibling this module
  // legitimately carries, so a pattern that admitted relative specifiers would admit
  // the one import the claim is about.
  //
  // The same replace-not-merge trade the projectors' block documents applies and lands
  // the same way: the allow-list forbids `node:crypto` outright, so it is strictly
  // stronger than the `randomUUID` import ban it displaces, and the
  // `no-restricted-properties` half of that guard is on a different rule and still
  // applies. The dynamic-`import()` residual is the same one, and is named there.
  {
    files: ["packages/runtime-daemon/src/provider/transcript/memo-projection.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(?!(?:@ai-sidekicks/contracts|@noble/hashes/blake3\\.js|@noble/hashes/utils\\.js|\\./transform-pipeline\\.js|\\.\\./drivers/outbound-frame\\.js)$).*$",
              message:
                "The memo projection floor is pure (Plan-005 T3.21): it folds an already-read canonical projection into a turn and persists nothing, so its imports are the five this allow-list names and nothing else — a sibling that reaches the database or the filesystem pulls I/O into the fold behind it. Widen this allow-list in eslint.config.mjs in the same diff that adds a genuinely pure import.",
            },
          ],
        },
      ],
    },
  },
  // I-010-20's daemon half, in its structural form: `worktree-projector.ts`
  // reports the expiry fields its caller read and derives no expiry of its own,
  // so clock math must be UNAVAILABLE to it rather than merely unwritten.
  // `no-restricted-globals` resolves the identifier, so a locally-shadowed
  // `Date` is not reported and a genuine global read is — which a text scan
  // could not distinguish.
  //
  // `no-restricted-globals` sees an IDENTIFIER reference and nothing else, so
  // `globalThis.Date.now()` reaches the same clock past it — measured. The
  // property half beside it closes that, and it RESTATES the daemon-wide
  // `randomUUID` entry (hoisted at the top of this file) because this block is
  // inside that block's scope and flat config would otherwise drop it here.
  {
    files: ["packages/runtime-daemon/src/git/worktree-projector.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "Date",
          message:
            "I-010-20: worktree-projector.ts reads no clock — it reports the expiry fields its caller handed it and derives no expiry of its own. Compute the instant in the caller and pass it in.",
        },
        {
          name: "performance",
          message:
            "I-010-20: worktree-projector.ts reads no clock — it reports the expiry fields its caller handed it and derives no expiry of its own. Compute the instant in the caller and pass it in.",
        },
      ],
      "no-restricted-properties": [
        "error",
        DAEMON_RANDOM_UUID_PROPERTY,
        {
          object: "globalThis",
          property: "Date",
          message:
            "I-010-20: worktree-projector.ts reads no clock — reaching `Date` through the global object is the same read the identifier ban refuses. Compute the instant in the caller and pass it in.",
        },
        {
          object: "globalThis",
          property: "performance",
          message:
            "I-010-20: worktree-projector.ts reads no clock — reaching `performance` through the global object is the same read the identifier ban refuses. Compute the instant in the caller and pass it in.",
        },
      ],
    },
  },
);
