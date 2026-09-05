// Every exemption from the console's syntax bans earns itself, and the build says so.
//
// WHY THIS FILE EXISTS. `eslint.config.mjs` bans a small set of syntactic forms across
// `console/**` and `shell/**` — the lenient date readings, the throwing `catch`
// stringifications, the lexical ordering of two stamps — and it excuses named files from
// ALL of them. That last word is the hazard: an `ignores` entry is not "this file may call
// `Date.parse`", it is "no selector in this block applies to this file, ever". A file
// excused for one reason is thereby excused for every rule the block grows afterwards.
//
// Two of the four entries this gate was written against turned out to be excused for
// nothing at all. `core/clock.ts` was listed as the console's one `Date.now` seam — and
// `Date.now` matches no selector in the block, so the entry excused a file from rules it
// never broke. `core/wire-rejection.ts` was listed as the reading the `String(catch)` rule
// points at — and it names `String(...)` in its prose only, never inside a `catch`. Neither
// was a lie when it was written; both were reasons that stopped being true and left an
// exemption behind, which is the only way this kind of hole is ever dug.
//
// So the claim is stated in the positive and mechanically: an exempt file, linted at a
// path the block DOES cover, must trip at least one selector. That is what "earns" means,
// and it is checkable without anyone re-reading the rationale.
//
// THE INSTRUMENT IS THE REAL ENGINE, TWICE — the one in `test/console/eslint-harness.ts`,
// which three gates now share so that the probe path and the config resolution cannot
// drift between the gate that resolves the exempt set and the gate that plants rows. The exempt set is resolved by asking ESLint
// what config it would apply to each console module, so an exemption added anywhere —
// this block, a later block, a widened glob — is in the set. Then each exempt file's own
// TEXT is linted at a non-exempt probe path, through the same config. Nothing here
// restates a selector: a copy would pass with the config deleted, which is the failure
// this file exists to prevent.

import type { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";
import {
  createDesktopLinter,
  ESLINT_CASE_BUDGET_MS,
  NON_EXEMPT_CONSOLE_PROBE_PATH,
  ruleMessagesAt,
} from "../eslint-harness.js";

/**
 * The rule whose exempt set this file audits.
 *
 * One rule rather than "any rule the block sets", because `ignores` is per config OBJECT:
 * excusing a file from this block excuses it from exactly the selectors this block
 * declares, and that is the set whose holes matter.
 */
const AUDITED_RULE = "no-restricted-syntax";

/**
 * The two entries that were listed here and earned nothing, kept as the planted control.
 *
 * They are the honest negative control precisely because they are real: each is a live
 * console module whose text trips no selector, so each is what a stale exemption looks
 * like from inside this gate. Re-list either one in `ignores` and the positive claim above
 * fails on it by name.
 */
const WOULD_NOT_EARN_AN_EXEMPTION: readonly string[] = [
  "console/core/clock.ts",
  "console/core/wire-rejection.ts",
];

/** Whether the audited rule is configured and ON for `absolutePath`. */
async function restrictsSyntaxAt(linter: ESLint, absolutePath: string): Promise<boolean> {
  const resolved = await linter.calculateConfigForFile(absolutePath);
  const entry: unknown = resolved.rules?.[AUDITED_RULE];
  if (entry === undefined) {
    return false;
  }
  const severity = Array.isArray(entry) ? entry[0] : entry;
  return severity !== 0 && severity !== "off";
}

/** How many selectors `source` trips when linted as a covered console module. */
async function selectorHitsAtProbePath(linter: ESLint, source: string): Promise<number> {
  return (await ruleMessagesAt(linter, source, NON_EXEMPT_CONSOLE_PROBE_PATH, AUDITED_RULE)).length;
}

describe("eslint exemption census — every excused file trips something", () => {
  const linter = createDesktopLinter();
  const modules: readonly ConsoleSourceModule[] = consoleSourceModules({ tests: true });

  it(
    "covers the console at all, and the probe path is inside the coverage",
    async () => {
      // Without both halves a mis-scoped `files` selector would leave every module
      // exempt, the census would report a huge earned-nothing set, and a probe that was
      // itself exempt would make every hit count zero — two different ways to be green
      // for no reason.
      expect(modules.length).toBeGreaterThan(20);
      expect(await restrictsSyntaxAt(linter, NON_EXEMPT_CONSOLE_PROBE_PATH)).toBe(true);
    },
    ESLINT_CASE_BUDGET_MS,
  );

  it(
    "excuses at least one file, so the census has a subject",
    async () => {
      // The two negative controls are the reason this matters: on a branch where every
      // exemption had been deleted, the claim below would quantify over nothing and pass
      // whatever the selectors did.
      const exempt = await exemptModules(linter, modules);
      expect(exempt).not.toStrictEqual([]);
    },
    ESLINT_CASE_BUDGET_MS,
  );

  it(
    "every excused file trips a selector when linted at a covered path",
    async () => {
      const exempt = await exemptModules(linter, modules);
      const earnedNothing: string[] = [];
      for (const module of exempt) {
        const hits = await selectorHitsAtProbePath(linter, readConsoleSourceModule(module));
        if (hits === 0) {
          earnedNothing.push(module.displayPath);
        }
      }
      expect(earnedNothing).toStrictEqual([]);
    },
    ESLINT_CASE_BUDGET_MS,
  );

  it(
    "negative control: the two entries that were deleted would earn nothing",
    async () => {
      // See `WOULD_NOT_EARN_AN_EXEMPTION`. This is what makes the clean result above a
      // finding rather than a tautology: if every console file tripped something, the
      // claim would hold with no exemption discipline behind it at all.
      for (const displayPath of WOULD_NOT_EARN_AN_EXEMPTION) {
        const module = moduleNamed(modules, displayPath, "a module that earns no exemption");
        expect(
          await selectorHitsAtProbePath(linter, readConsoleSourceModule(module)),
          `${displayPath} now trips a selector — it may have earned an exemption, or it may have acquired a defect`,
        ).toBe(0);
      }
    },
    ESLINT_CASE_BUDGET_MS,
  );

  it(
    "negative control: the probe reports a hit for a source that plainly offends",
    async () => {
      // The other half of the discriminator. Without it, a broken probe path or a
      // silently-dropped rule would report zero for everything and read as "no file
      // earns an exemption" rather than as "this gate stopped working".
      expect(
        await selectorHitsAtProbePath(
          linter,
          "export const at = Date.parse('2026-02-30T10:00:00Z');\n",
        ),
      ).toBeGreaterThan(0);
      expect(await selectorHitsAtProbePath(linter, "export const total = 1 + 1;\n")).toBe(0);
    },
    ESLINT_CASE_BUDGET_MS,
  );
});

/** The console modules ESLint would apply no syntax ban to. */
async function exemptModules(
  linter: ESLint,
  modules: readonly ConsoleSourceModule[],
): Promise<readonly ConsoleSourceModule[]> {
  const exempt: ConsoleSourceModule[] = [];
  for (const module of modules) {
    if (!(await restrictsSyntaxAt(linter, module.absolutePath))) {
      exempt.push(module);
    }
  }
  return exempt;
}
