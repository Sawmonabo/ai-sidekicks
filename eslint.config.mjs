// ESLint flat config. It uses only non-type-aware rules, so lint-staged feedback stays sub-second.
import js from "@eslint/js";
import checkFile from "eslint-plugin-check-file";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * The enum ban, exported so a package config that sets `no-restricted-syntax` for its own
 * files restates it: flat config replaces a rule's options at the last matching object.
 */
export const ENUM_DECLARATION = {
  selector: "TSEnumDeclaration",
  message:
    "Do not use TypeScript enums in application or domain code. Use a string-literal " +
    "union, an `as const` object with its derived union, or a discriminated union. An " +
    "enum an external contract requires stays at that boundary and is translated there.",
};

/** The `export *` ban, exported so a package config restates it beside the enum ban. */
export const EXPORT_ALL_DECLARATION = {
  selector: "ExportAllDeclaration",
  message:
    "No `export *`. Name each export, so a module's public surface is written where it " +
    "is published and a symbol added to the source module is not exported by accident.",
};

/*
 * File and folder name shapes, as micromatch extglobs (the syntax `eslint-plugin-check-file`
 * matches with). A name is checked without its extensions, so `AppRouter.test.tsx` is checked as
 * `AppRouter`, which is how a test keeps its subject's name.
 */
const KEBAB_NAME = "+([a-z])*([a-z0-9])*(-+([a-z0-9]))";
const PASCAL_NAME = "+([A-Z]*([a-z0-9]))";
const HOOK_NAME = `use${PASCAL_NAME}`;

/** Every script file ESLint reads, so the naming rules reach tools and configs as well. */
const SCRIPT_FILES = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];

/** The desktop renderer, the one tree that holds React components and hooks. */
const RENDERER_FILES = ["**/src/renderer/src/**/*.{ts,tsx}"];

/** Where the file and folder naming rules these messages enforce are written. */
const NAMING_RULES_SOURCE = "File and folder names in apps/desktop/AGENTS.md";

/** A `.tsx` file with no JSX in it, which is named `.ts` instead. */
const TSX_WITHOUT_JSX = {
  selector: "Program:not(:has(JSXElement, JSXFragment))",
  message: `A file with no JSX is .ts, not .tsx; see ${NAMING_RULES_SOURCE}`,
};

/** Names the `.tsx` copies `requireJsxInTsx` adds, so a second pass replaces them. */
const TSX_COPY_NAME_SUFFIX = " (.tsx holds JSX)";

/**
 * Follows each config object that sets `no-restricted-syntax` with a copy for its `.tsx` files that
 * adds the no-JSX selector. The selector cannot join the shared lists, because every `.ts` file
 * would match it, and flat config keeps only the last matching object's options, so each object
 * needs its own copy. Apply it to a whole config; copies from an earlier pass are rebuilt.
 */
export function requireJsxInTsx(configs) {
  return configs
    .filter((config) => !config.name?.endsWith(TSX_COPY_NAME_SUFFIX))
    .flatMap((config) => {
      const restrictedSyntax = config.rules?.["no-restricted-syntax"];
      if (!Array.isArray(restrictedSyntax)) {
        return [config];
      }
      const tsxCopy = {
        name: `${config.name ?? "no-restricted-syntax"}${TSX_COPY_NAME_SUFFIX}`,
        files: (config.files ?? ["**/*"]).map((pattern) => [pattern, "**/*.tsx"]),
        rules: { "no-restricted-syntax": [...restrictedSyntax, TSX_WITHOUT_JSX] },
      };
      if (config.ignores) {
        tsxCopy.ignores = config.ignores;
      }
      return [config, tsxCopy];
    });
}

const repositoryConfig = defineConfig(
  {
    ignores: [
      "**/dist/**",
      // electron-vite emits the desktop bundles to `apps/desktop/out/`; ignore it like dist/.
      "**/out/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/*.tsbuildinfo",
      // Gitignored trees a bare `eslint .` would otherwise walk, since ESLint's ignore list is
      // independent of .gitignore: `target/doc` (cargo-doc's browser JS trips `no-undef`),
      // `.agents/tmp`, and any live worktree, which duplicates the whole tree.
      "**/.worktrees/**",
      "**/target/**",
      // Scoped to `tmp/`, matching .gitignore: `.agents/` itself is not ignored, so `.agents/**`
      // would exempt future committed content.
      "**/.agents/tmp/**",
      // Sätteri's source with our fix, which the markdown parser's build unpacks.
      "packages/markdown-parser/satteri/**",
      // The packages the Rust port replaces, unchecked until the change that deletes each one.
      "apps/cli/**",
      "packages/control-plane/**",
      "packages/crypto-paseto/**",
      "packages/runtime-daemon/**",
      "packages/search-index/**",
      "packages/sidecar-rust-pty/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
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
  // Every authored TypeScript file carries the enum and `export *` bans. A declaration file is
  // ambient and holds no runtime code.
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    ignores: ["**/*.d.ts"],
    rules: { "no-restricted-syntax": ["error", ENUM_DECLARATION, EXPORT_ALL_DECLARATION] },
  },
  // An interface takes no `I` prefix (`IUser`); an acronym such as `IPCClient` still passes.
  // Only this selector is configured, so no other naming is checked.
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "interface",
          format: null,
          custom: { regex: "^I[A-Z][a-z]", match: false },
        },
      ],
    },
  },
  // File and folder names. The plugin matches a rule's patterns against the path relative to the
  // directory ESLint runs in, which is the repository root in CI and lint-staged and each package
  // in `pnpm lint`, so no pattern is anchored to the root: a file pattern starts with `**/`, and a
  // folder pattern is tested against every run of consecutive folders in the path. Rust is outside
  // by construction: ESLint never reads a `.rs` file.
  //
  // Outside the desktop renderer nothing is a React component or hook, so every file and folder
  // is kebab-case.
  {
    files: SCRIPT_FILES,
    plugins: { "check-file": checkFile },
    rules: {
      "check-file/filename-naming-convention": [
        "error",
        { "**/*": "KEBAB_CASE" },
        {
          ignoreMiddleExtensions: true,
          errorMessage: `"{{ target }}" is not kebab-case; see ${NAMING_RULES_SOURCE}`,
        },
      ],
      "check-file/folder-naming-convention": [
        "error",
        { "**/": "KEBAB_CASE" },
        { errorMessage: `Folder "{{ target }}" is not kebab-case; see ${NAMING_RULES_SOURCE}` },
      ],
      // A test is `<subject>.test.ts(x)`; Vitest runs Playwright too, so nothing is a spec file.
      "check-file/filename-blocklist": [
        "error",
        {
          "**/*.spec.{ts,tsx,mts,cts,js,jsx,mjs,cjs}": "*.test.ts",
          ".claude/**/*.spec.{ts,mts,js,mjs}": "*.test.mjs",
        },
      ],
    },
  },
  // The packages keep their tests in `__tests__/` and their test fixtures in `__fixtures__/`; the
  // desktop places tests beside their source, so it gets neither.
  {
    files: ["packages/**"],
    rules: {
      "check-file/folder-naming-convention": [
        "error",
        { "**/": "KEBAB_CASE" },
        {
          ignoreWords: ["__tests__", "__fixtures__"],
          errorMessage: `Folder "{{ target }}" is not kebab-case; see ${NAMING_RULES_SOURCE}`,
        },
      ],
    },
  },
  // The repository's own tooling keeps its tests in `__tests__/` too.
  {
    files: ["tools/**"],
    rules: {
      "check-file/folder-naming-convention": [
        "error",
        { "**/": "KEBAB_CASE" },
        {
          ignoreWords: ["__tests__"],
          errorMessage: `Folder "{{ target }}" is not kebab-case; see ${NAMING_RULES_SOURCE}`,
        },
      ],
    },
  },
  // A `**` never matches a name that starts with a dot, so the patterns above pass over the
  // dotted names tools fix (`.dependency-cruiser.mjs`). Claude Code reads its hooks and skills
  // from `.claude/`, so the files under it are named from there down.
  {
    files: [".claude/**"],
    rules: {
      "check-file/filename-naming-convention": [
        "error",
        { ".claude/**/*": "KEBAB_CASE" },
        {
          ignoreMiddleExtensions: true,
          errorMessage: `"{{ target }}" is not kebab-case; see ${NAMING_RULES_SOURCE}`,
        },
      ],
      "check-file/folder-naming-convention": [
        "error",
        { ".claude/**/": "KEBAB_CASE" },
        {
          ignoreWords: ["__tests__"],
          errorMessage: `Folder "{{ target }}" is not kebab-case; see ${NAMING_RULES_SOURCE}`,
        },
      ],
    },
  },
  // The desktop renderer. Every entry that matches a file applies, so a file passes only when it
  // satisfies all of them:
  // - any file is kebab-case, a PascalCase component or page, or a `useThing` hook; a test or
  //   test-support file is checked by its subject's name;
  // - a `.tsx` in `app/`, `components/`, `features/` or `layout/` is a component or page, so its
  //   name is PascalCase; a hook, a test and test support there keep their own shapes;
  // - a file in a `hooks/` folder is a hook, except test support named for what it supports.
  //
  // A folder is kebab-case, except a shared component or group owner folder, which sits directly
  // under a `components/` or `layout/` folder and is PascalCase; a PascalCase folder anywhere else
  // is refused.
  {
    files: RENDERER_FILES,
    rules: {
      "check-file/filename-naming-convention": [
        "error",
        {
          "**/*": `@(${KEBAB_NAME}|${PASCAL_NAME}|${HOOK_NAME})`,
          "**/src/renderer/src/@(app|components|features|layout)/**/!(use[A-Z]*|*.test|*.test-support).tsx":
            "PASCAL_CASE",
          "**/hooks/**/!(*.test-support).{ts,tsx}": HOOK_NAME,
        },
        {
          ignoreMiddleExtensions: true,
          errorMessage:
            `"{{ target }}" breaks the renderer's file names: a component or ` +
            `page is PascalCase, a hook useThing, any other module kebab-case, ` +
            `and a test keeps its subject's name; see ${NAMING_RULES_SOURCE}`,
        },
      ],
      "check-file/folder-naming-convention": [
        "error",
        {
          "**/": `@(${KEBAB_NAME}|${PASCAL_NAME})`,
          "!(components|layout)/+([A-Z])*/": "KEBAB_CASE",
          "components/*/": "PASCAL_CASE",
          "layout/*/": "PASCAL_CASE",
        },
        {
          errorMessage:
            `Folder "{{ target }}" breaks the renderer's folder names: a shared ` +
            `component or group owner directly under components/ or layout/ is ` +
            `PascalCase, every other folder kebab-case; see ${NAMING_RULES_SOURCE}`,
        },
      ],
    },
  },
  // Node globals for build tooling (`tools/`) and root config files, which ESLint parses without TS
  // type info; packages and apps get theirs from `@types/node`.
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
  // The control plane's JavaScript runs inside the Worker, whose runtime supplies `console`.
  {
    files: ["crates/sidekicks-control-plane/js/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
      },
    },
  },
  // `@ai-sidekicks/contracts` isomorphism guard. Contracts ships to Node, Cloudflare Workers and
  // the browser, so its shipped surface must stay free of Node-only builtins: a `node:` import or
  // `Buffer` would break it on Workers and in the browser. Scope is the compiled non-test
  // `src/*.ts` (package.json `files: ["dist"]`); `__tests__/**` run on Node under vitest, where
  // `Buffer` legitimately exists, so they are excluded. (`ignores` beside `files` is local to this
  // block, not a global ignore.) Contracts is the bottom of the workspace graph, so it imports no
  // other workspace package; every other package imports it.
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
                "@ai-sidekicks/contracts must stay isomorphic (Node + Cloudflare Workers + " +
                "browser): node: builtins are forbidden. Use a Web-standard API instead.",
            },
            {
              group: ["@ai-sidekicks/*"],
              message:
                "@ai-sidekicks/contracts is the bottom of the workspace graph: it imports no " +
                "other workspace package.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message:
            "@ai-sidekicks/contracts must stay isomorphic: Buffer is Node-only. Use Uint8Array.",
        },
      ],
    },
  },
  // The client SDK is what the renderer and the command line call the daemon through, so it holds
  // only the wire: `@ai-sidekicks/contracts` is the one workspace package it may import, never the
  // daemon, the control plane or an app.
  {
    files: ["packages/client-sdk/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^@ai-sidekicks/(?!contracts/[\\w-]+(?:/[\\w-]+)*$)",
              message:
                "@ai-sidekicks/client-sdk imports @ai-sidekicks/contracts and no other " +
                "workspace package.",
            },
          ],
        },
      ],
    },
  },
  // `event/version.ts` is the acyclic leaf of the contracts module graph. `event/session.ts`
  // imports it, so an import back into `./session.js` re-closes the cycle; under Vite's SSR
  // transform a module-scope read of the uninitialized binding is `undefined` rather than a throw,
  // so the breakage is silent until a payload-schema union branch fails to construct.
  //
  // Carried on `no-restricted-syntax`, not `no-restricted-imports`: the block above already
  // configures `no-restricted-imports` for every contracts source file, and flat config replaces a
  // rule's options at the last matching object, so a second invocation would drop the `node:*` ban
  // for this file. The static import, the dynamic import and `export { … } from` are denied here;
  // `export *` is banned everywhere.
  {
    files: ["packages/contracts/src/event/version.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ENUM_DECLARATION,
        EXPORT_ALL_DECLARATION,
        {
          selector: 'ImportDeclaration[source.value="./session.js"]',
          message:
            "event/version.ts is the acyclic leaf of the contracts module " +
            "graph — importing ./session.js from it closes an import cycle, " +
            "which can leave a module-scope schema undefined with no error.",
        },
        {
          selector: 'ImportExpression[source.value="./session.js"]',
          message:
            "event/version.ts is the acyclic leaf of the contracts module graph — a " +
            "dynamic import of ./session.js closes the cycle just as the static form does.",
        },
        {
          selector: 'ExportNamedDeclaration[source.value="./session.js"]',
          message:
            "event/version.ts is the acyclic leaf of the contracts module graph — " +
            "re-exporting from ./session.js closes the cycle exactly as importing it does.",
        },
      ],
    },
  },
);

export default requireJsxInTsx(repositoryConfig);
