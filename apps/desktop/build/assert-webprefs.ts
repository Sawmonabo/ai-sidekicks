// Build-time assertion: every Spec-023 §Security Hardening Baseline-locked
// `webPreferences` key still appears with the required literal value in
// `apps/desktop/src/main/window.ts`, and that locked block appears EXACTLY
// ONCE. Drift fails the build.
//
// `Plan-023 §Done Checklist`: "Build-time assertion script
// (`assert-webprefs.ts`) greps the factory for each value and fails the build
// on drift."
//
// `Spec-023 §Pitfalls To Avoid`: `nodeIntegration: true` or
// `sandbox: false` MUST be a build-time error.
//
// The exactly-once conjunct (Plan-023 T-023p-1B-2) is what keeps the check
// honest now that the module builds MORE THAN ONE KIND OF WINDOW. A presence
// check alone is satisfied by the main window's block while a second factory
// carries an unchecked one beside it — `sandbox: false` in an auxiliary window
// would be a build-time PASS. Counting both the locked block and the
// `new BrowserWindow(` call sites closes that: the module is required to have
// exactly one of each, which is the structural form of "one private function
// owns the literal" (Plan-023 I-023-2, I-023-12).
//
// The exactly-once count is scoped to ONE FILE, though, and a count in one file
// says nothing about a second file. `src/main/menu.ts` could construct a window
// of its own tomorrow, or a Tier-8 module could, and every assertion above would
// still pass while an unlocked window shipped. So the check also SCANS THE WHOLE
// `src/main/**` TREE (Codex round 1) and requires that `new BrowserWindow(`
// appears in the locked module and nowhere else. That is the conjunct that makes
// "one private function owns the literal" a property of the PROCESS rather than
// of one file — every window this main process can construct is constructed by
// the block the checks above verify. Test files are scanned too: a unit test
// mocks `electron`, so a real construction in one would be as much of an escape
// hatch as a production one, and excluding them would be an exemption keyed on a
// filename rather than on a behavior.
//
// Regex-based matching (not literal-string) tolerates Prettier-driven
// quote-style or whitespace drift while still catching semantic drift.
// Each missing match produces a distinct error message naming the key.
//
// Runtime: invoked via `node --experimental-strip-types` from `pnpm build`.
// No deps beyond the Node standard library. An optional first argument names
// the file to check, so `build/assert-webprefs.test.ts` can drive the real
// script over fixtures instead of re-implementing its rules inline.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_WINDOW_TS_PATH = path.resolve(__dirname, "../src/main/window.ts");

/**
 * Extensions the tree scan reads. A `.d.ts` declares and never constructs, and
 * anything else in the tree (a `tsconfig.json`, say) is not source.
 */
const SCANNED_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];

/** The construction the tree scan hunts for outside the locked module. */
const CONSTRUCTION_PATTERN = /\bnew\s+BrowserWindow\s*\(/g;

interface LockedCheck {
  readonly key: string;
  readonly required: string;
  readonly pattern: RegExp;
}

interface CountedCheck {
  readonly description: string;
  readonly pattern: RegExp;
  readonly expected: number;
}

// `Spec-023 §Security Hardening Baseline` (verbatim):
//
//   contextIsolation: true,          // must be true
//   sandbox: true,                   // must be true
//   nodeIntegration: false,          // must be false
//   nodeIntegrationInWorker: false,  // must be false
//   webSecurity: true,               // must be true
//   preload: '<absolute path>',      // preload script registered here
const CHECKS: readonly LockedCheck[] = [
  {
    key: "contextIsolation",
    required: "true",
    pattern: /\bcontextIsolation\s*:\s*true\b/,
  },
  {
    key: "sandbox",
    required: "true",
    pattern: /\bsandbox\s*:\s*true\b/,
  },
  {
    key: "nodeIntegration",
    required: "false",
    pattern: /\bnodeIntegration\s*:\s*false\b/,
  },
  {
    key: "nodeIntegrationInWorker",
    required: "false",
    pattern: /\bnodeIntegrationInWorker\s*:\s*false\b/,
  },
  {
    key: "webSecurity",
    required: "true",
    pattern: /\bwebSecurity\s*:\s*true\b/,
  },
  {
    // `preload` is a computed absolute path; we only assert that the key is
    // present with a non-empty RHS (any identifier or expression).
    key: "preload",
    required: "<absolute path>",
    pattern: /\bpreload\s*:\s*\S/,
  },
];

const SINGLETON_CHECKS: readonly CountedCheck[] = [
  {
    description: "a `webPreferences: { … }` object literal",
    pattern: /\bwebPreferences\s*:\s*\{/g,
    expected: 1,
  },
  {
    description: "a `new BrowserWindow(…)` construction",
    pattern: /\bnew\s+BrowserWindow\s*\(/g,
    expected: 1,
  },
];

// Blank out comments AND literal bodies in the loaded source before applying
// the regex set, preserving byte length so nothing else has to be re-indexed.
// The header documentation block in `window.ts` cites Spec-023's locked values
// verbatim (e.g. `sandbox: true`, `nodeIntegration: false`) as in-code
// references — without sanitization the regex could match those comment
// occurrences instead of the live `webPreferences` object literal, defeating
// `Spec-023 §Pitfalls To Avoid`.
//
// String and template literals are blanked too, which closes the check in both
// directions at once. A naive `//`-to-end-of-line regex eats the tail of any
// line holding a URL string, so an inlined
// `"sidekicks-renderer://app/index.html"` could hide a locked key that follows
// it and fail a compliant file; and text left INSIDE a string is text a
// presence check will happily match, so a diagnostic message reading
// `"… sandbox: true …"` would satisfy the lock while the live block set
// `sandbox: false` — a false PASS, the one direction this script may never
// take. Neither is reachable once literal bodies are neither comment starts nor
// matchable content.
function blankOutSourceNoise(source: string): string {
  const characters = source.split("");
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        characters[index] = " ";
        index += 1;
      }
      continue;
    }

    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let blank = index; blank < stop; blank += 1) {
        if (characters[blank] !== "\n") {
          characters[blank] = " ";
        }
      }
      index = stop;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          // Blank the escape and whatever it escapes, so a `\\"` never ends the
          // literal early and a `\\n` never survives as matchable text.
          characters[index] = " ";
          characters[index + 1] = " ";
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        // Real newlines (legal inside a template literal) are preserved so
        // line-anchored reading of the sanitized text still lines up.
        if (source[index] !== "\n") {
          characters[index] = " ";
        }
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  return characters.join("");
}

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

/** Every source file under `root`, depth-first, in a stable order. */
function collectSourceFiles(root: string): string[] {
  const collected: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collected.push(...collectSourceFiles(entryPath));
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith(".d.ts")) {
      continue;
    }
    if (SCANNED_EXTENSIONS.includes(path.extname(entry.name))) {
      collected.push(entryPath);
    }
  }

  return collected;
}

/**
 * Requires that `new BrowserWindow(` appears nowhere under `scanRoot` except in
 * `lockedModulePath`.
 *
 * Returns one failure line per offending file. A missing tree is itself a
 * failure: a scan that silently found nothing to scan would report success for a
 * check it never ran, which is the one direction this script may never take.
 */
function findConstructionsOutsideLockedModule(scanRoot: string, lockedModulePath: string): string[] {
  let sourceFiles: string[];
  try {
    sourceFiles = collectSourceFiles(scanRoot);
  } catch (error: unknown) {
    return [
      `  - could not scan ${path.relative(process.cwd(), scanRoot)} for stray ` +
        `\`new BrowserWindow(\` call sites: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  const failures: string[] = [];
  for (const sourceFile of sourceFiles) {
    if (path.resolve(sourceFile) === path.resolve(lockedModulePath)) {
      continue;
    }
    const occurrences = countMatches(
      blankOutSourceNoise(readFileSync(sourceFile, "utf8")),
      CONSTRUCTION_PATTERN,
    );
    if (occurrences > 0) {
      failures.push(
        `  - ${path.relative(process.cwd(), sourceFile)} constructs ` +
          `${occurrences.toString()} \`new BrowserWindow(\`. Every window must be built by the ` +
          `one locked factory in ${path.relative(process.cwd(), lockedModulePath)}, or the ` +
          `\`Spec-023 §Security Hardening Baseline\` assertion above covers only some of them.`,
      );
    }
  }
  return failures;
}

function assertWebPreferences(targetPath: string, scanRoot: string): void {
  const source = readFileSync(targetPath, "utf8");
  const sanitized = blankOutSourceNoise(source);
  const failures: string[] = [];

  for (const check of CHECKS) {
    if (!check.pattern.test(sanitized)) {
      failures.push(
        `  - ${check.key}: expected \`${check.key}: ${check.required}\` ` +
          `(pattern ${String(check.pattern)}) — drift detected.`,
      );
    }
  }

  for (const singleton of SINGLETON_CHECKS) {
    const occurrences = countMatches(sanitized, singleton.pattern);
    if (occurrences !== singleton.expected) {
      failures.push(
        `  - expected exactly ${singleton.expected.toString()} of ` +
          `${singleton.description}, found ${occurrences.toString()}. Every window ` +
          `must be constructed through the one private locked factory, so the ` +
          `assertion above covers all of them.`,
      );
    }
  }

  failures.push(...findConstructionsOutsideLockedModule(scanRoot, targetPath));

  if (failures.length > 0) {
    const message =
      `[assert-webprefs] Spec-023 §Security Hardening Baseline drift detected ` +
      `in ${path.relative(process.cwd(), targetPath)}:\n` +
      failures.join("\n") +
      `\nSee docs/specs/023-desktop-shell-and-renderer.md §Security Hardening ` +
      `Baseline for the locked contract.`;
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `[assert-webprefs] OK — all ${CHECKS.length.toString()} Spec-023 ` +
      `webPreferences locks present exactly once in ` +
      `${path.relative(process.cwd(), targetPath)}, and no other source under ` +
      `${path.relative(process.cwd(), scanRoot)} constructs a BrowserWindow\n`,
  );
}

// Argument 1 is the locked module; argument 2 is the tree scanned for stray
// constructions, defaulting to that module's own directory so the real run
// covers `src/main/**` and `build/assert-webprefs.test.ts` can drive both over a
// temp fixture tree instead of re-implementing the rules inline.
const lockedModulePath = process.argv[2] ?? DEFAULT_WINDOW_TS_PATH;
assertWebPreferences(lockedModulePath, process.argv[3] ?? path.dirname(lockedModulePath));
