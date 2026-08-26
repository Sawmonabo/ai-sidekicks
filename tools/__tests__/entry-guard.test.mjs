// Entry-guard invariant for every CLI script in the repo that discriminates
// "imported as a module" from "invoked as a command".
//
// THE BUG THIS PINS
// -----------------
// The naive idiom `import.meta.url === \`file://${process.argv[1]}\`` compares a
// percent-ENCODED URL against a raw filesystem path. Any path containing a space
// (or `#`, `?`, non-ASCII) makes the two unequal, so the guard never fires: the
// CLI does nothing, prints nothing, and exits 0. A second axis breaks the
// encoding-correct-but-unnormalised spelling `process.argv[1] === fileURLToPath(...)`:
// an invocation through a symlink (macOS `/tmp` → `/private/tmp`, or a checkout
// under a symlink) also compares unequal.
//
// Both axes produce a SILENT no-op with a success exit code, which for a gate
// script means "reported success having done nothing".
//
// Each script is invoked here through a symlinked directory whose name contains
// a space, so one fixture exercises both axes at once, and asserted to actually
// run. Copying the scripts to a temp directory would break their relative
// imports, so the symlink points at the real repo root.
//
// WHY THE LIST IS ASSERTED COMPLETE
// ---------------------------------
// A hand-maintained fixture list is itself the failure mode this file pins: a
// guarded CLI that nobody adds is simply never spawned, and the suite reports
// clean over a script it did not run. That is exactly what happened — the list
// enumerated only `.mjs` scripts, so the three guarded TypeScript CLIs under
// `tools/docs-corpus/bin/` were invisible to it, `pre-commit-runner.ts` (the
// whole lefthook docs-corpus gate) among them. `the list is complete` below
// re-derives the guarded set from the source tree on every run so the fixture
// cannot silently under-cover again. Catalogued as CAT-10 in
// `docs/operations/failure-mode-catalog.md`.
//
// THE DERIVATION READS CODE, NOT TEXT
// -----------------------------------
// Every earlier revision derived that set by regex over the raw source, and
// each review round found another spelling the regex did not know: first the
// `.mjs` glob, then `process.argv[1]`, then `import.meta.url`, then argv
// reached through a destructuring alias. A hand-chosen textual pattern standing
// in for "this script discriminates invoked from imported" is the registered
// row one level down, and widening it again would only move the next miss.
//
// The source is parsed instead, and the operands are matched as AST nodes. That
// closes the class rather than one more instance: a comment, a string literal,
// and a regex literal are not expressions, so a file can no longer be
// classified by its own PROSE. The old regex could be — which is precisely why
// `__tests__` used to be pruned from the walk, to stop this file's own
// explanatory comments flagging it. Pruning a directory to suppress a wrong
// match is the same defect wearing a disguise: the match was wrong, not the
// directory. Both that prune and the `build` prune are gone, the walk covers
// 297 files where it covered 171, and the derived set is unchanged at nine.

import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A marked table whose column does not sum to its declared Total. Chosen
// because the violation is entirely WITHIN the file: the gate reaches a
// non-zero verdict without resolving any repo-relative path, so it behaves
// identically whether the script is reached through the real root or through
// the spaced symlink. A fixture that cited a real doc would make the assertion
// depend on how each script resolves the repo, which is not what is under test.
const UNBALANCED_TOTAL_FIXTURE = [
  "# Fixture",
  "",
  '<!-- corpus:total-check column="Count" -->',
  "",
  "| Item | Count |",
  "| --- | --- |",
  "| a | 1 |",
  "| b | 1 |",
  "| **Total** | 99 |",
  "",
].join("\n");

// Each entry is invoked with arguments guaranteed to make a RUNNING script exit
// non-zero with a diagnostic. That turns "did the guard fire?" into an
// observable: guard fires => non-zero + diagnostic; guard no-ops => 0 + silence.
//
// `args` is a function of the fixture directory so entries that need a scratch
// input can build an absolute path to it. `nodeOptions` carries the flags a
// script needs to load at all — the TypeScript CLIs are run from source under
// `--experimental-strip-types` exactly as CI and lefthook run them, since a
// guard that only fires under a build step is not the guard those callers use.
const CLI_SCRIPTS = [
  { relativePath: "tools/run-node-tests.mjs", args: () => ["no/such/**/*.test.mjs"] },
  {
    relativePath: ".claude/skills/plan-execution/scripts/post-merge-housekeeper.mjs",
    args: () => [],
  },
  {
    relativePath: ".claude/skills/plan-execution/scripts/rebuild-shipment-manifest.mjs",
    args: () => [],
  },
  {
    relativePath: ".claude/skills/plan-execution/scripts/validate-review-response.mjs",
    args: () => [],
  },
  // Runs as a required CI check (`.github/workflows/docs-corpus.yml`, the
  // plan-cite Gate-4 survey step). A no-op here is a green check over an
  // unrun gate, so this entry is the load-bearing one in the list.
  { relativePath: ".claude/skills/plan-execution/scripts/preflight.mjs", args: () => [] },
  // Carries NO entry guard and needs none: it consults `import.meta.url` only
  // to resolve the repo root and `process.argv` only to parse flags, and
  // exports nothing. It is spawned here anyway, because the invariant this file
  // really pins is "the CLI does not silently no-op when invoked through a
  // hostile path" — worth asserting whether or not a guard mediates it.
  //
  // Listing it is also what lets this file have no exemption channel at all. An
  // earlier revision exempted it and validated the exemption by export count;
  // that proxy would have kept passing if the file later grew a real (and
  // broken) guard while still exporting nothing, and the exemption filter would
  // have hidden it from the comparison below — a false clean manufactured by
  // the very mechanism meant to prevent one (Codex, round 5).
  { relativePath: ".claude/skills/plan-execution/scripts/codex-gate.mjs", args: () => [] },
  // The lefthook pre-commit docs-corpus gate. A silent no-op here disables
  // every pre-commit corpus check at once, which makes this the highest-blast-
  // radius guard in the repo.
  {
    relativePath: "tools/docs-corpus/bin/pre-commit-runner.ts",
    nodeOptions: ["--experimental-strip-types"],
    args: (fixtureDirectory) => [join(fixtureDirectory, "unbalanced-total.md")],
  },
  {
    relativePath: "tools/docs-corpus/bin/table-total-check.ts",
    nodeOptions: ["--experimental-strip-types"],
    args: (fixtureDirectory) => [join(fixtureDirectory, "unbalanced-total.md")],
  },
  // Reads its inputs from PR_TITLE / PR_BRANCH and the changed-file list on fd
  // 0, so the failing invocation is a malformed JSON line rather than a bad
  // argument. Writes its diagnostic to stdout, not stderr — hence the combined
  // -stream assertion below.
  {
    relativePath: "tools/docs-corpus/bin/lane-boundary-check.ts",
    nodeOptions: ["--experimental-strip-types"],
    args: () => [],
    stdin: "{\n",
    env: { PR_TITLE: "chore(repo): entry-guard fixture", PR_BRANCH: "chore/entry-guard-fixture" },
  },
];

// Node prints an ExperimentalWarning to stderr for `--experimental-strip-types`
// whether or not the script body ever runs, so an unfiltered stderr check would
// pass for a no-op TypeScript CLI — the exact false clean this file exists to
// catch. Strip the interpreter's own chatter before asserting the script spoke.
function withoutInterpreterWarnings(streamText) {
  return (streamText ?? "")
    .split("\n")
    .filter((line) => !/^\(node:\d+\)/.test(line) && !/^\(Use `node --trace-warnings/.test(line))
    .join("\n")
    .trim();
}

/**
 * Symlink the repo under a directory name containing a space.
 *
 * The symlink is unlinked explicitly before the containing directory is removed:
 * a recursive delete over a link pointing at the working repo is not a risk worth
 * taking on the strength of "fs.rm does not follow symlinks".
 */
function withSpacedSymlinkedRepo(runBody) {
  const containingDirectory = mkdtempSync(join(tmpdir(), "entry-guard-"));
  const spacedRepoLink = join(containingDirectory, "repo root with spaces");
  symlinkSync(REPO_ROOT, spacedRepoLink, "dir");
  writeFileSync(join(containingDirectory, "unbalanced-total.md"), UNBALANCED_TOTAL_FIXTURE);
  try {
    return runBody(spacedRepoLink, containingDirectory);
  } finally {
    unlinkSync(spacedRepoLink);
    rmSync(containingDirectory, { recursive: true, force: true });
  }
}

test("the fixture path genuinely exercises the encoding axis", () => {
  // Without this, a tmpdir that happened to contain no space would leave every
  // test below passing while proving nothing about the bug.
  withSpacedSymlinkedRepo((spacedRepoLink) => {
    const scriptPath = join(spacedRepoLink, "tools/run-node-tests.mjs");
    assert.notEqual(
      `file://${scriptPath}`,
      pathToFileURL(scriptPath).href,
      "fixture path must differ between naive concatenation and correct URL encoding",
    );
    assert.match(pathToFileURL(scriptPath).href, /%20/);
  });
});

for (const { relativePath, args, nodeOptions = [], stdin = "", env } of CLI_SCRIPTS) {
  test(`${relativePath}: does not silently no-op through a spaced, symlinked path`, () => {
    withSpacedSymlinkedRepo((spacedRepoLink, fixtureDirectory) => {
      const scriptPath = join(spacedRepoLink, relativePath);
      assert.ok(existsSync(scriptPath), `fixture script missing: ${scriptPath}`);

      const result = spawnSync(
        process.execPath,
        [...nodeOptions, scriptPath, ...args(fixtureDirectory)],
        { encoding: "utf8", input: stdin, env: { ...process.env, ...env } },
      );

      assert.notEqual(
        result.status,
        0,
        `${relativePath} exited 0 through a spaced/symlinked path — the entry guard did not fire, ` +
          "so the CLI silently did nothing",
      );
      const diagnostic =
        `${withoutInterpreterWarnings(result.stdout)}\n${withoutInterpreterWarnings(
          result.stderr,
        )}`.trim();
      assert.notEqual(
        diagnostic,
        "",
        `${relativePath} produced no diagnostic — a silent no-op is exactly the guard failure`,
      );
    });
  });
}

// Directories that hold no first-party source: dependency trees, build output,
// coverage reports, and sibling checkouts. `build` is deliberately absent —
// `apps/desktop/build/assert-webprefs.ts` is tracked source invoked by two
// `package.json` scripts, so pruning on that NAME hid a real source directory
// from the walk (Codex, round 6). `__tests__` is absent for the reason given in
// the header: it existed only to suppress a text match that no longer happens.
const SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".turbo",
  ".worktrees",
]);
const SOURCE_EXTENSIONS = /\.(mjs|cjs|js|ts|mts|cts|tsx)$/;

const SCRIPT_KIND_BY_EXTENSION = new Map([
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
  [".js", ts.ScriptKind.JS],
]);

/**
 * Report which of a guard's two operands a source file actually evaluates.
 *
 * A script that discriminates "imported as a module" from "invoked as a
 * command" has to consult BOTH its own module URL and the path it was invoked
 * as. `import.meta.main` is the exception: it IS the whole comparison and takes
 * no second operand, so it is reported on its own channel.
 *
 * Each operand is matched as a FAMILY of expressions rather than as one
 * spelling, because every spelling-specific predicate this file has carried was
 * eventually evaded by an equivalent idiom. The invoked-path family covers
 * member access (`process.argv`), computed access (`process["argv"]`), object
 * destructuring off `process` (renamed bindings included), and a named import
 * from `node:process`. The self-reference family covers `import.meta.url` and
 * `import.meta.filename`.
 *
 * Over-inclusion is the deliberate trade: a file that consults both operands
 * for unrelated reasons is reported as guarded, joins the fixture list, and
 * earns the same does-it-actually-run assertion. Under-inclusion is the one
 * failure that matters, because it is silent.
 */
function classifyGuardOperands(sourceText, scriptKind) {
  const sourceFile = ts.createSourceFile(
    "guard-probe",
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKind,
  );
  let readsWholeGuard = false;
  let readsSelfReference = false;
  let readsInvokedPath = false;

  const isImportMeta = (node) => ts.isMetaProperty(node) && node.name.text === "meta";
  const isProcess = (node) => ts.isIdentifier(node) && node.text === "process";

  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      if (isImportMeta(node.expression)) {
        if (node.name.text === "main") readsWholeGuard = true;
        else if (node.name.text === "url" || node.name.text === "filename") {
          readsSelfReference = true;
        }
      }
      if (isProcess(node.expression) && node.name.text === "argv") readsInvokedPath = true;
    }
    if (
      ts.isElementAccessExpression(node) &&
      isProcess(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "argv"
    ) {
      readsInvokedPath = true;
    }
    // `const { argv } = process` / `const { argv: invokedArguments } = process`
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isProcess(node.initializer) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const element of node.name.elements) {
        const boundName = element.propertyName ?? element.name;
        if (ts.isIdentifier(boundName) && boundName.text === "argv") readsInvokedPath = true;
      }
    }
    // `import { argv } from "node:process"`
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      const namedBindings = node.importClause?.namedBindings;
      if (
        (moduleName === "node:process" || moduleName === "process") &&
        namedBindings &&
        ts.isNamedImports(namedBindings)
      ) {
        for (const element of namedBindings.elements) {
          if ((element.propertyName ?? element.name).text === "argv") readsInvokedPath = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { readsWholeGuard, readsSelfReference, readsInvokedPath };
}

function consultsBothGuardOperands(sourceText, scriptKind) {
  const { readsWholeGuard, readsSelfReference, readsInvokedPath } = classifyGuardOperands(
    sourceText,
    scriptKind,
  );
  return readsWholeGuard || (readsSelfReference && readsInvokedPath);
}

// The derivation's own negative control, and the one this file lacked while it
// was regex-based: every claim the comment above makes is asserted here against
// a snippet, in BOTH directions. The three `false` rows carrying the operand
// names inside a comment, a string, and a regex are the load-bearing ones — a
// text matcher passes all three, which is how a file could be classified as a
// guarded CLI without containing a guard, and how a real guard could be deleted
// while its explanatory comment kept the classification alive.
const CLASSIFIER_CONTROLS = [
  ["subscripted argv", "import.meta.url === toUrl(process.argv[1]);", true],
  ["assigned argv alias", "const argv = process.argv;\nimport.meta.url === argv[1];", true],
  ["destructured argv", "const { argv } = process;\nimport.meta.url === argv[1];", true],
  [
    "renamed destructured argv",
    "const { argv: invoked } = process;\nimport.meta.filename === invoked[1];",
    true,
  ],
  ["computed argv access", 'import.meta.url === process["argv"][1];', true],
  ["named argv import", 'import { argv } from "node:process";\nimport.meta.url === argv[1];', true],
  ["import.meta.main alone", "if (import.meta.main) main();", true],
  ["import.meta.filename", "import.meta.filename === process.argv[1];", true],
  [
    "operands named only in a comment",
    "// import.meta.url and process.argv\nexport const x = 1;",
    false,
  ],
  ["operands named only in a string", 'const help = "import.meta.url vs process.argv";', false],
  [
    "operands named only in a regex",
    "const p = /import\\.meta\\.url/;\nconst q = /process\\.argv/;",
    false,
  ],
  ["self-reference without argv", "const here = dirname(fileURLToPath(import.meta.url));", false],
  ["argv without self-reference", "const flags = process.argv.slice(2);", false],
];

test("the guarded-set derivation reads code, not comments or strings", () => {
  for (const [label, snippet, expected] of CLASSIFIER_CONTROLS) {
    assert.equal(
      consultsBothGuardOperands(snippet, ts.ScriptKind.JS),
      expected,
      `classifier disagreed on "${label}" — expected ${expected}. A derivation that ` +
        "cannot distinguish an evaluated operand from a mention of one silently decides " +
        "which CLIs this suite covers",
    );
  }
});

function collectSourceFiles(directory, collected) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      collectSourceFiles(join(directory, entry.name), collected);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
      collected.push(join(directory, entry.name));
    }
  }
  return collected;
}

// Negative control on the scan, expressed PER ROOT. One global threshold is
// carried by whichever root is largest, and here that is `packages/`, which
// holds ZERO guarded CLIs — so losing `tools/` outright, 4 of the 9 guards
// including `pre-commit-runner.ts`, still left a large majority of the walk and
// sailed past a global count check. The floor was guarding the root that
// mattered least.
//
// Each floor sits well below today's count and far enough above zero that a
// root which stops resolving does trip it. Re-derived 2026-08-25 against the
// tracked tree: tools 38, .claude 30, packages 266, apps 26. The figures
// carried here before that date (tools 28, .claude 29, packages 211, apps 29)
// had drifted well past any one change. Do not treat these as assertions —
// `apps` in particular is build-state dependent, because `apps/desktop/out/` is
// gitignored but is NOT in SKIPPED_DIRECTORY_NAMES, so a walk after a build
// counts roughly twenty more files there than a clean checkout does. The floors
// below are the only enforced numbers.
const SEARCH_ROOT_FLOORS = { tools: 12, ".claude": 12, packages: 90, apps: 12 };

test("the list is complete — every guarded CLI in the tree is spawned above", () => {
  const candidates = [];
  for (const [rootName, floor] of Object.entries(SEARCH_ROOT_FLOORS)) {
    const rootPath = join(REPO_ROOT, rootName);
    // Assert, never filter. `.filter(existsSync)` silently shrank the scan when
    // a root was renamed, which is the same false clean the floors exist to
    // catch — a smaller walk that still reports complete.
    assert.ok(
      existsSync(rootPath),
      `search root ${rootName}/ does not exist — it was renamed or removed. Update ` +
        "SEARCH_ROOT_FLOORS deliberately; dropping it silently would narrow this scan while " +
        "it still claims to cover the tree",
    );
    const found = collectSourceFiles(rootPath, []);
    assert.ok(
      found.length >= floor,
      `source scan found only ${found.length} file(s) under ${rootName}/ (floor ${floor}) — ` +
        "the walk is broken for that root, so a clean result here would prove nothing",
    );
    candidates.push(...found);
  }

  // `classifyGuardOperands` is the whole derivation, and the control table above
  // is what licenses trusting it here. There is deliberately NO exemption
  // channel: an exemption can only be validated by some proxy for "carries no
  // guard", and a proxy that drifts produces exactly the false clean this file
  // exists to prevent (Codex, round 5).
  const guardedPaths = candidates
    .filter((absolutePath) =>
      consultsBothGuardOperands(
        readFileSync(absolutePath, "utf8"),
        SCRIPT_KIND_BY_EXTENSION.get(extname(absolutePath)),
      ),
    )
    .map((absolutePath) => relative(REPO_ROOT, absolutePath).split(sep).join("/"))
    .sort();

  const listedPaths = CLI_SCRIPTS.map((entry) => entry.relativePath).sort();

  const unlisted = guardedPaths.filter((path) => !listedPaths.includes(path));
  assert.deepEqual(
    unlisted,
    [],
    "guarded CLI(s) missing from CLI_SCRIPTS — add each to the fixture list with arguments " +
      "that make a RUNNING script exit non-zero, otherwise this suite reports clean over a " +
      `script it never spawns:\n  ${unlisted.join("\n  ")}`,
  );

  // The converse: an entry naming a script that stopped consulting either
  // operand — deleted, or rewritten into a plain module — is a fixture whose
  // subject has moved out from under it.
  //
  // This assertion's message says what its predicate ESTABLISHES and no more.
  // It used to read "no longer carries an entry guard", which claimed a
  // detection the derivation cannot perform: a script that keeps a real
  // `process.argv` read for flag parsing still consults both operands after its
  // guard conditional is deleted, so removal of a guard from a listed script
  // does not surface here. Under-detection stated as detection is this PR's own
  // subject; the honest scope is written into the text rather than left for a
  // reader to discover (Codex, round 6).
  const stale = listedPaths.filter((path) => !guardedPaths.includes(path));
  assert.deepEqual(
    stale,
    [],
    "CLI_SCRIPTS names script(s) that no longer consult both guard operands — the entry's " +
      `subject changed or the file was removed:\n  ${stale.join("\n  ")}`,
  );
});
