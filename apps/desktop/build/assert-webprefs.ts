// Build-time assertion: every Spec-023 §Security Hardening Baseline-locked
// `webPreferences` key still appears with the required literal value in
// `apps/desktop/src/main/window.ts`. Drift fails the build.
//
// `Plan-023 §Done Checklist`: "Build-time assertion script
// (`assert-webprefs.ts`) greps the factory for each value and fails the build
// on drift."
//
// `Spec-023 §Pitfalls To Avoid`: `nodeIntegration: true` or
// `sandbox: false` MUST be a build-time error.
//
// Regex-based matching (not literal-string) tolerates Prettier-driven
// quote-style or whitespace drift while still catching semantic drift.
// Each missing match produces a distinct error message naming the key.
//
// Runtime: invoked via `node --experimental-strip-types` from `pnpm build`
// (Node 22.12.0 supports `--experimental-strip-types` natively). No deps
// beyond the Node standard library.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WINDOW_TS_PATH = path.resolve(__dirname, "../src/main/window.ts");

interface LockedCheck {
  readonly key: string;
  readonly required: string;
  readonly pattern: RegExp;
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

// Strip TypeScript comments from the loaded source before applying the regex
// set. The header documentation block in `window.ts` cites Spec-023's locked
// values verbatim (e.g., `sandbox: true`, `nodeIntegration: false`) as part of
// in-code references — without sanitization, the regex could match those
// comment occurrences instead of the live `webPreferences` object literal,
// defeating `Spec-023 §Pitfalls To Avoid`.
//
// This handles `/* ... */` block comments (including multi-line) and `//` line
// comments. Edge cases like comment markers inside string literals or regex
// literals are NOT handled — `window.ts` is a small mechanical factory
// authored under Spec-023's strict shape and contains no such constructs. If
// `window.ts` ever introduces those constructs, switch to a TypeScript AST
// parser (e.g., `@typescript-eslint/parser`).
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*$/gm, "");
}

function assertWebPreferences(): void {
  const source = readFileSync(WINDOW_TS_PATH, "utf8");
  const sanitized = stripComments(source);
  const failures: string[] = [];

  for (const check of CHECKS) {
    if (!check.pattern.test(sanitized)) {
      failures.push(
        `  - ${check.key}: expected \`${check.key}: ${check.required}\` ` +
          `(pattern ${String(check.pattern)}) — drift detected.`,
      );
    }
  }

  if (failures.length > 0) {
    const message =
      `[assert-webprefs] Spec-023 §Security Hardening Baseline drift detected ` +
      `in ${path.relative(process.cwd(), WINDOW_TS_PATH)}:\n` +
      failures.join("\n") +
      `\nSee docs/specs/023-desktop-shell-and-renderer.md §Security Hardening ` +
      `Baseline for the locked contract.`;
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `[assert-webprefs] OK — all ${CHECKS.length.toString()} Spec-023 ` +
      `webPreferences locks present in ${path.relative(process.cwd(), WINDOW_TS_PATH)}\n`,
  );
}

assertWebPreferences();
