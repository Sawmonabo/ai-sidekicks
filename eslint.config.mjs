// ESLint flat config. It uses only non-type-aware rules, so lint-staged feedback stays sub-second.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * The daemon's `randomUUID` property ban, hoisted so a second block that configures
 * `no-restricted-properties` for a daemon file can restate it. Flat config replaces a rule's
 * options at the last matching config object, so the `worktree-projector.ts` clock block below
 * would otherwise drop the v4 ban for that file.
 */
const DAEMON_RANDOM_UUID_PROPERTY = {
  property: "randomUUID",
  message:
    "crypto.randomUUID() emits UUID v4. Daemon persisted-row ids and event ids must mint through mintUuidV7 (packages/runtime-daemon/src/ids/uuid-v7.ts), which the contracts package's ID-format rule requires. An id that is genuinely an ephemeral token — no row and no event stores it — earns an entry in the exemption block beside this one, reviewed on the diff that adds it.",
};

/**
 * The enum ban, exported so a package config that sets `no-restricted-syntax` for its own
 * files restates it: flat config replaces a rule's options at the last matching object.
 */
export const ENUM_DECLARATION = {
  selector: "TSEnumDeclaration",
  message:
    "Do not use TypeScript enums in application or domain code. Use a string-literal union, an `as const` object with its derived union, or a discriminated union. An enum an external contract requires stays at that boundary and is translated there.",
};

export default tseslint.config(
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
  // Every authored TypeScript file carries the enum ban. A declaration file is ambient
  // and holds no runtime code.
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    ignores: ["**/*.d.ts"],
    rules: { "no-restricted-syntax": ["error", ENUM_DECLARATION] },
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
  // block, not a global ignore.)
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
  // `event-core.ts` is the acyclic leaf of the contracts module graph. `event.ts` imports it, so an
  // import back into `./event.js` re-closes the cycle; under Vite's SSR transform a module-scope
  // read of the uninitialized binding is `undefined` rather than a throw, so the breakage is silent
  // until a payload-schema union branch fails to construct.
  //
  // Carried on `no-restricted-syntax`, not `no-restricted-imports`: the block above already
  // configures `no-restricted-imports` for every contracts source file, and flat config replaces a
  // rule's options at the last matching object, so a second invocation would drop the `node:*` ban
  // for this file. All four edge-carrying forms are denied: static import, dynamic import, and both
  // `export … from` shapes.
  {
    files: ["packages/contracts/src/event-core.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ENUM_DECLARATION,
        {
          selector: 'ImportDeclaration[source.value="./event.js"]',
          message:
            "event-core.ts is the acyclic leaf of the contracts module graph — importing ./event.js from it closes an import cycle, which can leave a module-scope schema undefined with no error.",
        },
        {
          selector: 'ImportExpression[source.value="./event.js"]',
          message:
            "event-core.ts is the acyclic leaf of the contracts module graph — a dynamic import of ./event.js closes the cycle just as the static form does.",
        },
        {
          selector: 'ExportNamedDeclaration[source.value="./event.js"]',
          message:
            "event-core.ts is the acyclic leaf of the contracts module graph — re-exporting from ./event.js closes the cycle exactly as importing it does.",
        },
        {
          selector: 'ExportAllDeclaration[source.value="./event.js"]',
          message:
            "event-core.ts is the acyclic leaf of the contracts module graph — re-exporting from ./event.js closes the cycle exactly as importing it does.",
        },
      ],
    },
  },
  // `SessionService.append` is the test-seeding append: it writes a caller-sequenced row outside
  // the append lock, with no sealing and no size ceiling, so tests may seed through it and
  // production code never may. The nominal `TestSeedingAppendToken` cannot be manufactured from
  // config or env data, but in-package code could still gate a `forTestsOnly()` call behind an
  // environment check. This rule closes that: outside `__tests__/`, runtime-daemon sources may not
  // call or name the factory, in static and computed (`["forTestsOnly"]`) member forms. An
  // aliased-class bypass is left to review, where the loud name is the signal (see the token's
  // class doc in `session/session-service.ts`).
  {
    files: ["packages/runtime-daemon/src/**/*.ts"],
    ignores: ["packages/runtime-daemon/src/**/__tests__/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ENUM_DECLARATION,
        {
          selector:
            "MemberExpression[object.name='TestSeedingAppendToken'][property.name='forTestsOnly']",
          message:
            "TestSeedingAppendToken.forTestsOnly() is TEST-ONLY: it lets a test seed events through SessionService.append, which writes outside the append lock with no sealing, and production code must never enable it. Durable writes belong to EventLogService.append.",
        },
        {
          selector:
            "MemberExpression[object.name='TestSeedingAppendToken'][property.value='forTestsOnly']",
          message:
            "TestSeedingAppendToken['forTestsOnly'] is TEST-ONLY: it lets a test seed events through SessionService.append, which writes outside the append lock with no sealing, and production code must never enable it. Durable writes belong to EventLogService.append.",
        },
      ],
    },
  },
  // `crypto.randomUUID()` emits a v4 UUID: 122 random bits, no time ordering. Daemon-assigned ids
  // are UUID v7 (contracts `session.ts` and `event.ts`), and the wire schemas accept any version on
  // purpose (control-plane rows are Postgres `gen_random_uuid()` v4), so nothing downstream rejects
  // a v4 and a factory written the old way is wrong and silent. Every daemon persisted-row id and
  // event id mints through `mintUuidV7` (`src/ids/uuid-v7.ts`).
  //
  // Carried on `no-restricted-properties` and `no-restricted-imports`: the block above owns
  // `no-restricted-syntax` for this scope, and flat config replaces a rule's options at the last
  // matching object, so these selectors there would drop the test-seeding guard.
  // `no-restricted-properties` with a bare `property` restricts `.randomUUID` on any object
  // (global, namespaced, `globalThis`-qualified); `no-restricted-imports` with `importNames` denies
  // the named import while leaving `createHash` and `randomBytes` available.
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
  // The four daemon modules that mint an ephemeral token (a correlation id, a subscription handle,
  // a PTY handle, a scratch filename): no row or event stores it and nothing sorts a set of them,
  // so uniqueness is the whole requirement and v4 supplies it. Each is exempt as a file, the
  // granularity a lint rule has, so a second mint added inside one of them passes lint and is
  // caught in review; that is why the set stays at four. Only the two rules above are turned off;
  // the test-seeding guard is unaffected.
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
  // The two read-side projectors are pure: no database, no temp directory, no clock; each is a
  // side-effect-free fold over already-read rows. The realistic purity break is a sibling import (a
  // service module, the database layer) that pulls I/O in behind it, not a direct `node:fs` import,
  // so the rule is an allow-list (negative-lookahead `regex`) rather than a denylist of builtins:
  // `@ai-sidekicks/contracts`, itself held isomorphic above, is the one permitted specifier. A
  // legitimately pure new import widens the pattern in the same diff.
  //
  // This block replaces the daemon-wide `no-restricted-imports` options for these two files, which
  // is fine: the allow-list forbids `node:crypto` outright, so it is stronger than the `randomUUID`
  // import ban it displaces, and the `no-restricted-properties` half of that guard still applies.
  //
  // Known gap: `no-restricted-imports` does not see a dynamic `import("node:fs")` (measured on
  // ESLint 10.2.1), and the `no-restricted-syntax` rule that could is already configured for this
  // scope by the append guard; a second invocation would drop that guard here and a hand-synced
  // copy is worse. A lazy import into a pure fold is a review finding.
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
                "The read-side projectors are pure: @ai-sidekicks/contracts is the only import they may carry, because any other specifier can reach I/O transitively. Widen this allow-list in eslint.config.mjs in the same diff that adds a genuinely pure import.",
            },
          ],
        },
      ],
    },
  },
  // The memo projection floor makes the same purity claim as the projectors above.
  // `memo-projection.ts` folds an already-read canonical projection into the memo turn and persists
  // nothing; delivering the memo is `memo-delivery.ts`'s job. The allow-list enumerates specifiers
  // rather than admitting a shape: a relative-path shape would admit `../../db/`, which reaches the
  // database layer and is spelled like the sibling this module legitimately imports.
  //
  // The projectors' replace-not-merge trade and dynamic-`import()` gap apply here unchanged.
  {
    files: ["packages/runtime-daemon/src/provider/transcript/memo-projection.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(?!(?:@ai-sidekicks/contracts|@noble/hashes/blake3\\.js|@noble/hashes/utils\\.js|\\./transform-pipeline\\.js)$).*$",
              message:
                "The memo projection floor is pure: it folds an already-read canonical projection into a turn and persists nothing, so its imports are the four this allow-list names and nothing else — a sibling that reaches the database or the filesystem pulls I/O into the fold behind it. Widen this allow-list in eslint.config.mjs in the same diff that adds a genuinely pure import.",
            },
          ],
        },
      ],
    },
  },
  // `worktree-projector.ts` reports the expiry fields its caller read and derives no expiry of its
  // own, so clock math must be unavailable to it, not merely unwritten. `no-restricted-globals`
  // resolves the identifier, so a locally shadowed `Date` is not reported and a real global read
  // is, which a text scan cannot tell apart.
  //
  // `no-restricted-globals` sees only identifier references, so `globalThis.Date.now()` reaches the
  // same clock past it (measured). The property half beside it closes that, and restates the
  // daemon-wide `randomUUID` entry because this block sits inside that block's scope and flat
  // config would otherwise drop it here.
  {
    files: ["packages/runtime-daemon/src/git/worktree-projector.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "Date",
          message:
            "worktree-projector.ts reads no clock — it reports the expiry fields its caller handed it and derives no expiry of its own. Compute the instant in the caller and pass it in.",
        },
        {
          name: "performance",
          message:
            "worktree-projector.ts reads no clock — it reports the expiry fields its caller handed it and derives no expiry of its own. Compute the instant in the caller and pass it in.",
        },
      ],
      "no-restricted-properties": [
        "error",
        DAEMON_RANDOM_UUID_PROPERTY,
        {
          object: "globalThis",
          property: "Date",
          message:
            "worktree-projector.ts reads no clock — reaching `Date` through the global object is the same read the identifier ban refuses. Compute the instant in the caller and pass it in.",
        },
        {
          object: "globalThis",
          property: "performance",
          message:
            "worktree-projector.ts reads no clock — reaching `performance` through the global object is the same read the identifier ban refuses. Compute the instant in the caller and pass it in.",
        },
      ],
    },
  },
);
