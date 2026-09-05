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

/**
 * The rules an inline directive may not switch off anywhere under the governed roots.
 *
 * `no-restricted-imports` rides beside the audited rule because the two carry one
 * boundary between them: the syntax bans keep a lenient date reading out of the console,
 * and the import ban keeps a second validator out of it. A directive is a fourth
 * exemption channel — beside `ignores`, a later block's `off`, and a mis-scoped `files` —
 * and it is the one that needs no config edit anybody reviews.
 */
const RULES_NO_DIRECTIVE_MAY_SUPPRESS: readonly string[] = [AUDITED_RULE, "no-restricted-imports"];

/**
 * Every inline ESLint directive in `source`, as `[form, rule list]`.
 *
 * Source text, and it has to be: the config layer cannot see a directive at all —
 * `calculateConfigForFile` reports the rule configured and on for a file that has
 * switched it off in its own first line, so such a file is not in the exempt set and
 * this census never looks at it. Measured, not assumed.
 */
function inlineDirectives(source: string): readonly (readonly [string, string])[] {
  const directive = /\/[/*]\s*(eslint-disable(?:-next-line|-line)?)([^*\n]*)/gu;
  return [...source.matchAll(directive)].map((match) => {
    const named = (match[2] ?? "").split("--")[0] ?? "";
    return [match[1] ?? "", named.replace(/\*\//gu, "").trim()] as const;
  });
}

/**
 * Which of the guarded rules `source` switches off inline, or `[]`.
 *
 * A directive naming NO rule disables every rule on the line or in the file, so an empty
 * rule list is an offence against all of them rather than against none.
 */
export function suppressedGuardedRules(source: string): readonly string[] {
  return inlineDirectives(source).flatMap(([form, named]) => {
    if (named.length === 0) {
      return [`${form} (every rule)`];
    }
    const rules = named.split(",").map((rule) => rule.trim());
    return RULES_NO_DIRECTIVE_MAY_SUPPRESS.filter((rule) => rules.includes(rule)).map(
      (rule) => `${form} ${rule}`,
    );
  });
}

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

  it("no module switches the syntax or import bans off inline", () => {
    // The channel the config-resolution claim above cannot see. A file carrying
    // `eslint-disable no-restricted-syntax` in its first line lints clean at a fully
    // covered console path AND still resolves the rule as configured and on, so it is
    // not in the exempt set and every claim above passes over it.
    const offenders = modules
      .map((module) => ({
        module: module.displayPath,
        suppressed: suppressedGuardedRules(readConsoleSourceModule(module)),
      }))
      .filter((entry) => entry.suppressed.length > 0)
      .map((entry) => `${entry.module}: ${entry.suppressed.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the needle reads a directive, and reads which rule it names", () => {
    // Both halves, both planted, and the first one planted on purpose. This tree now
    // carries no inline directive at all — which the claim above is exactly about, so
    // reading the needle against a real carrier would mean keeping one alive to be
    // read. The benign row is what the real carrier used to prove: a directive is
    // findable, and naming an unguarded rule is not a suppression of a guarded one.
    const benign = "// eslint-disable-next-line @typescript-eslint/no-unused-vars\nconst a = 1;\n";
    expect(inlineDirectives(benign).length).toBeGreaterThan(0);
    expect(suppressedGuardedRules(benign)).toStrictEqual([]);
    for (const planted of [
      "/* eslint-disable no-restricted-syntax */\nexport const at = Date.parse(iso);\n",
      "// eslint-disable-next-line no-restricted-syntax -- a reason\nexport const at = Date.parse(iso);\n",
      "/* eslint-disable */\nexport const at = Date.parse(iso);\n",
      '// eslint-disable-next-line no-restricted-imports\nimport { z } from "zod";\n',
    ]) {
      expect(suppressedGuardedRules(planted), planted).not.toStrictEqual([]);
    }
  });
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
