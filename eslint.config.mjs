// ESLint 10 flat-config per ADR-022 §Decision row 5.
// Type-aware rules are CI-only per typescript-eslint perf guide; the local config
// runs the non-type-aware rule subset for sub-second feedback in lint-staged.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/*.tsbuildinfo",
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
);
