// Package-scoped ESLint flat config for `@ai-sidekicks/cli`.
//
// A command reaches the daemon only through the client SDK and the contracts, so source imports
// those, commander and Node's built-ins, and nothing else: never the daemon, the control plane or
// the desktop app. A command's result goes to the context's `stdout` and every diagnostic to its
// `stderr`, so tests can collect both; only `src/main.ts` touches the real process streams.
//
// This config spreads the root `eslint.config.mjs` first and inherits its baselines. Flat config
// replaces a rule's options at the last matching object, so source and test files each get exactly
// one `no-restricted-imports` block, built from the shared constants below, and the source block
// restates the root's `no-restricted-syntax` bans beside its own.
import { defineConfig } from "eslint/config";
import root, {
  ENUM_DECLARATION,
  EXPORT_ALL_DECLARATION,
  requireJsxInTsx,
} from "../../eslint.config.mjs";

/** Every source file of the command line, tests included. */
const SOURCE_FILES = ["src/**/*.ts"];

/** The test files, which also import the test runner. */
const TEST_FILES = ["src/**/*.test.ts"];

/**
 * A relative specifier of any depth that names no folder found only outside this package: `apps`,
 * `packages`, `desktop`, `tools` or `node_modules`.
 */
const RELATIVE_INSIDE_PACKAGE =
  "\\.\\.?(?:/(?!(?:apps|packages|desktop|tools|node_modules)(?:/|$))[^/]+)+";

/** The specifiers source may import. */
const ALLOWED_SPECIFIERS = [
  "@ai-sidekicks/contracts/[\\w-]+(?:/[\\w-]+)*",
  "@ai-sidekicks/client-sdk",
  "commander",
  "node:[\\w/]+",
  RELATIVE_INSIDE_PACKAGE,
];

/** Builds the one `no-restricted-imports` entry for files that may import `allowedSpecifiers`. */
function restrictImportsTo(allowedSpecifiers) {
  return [
    "error",
    {
      paths: [
        {
          name: "node:process",
          importNames: ["stdout", "stderr"],
          message:
            "Write a result to the context's `stdout` and a diagnostic to its `stderr`; only " +
            "src/main.ts reads the real process streams.",
        },
      ],
      patterns: [
        {
          regex: `^(?!(?:${allowedSpecifiers.join("|")})$).*$`,
          message:
            "The command line imports only @ai-sidekicks/contracts/<module>, " +
            "@ai-sidekicks/client-sdk, commander, node: built-ins and its own files: it reaches " +
            "the daemon through the client SDK, never the daemon, control plane or desktop app.",
        },
      ],
    },
  ];
}

/** A dynamic `import()`, which `no-restricted-imports` does not check. */
const DYNAMIC_IMPORT = {
  selector: "ImportExpression",
  message:
    "No dynamic import(): the import allow-list checks only static imports, so every import " +
    "is written statically.",
};

const cliConfig = defineConfig(
  ...root,
  {
    files: SOURCE_FILES,
    rules: {
      "no-restricted-imports": restrictImportsTo(ALLOWED_SPECIFIERS),
      "no-restricted-syntax": ["error", ENUM_DECLARATION, EXPORT_ALL_DECLARATION, DYNAMIC_IMPORT],
      "no-console": "error",
    },
  },
  {
    files: TEST_FILES,
    rules: { "no-restricted-imports": restrictImportsTo([...ALLOWED_SPECIFIERS, "vitest"]) },
  },
  {
    files: SOURCE_FILES,
    ignores: ["src/main.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        ...["stdout", "stderr"].map((property) => ({
          object: "process",
          property,
          message:
            "Write through the context's streams; only src/main.ts reads the real process streams.",
        })),
      ],
    },
  },
);

export default requireJsxInTsx(cliConfig);
