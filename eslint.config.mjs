// ESLint flat config. It uses only non-type-aware rules, so lint-staged feedback stays sub-second.
import js from "@eslint/js";
import checkFile from "eslint-plugin-check-file";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/**
 * The daemon's `randomUUID` property ban, hoisted so a second block that configures
 * `no-restricted-properties` for a daemon file can restate it. Flat config replaces a rule's
 * options at the last matching config object, so the `git/worktree/projector.ts` clock block below
 * would otherwise drop the v4 ban for that file.
 */
const DAEMON_RANDOM_UUID_PROPERTY = {
  property: "randomUUID",
  message:
    "crypto.randomUUID() emits UUID v4. Daemon persisted-row ids and event ids " +
    "must mint through mintUuidV7 (packages/runtime-daemon/src/uuid-v7.ts), " +
    "which the contracts package's ID-format rule requires. An id that is " +
    "genuinely an ephemeral token — no row and no event stores it — earns an entry " +
    "in the exemption block beside this one, reviewed on the diff that adds it.",
};

/**
 * The daemon's `randomUUID` import ban, hoisted for the same reason: the provider-driver
 * descriptor table's block below restates it without the driver-folder ban.
 */
const DAEMON_RANDOM_UUID_IMPORT_PATHS = [
  {
    name: "node:crypto",
    importNames: ["randomUUID"],
    message:
      "crypto.randomUUID() emits UUID v4. Daemon persisted-row ids and " +
      "event ids must mint through mintUuidV7 (packages/runtime-daemon/src/uuid-v7.ts). " +
      "node:crypto's other exports are unrestricted.",
  },
  {
    name: "crypto",
    importNames: ["randomUUID"],
    message:
      "crypto.randomUUID() emits UUID v4. Daemon persisted-row ids and " +
      "event ids must mint through mintUuidV7 (packages/runtime-daemon/src/uuid-v7.ts). " +
      "Use the `node:` prefix for the other builtins.",
  },
];

/** A relative import through a provider's folder; only the descriptor table may make one. */
const DAEMON_PROVIDER_FOLDER_IMPORT_PATTERN = {
  regex: "^\\.\\.?/(?:.*/)?(?:claude|codex)/",
  message:
    "A provider's folder is imported only by the " +
    "provider-driver descriptor table; shared daemon code " +
    "reads a provider through the table and names none.",
};

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
const NAMING_RULES_SOURCE = "File and folder names under Code conventions in the root AGENTS.md";

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
  // `event/version.ts` is the acyclic leaf of the contracts module graph. `event/session-event.ts`
  // imports it, so an import back into `./session-event.js` re-closes the cycle; under Vite's SSR
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
          selector: 'ImportDeclaration[source.value="./session-event.js"]',
          message:
            "event/version.ts is the acyclic leaf of the contracts module " +
            "graph — importing ./session-event.js from it closes an import cycle, " +
            "which can leave a module-scope schema undefined with no error.",
        },
        {
          selector: 'ImportExpression[source.value="./session-event.js"]',
          message:
            "event/version.ts is the acyclic leaf of the contracts module graph — a " +
            "dynamic import of ./session-event.js closes the cycle just as the static form does.",
        },
        {
          selector: 'ExportNamedDeclaration[source.value="./session-event.js"]',
          message:
            "event/version.ts is the acyclic leaf of the contracts module graph — " +
            "re-exporting from ./session-event.js closes the cycle exactly as importing it does.",
        },
      ],
    },
  },
  // `crypto.randomUUID()` emits a v4 UUID: 122 random bits, no time ordering. Daemon-assigned ids
  // are UUID v7 (contracts `session/id.ts` and `event/session-event.ts`), and the wire schemas
  // accept any version on purpose (control-plane rows are Postgres `gen_random_uuid()` v4), so
  // nothing downstream rejects a v4 and a factory minting one is wrong and silent. Every
  // daemon persisted-row id and event id mints through `mintUuidV7` (`src/uuid-v7.ts`).
  //
  // Carried on `no-restricted-properties` and `no-restricted-imports`: the block above owns
  // `no-restricted-syntax` for this scope, and flat config replaces a rule's options at the last
  // matching object, so these selectors there would drop the test-seeding guard.
  // `no-restricted-properties` with a bare `property` restricts `.randomUUID` on any object
  // (global, namespaced, `globalThis`-qualified); `no-restricted-imports` with `importNames` denies
  // the named import while leaving `createHash` and `randomBytes` available.
  //
  // The same `no-restricted-imports` entry keeps each provider's folder (`provider/driver/claude/`,
  // `provider/driver/codex/`) private: shared daemon code names no provider, so only the descriptor
  // registry imports from one. The pattern matches a relative path with a `claude/` or `codex/`
  // segment; a provider's own files reach their siblings by `./` and shared code by `../` paths
  // that never spell one, and no other daemon folder carries either name.
  {
    files: ["packages/runtime-daemon/src/**/*.ts"],
    ignores: ["packages/runtime-daemon/src/**/__tests__/**"],
    rules: {
      "no-restricted-properties": ["error", DAEMON_RANDOM_UUID_PROPERTY],
      "no-restricted-imports": [
        "error",
        {
          paths: DAEMON_RANDOM_UUID_IMPORT_PATHS,
          patterns: [DAEMON_PROVIDER_FOLDER_IMPORT_PATTERN],
        },
      ],
    },
  },
  // The descriptor table is the one shared module that imports each driver's descriptor.
  {
    files: ["packages/runtime-daemon/src/provider/driver/descriptor.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: DAEMON_RANDOM_UUID_IMPORT_PATHS }],
    },
  },
  // The four daemon modules that mint an ephemeral token (a correlation id, a subscription handle,
  // a PTY handle, a scratch filename): no row or event stores it and nothing sorts a set of them,
  // so uniqueness is the whole requirement and v4 supplies it. Each is exempt as a file, the
  // granularity a lint rule has, so a second mint added inside one of them passes lint and is
  // caught in review; that is why the set stays at four. Only the `randomUUID` bans are lifted:
  // the provider-folder ban still applies, and the test-seeding guard is unaffected.
  {
    files: [
      // Scratch git-index filename, unlinked in the same call.
      "packages/runtime-daemon/src/git/turn-snapshot/service.ts",
      // In-memory subscription id, alive for one transport connection.
      "packages/runtime-daemon/src/ipc/streaming-primitive.ts",
      // In-flight correlation token for one outbound frame.
      "packages/runtime-daemon/src/provider/outbound-frame.ts",
      // Host-local PTY handle; the Rust sidecar backend mints `s-{n}` here.
      "packages/runtime-daemon/src/pty/host/node-pty.ts",
    ],
    rules: {
      "no-restricted-properties": "off",
      "no-restricted-imports": ["error", { patterns: [DAEMON_PROVIDER_FOLDER_IMPORT_PATTERN] }],
    },
  },
  // The two read-side projectors are pure: no database, no temp directory, no clock; each is a
  // side-effect-free fold over already-read rows. The realistic purity break is a sibling import (a
  // service module, the database layer) that pulls I/O in behind it, not a direct `node:fs` import,
  // so the rule is an allow-list (negative-lookahead `regex`) rather than a denylist of builtins:
  // a module of `@ai-sidekicks/contracts`, itself held isomorphic above, is the one permitted
  // import. A legitimately pure new import widens the pattern in the same diff.
  //
  // This block replaces the daemon-wide `no-restricted-imports` options for these two files, which
  // is fine: the allow-list forbids `node:crypto` outright, so it is stronger than the `randomUUID`
  // import ban it displaces, and the `no-restricted-properties` half of that guard still applies.
  //
  // Known gap: `no-restricted-imports` does not see a dynamic `import("node:fs")` (measured on
  // ESLint 10.11.0), and the `no-restricted-syntax` rule that could is already configured for this
  // scope by the append guard; a second invocation would drop that guard here and a hand-synced
  // copy is worse. A lazy import into a pure fold is a review finding.
  {
    files: [
      "packages/runtime-daemon/src/workspace/projector.ts",
      "packages/runtime-daemon/src/git/worktree/projector.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!@ai-sidekicks/contracts/[\\w-]+(?:/[\\w-]+)*$).*$",
              message:
                "The read-side projectors are pure: @ai-sidekicks/contracts is " +
                "the only import they may carry, because any other specifier " +
                "can reach I/O transitively. Widen this allow-list in " +
                "eslint.config.mjs in the same diff that adds a genuinely pure import.",
            },
          ],
        },
      ],
    },
  },
  // The brief projection floor makes the same purity claim as the projectors above.
  // `hand-over/brief/projection.ts` folds an already-read canonical projection into the brief turn
  // and persists nothing; delivering the brief is `brief/delivery.ts`'s job. The allow-list
  // enumerates specifiers rather than admitting a shape: a relative-path shape would admit
  // `../../db/`, which reaches the database layer and is spelled like the sibling this module
  // legitimately imports.
  //
  // The projectors' replace-not-merge trade and dynamic-`import()` gap apply here unchanged.
  {
    files: ["packages/runtime-daemon/src/provider/hand-over/brief/projection.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(?!(?:@ai-sidekicks/contracts/[\\w-]+(?:/[\\w-]+)*|" +
                "\\.\\./transform-pipeline\\.js|\\.\\./\\.\\./driver/contract\\.js)$).*$",
              message:
                "The brief projection floor is pure: it folds an already-read " +
                "canonical projection into a turn and persists nothing, so its " +
                "imports are the three this allow-list names and nothing else " +
                "— a sibling that reaches the database or the filesystem pulls " +
                "I/O into the fold behind it. Widen this allow-list in " +
                "eslint.config.mjs in the same diff that adds a genuinely pure import.",
            },
          ],
        },
      ],
    },
  },
  // `git/worktree/projector.ts` reports the expiry fields its caller read and derives no expiry of
  // its own, so clock math must be unavailable to it, not merely unwritten. `no-restricted-globals`
  // resolves the identifier, so a locally shadowed `Date` is not reported and a real global read
  // is, which a text scan cannot tell apart.
  //
  // `no-restricted-globals` sees only identifier references, so `globalThis.Date.now()` reaches the
  // same clock past it (measured). The property half beside it closes that, and restates the
  // daemon-wide `randomUUID` entry because this block sits inside that block's scope and flat
  // config would otherwise drop it here.
  {
    files: ["packages/runtime-daemon/src/git/worktree/projector.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "Date",
          message:
            "git/worktree/projector.ts reads no clock — it reports the " +
            "expiry fields its caller handed it and derives no expiry of " +
            "its own. Compute the instant in the caller and pass it in.",
        },
        {
          name: "performance",
          message:
            "git/worktree/projector.ts reads no clock — it reports the " +
            "expiry fields its caller handed it and derives no expiry of " +
            "its own. Compute the instant in the caller and pass it in.",
        },
      ],
      "no-restricted-properties": [
        "error",
        DAEMON_RANDOM_UUID_PROPERTY,
        {
          object: "globalThis",
          property: "Date",
          message:
            "git/worktree/projector.ts reads no clock — reaching `Date` " +
            "through the global object is the same read the identifier ban " +
            "refuses. Compute the instant in the caller and pass it in.",
        },
        {
          object: "globalThis",
          property: "performance",
          message:
            "git/worktree/projector.ts reads no clock — reaching `performance` " +
            "through the global object is the same read the identifier " +
            "ban refuses. Compute the instant in the caller and pass it in.",
        },
      ],
    },
  },
);

export default requireJsxInTsx(repositoryConfig);
