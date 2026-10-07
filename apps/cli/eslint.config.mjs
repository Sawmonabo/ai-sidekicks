// Package-scoped ESLint flat config for `@ai-sidekicks/cli`.
//
// A command reaches the daemon only through the client SDK and the contracts, so source imports
// those, commander and Node's built-ins, and nothing else: never the daemon, the control plane or
// the desktop app. A command's result goes to the context's `stdout` and every diagnostic to its
// `stderr`, so tests can collect both; only `src/main.ts` touches the real process streams.
//
// This config spreads the root `eslint.config.mjs` first and inherits its baselines. Flat config
// replaces a rule's options at the last matching object, so source and test files each get exactly
// one `no-restricted-imports` block (its depth's, from the shared constants below), and the source
// block restates the root's `no-restricted-syntax` bans beside its own.
import { defineConfig } from "eslint/config";
import root, {
  ENUM_DECLARATION,
  EXPORT_ALL_DECLARATION,
  requireJsxInTsx,
} from "../../eslint.config.mjs";

/** Every source file of the command line, tests included. */
const SOURCE_FILES = ["src/**/*.ts"];

/**
 * The deepest folder nesting under `src/` the depth blocks cover; a file nested deeper keeps the
 * source block's import rule, which refuses every import.
 */
const DEEPEST_SOURCE_NESTING = 8;

/**
 * A normalized relative specifier that climbs at most `parentSteps` folders: `./name` or
 * `../name` and so on, with no `.` or `..` segment after the first named one. A file `n` folders
 * below `src/` reaches this package's root in `n + 1` steps, so one more would leave the package.
 */
function relativeSpecifierWithin(parentSteps) {
  const namedSegment = "(?!\\.\\.?(?:/|$))[^/]+";
  return `(?:\\./|(?:\\.\\./){1,${parentSteps}})(?:${namedSegment}/)*${namedSegment}`;
}

/** The package specifiers source may import. */
const ALLOWED_PACKAGE_SPECIFIERS = [
  "@ai-sidekicks/contracts/[\\w-]+(?:/[\\w-]+)*",
  "@ai-sidekicks/client-sdk",
  "commander",
  "node:[\\w/]+",
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
        {
          name: "node:module",
          importNames: ["createRequire"],
          message: "No createRequire: a require() call escapes the import allow-list.",
        },
      ],
      patterns: [
        {
          regex: `^(?!(?:${allowedSpecifiers.join("|")})$).*$`,
          message:
            "The command line imports only @ai-sidekicks/contracts/<module>, " +
            "@ai-sidekicks/client-sdk, commander, node: built-ins and its own files inside " +
            "apps/cli: it reaches the daemon through the client SDK, never the daemon, control " +
            "plane or desktop app.",
        },
      ],
    },
  ];
}

/**
 * One block per nesting depth under `src/`, because a relative specifier stays inside the
 * package only up to that depth's number of parent steps; test files also import the test runner.
 */
const IMPORT_BLOCKS = Array.from({ length: DEEPEST_SOURCE_NESTING + 1 }, (_, nesting) => {
  const folder = ["src", ...Array.from({ length: nesting }, () => "*")].join("/");
  const allowed = [...ALLOWED_PACKAGE_SPECIFIERS, relativeSpecifierWithin(nesting + 1)];
  return [
    {
      files: [`${folder}/*.ts`],
      rules: { "no-restricted-imports": restrictImportsTo(allowed) },
    },
    {
      files: [`${folder}/*.test.ts`],
      rules: { "no-restricted-imports": restrictImportsTo([...allowed, "vitest"]) },
    },
  ];
}).flat();

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
      "no-restricted-imports": restrictImportsTo([]),
      "no-restricted-syntax": ["error", ENUM_DECLARATION, EXPORT_ALL_DECLARATION, DYNAMIC_IMPORT],
      "no-console": "error",
    },
  },
  ...IMPORT_BLOCKS,
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
        {
          object: "process",
          property: "getBuiltinModule",
          message:
            "No process.getBuiltinModule: it loads a module the import allow-list never sees.",
        },
      ],
    },
  },
);

export default requireJsxInTsx(cliConfig);
