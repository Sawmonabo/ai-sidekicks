// ESLint 10 flat-config per ADR-022 §Decision row 5.
// Type-aware rules are CI-only per typescript-eslint perf guide; the local config
// runs the non-type-aware rule subset for sub-second feedback in lint-staged.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

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
  // This rule catches the violation at lint time; the AST-walker test in
  // packages/control-plane/src/sessions/__tests__/router-no-sql.test.ts
  // re-asserts the same invariant at test time so CI catches it even if
  // lint is bypassed.
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
);
