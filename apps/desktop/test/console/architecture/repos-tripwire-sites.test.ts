// One prefix rule for every tripwire site the repos family reports from.
//
// `TripwireReport.site` is typed `string` and documented as "a module path or a
// component name", which leaves the PATH's own root unstated — and this family had
// written it both ways: `console/repos/diff-pane/patch-parse.ts` in one module and
// `repos/attachments/attachment-ingest-abort.ts` in three others. Both are paths and
// neither is wrong on its face, which is exactly why they drifted: nothing read them
// together.
//
// THE RULE IS THE CONSOLE-ROOTED PATH, and it is chosen rather than merely picked. A
// site is read by a person who has a firing in the diagnostic band and wants the file;
// the console-rooted form is what every architecture gate in this tree already prints
// (`console/primitives/Chip.tsx`), so a site string and a gate finding name one module
// the same way. The family-rooted form saves eight characters and makes the reader
// supply the root from memory.
//
// WHY IT IS HERE AND NOT BESIDE THE FAMILY. It was co-located, reading its own tree
// through `import.meta.glob("./**/*.{ts,tsx}", { query: "?raw" })`. A directory glob in
// a suite is not a read: Vite resolves it at transform time and knip's Vite plugin
// turns the resolved set into dependency edges out of the importing module, which is
// itself a knip entry because the `console-unit` include glob claims it — so this one
// file made every module under `repos/` reachable and the dead-code gate could not
// report an orphan there. `source-parse-home.test.ts` next door already states the
// remedy as a rule: a gate that reads the tree as TEXT lives in this tier, where the
// shared walk and the shared parse are.
//
// ASSERTED BY WALKING THE SOURCE rather than by importing the four constants, and the
// difference matters: one of them is module-private, so an import-based check could
// only cover three — and a check that covers what happens to be exported is a check
// that goes quiet the moment someone adds a fifth site the same way the fourth was
// added. The walk finds every declaration whose name ends `_SITE`, so a new one is
// covered by existing.
//
// THE INSTRUMENT IS THE PARSER, which is what makes "every declaration" true. The
// regular expression this replaces required the literal word `const` and a
// double-quoted initializer on the same or the next line, so a `static readonly` class
// field, a `let`, and a backtick-quoted value were each a site the sentence claimed and
// the check could not see.
//
// BOTH EXTENSIONS, because the rule below admits both. The family-scoped glob read `.ts`
// alone while `CONSOLE_ROOTED_PATH` matched `\.tsx?$`, so a site declared in a component
// — nothing forbids one, and `console/primitives/Chip.tsx` is the doc's own example of
// the console-rooted form — was covered by none of the three cases and the suite stayed
// green. Today's four sites are all in `.ts` modules, so the hole was in the claim rather
// than in the tree; the planted control below carries a `.tsx` carrier so it cannot come
// back.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import ts from "typescript";

import { CONSOLE_DIRECTORY, ConsoleSourceTree } from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The family this gate reads, as the walk's own root. */
const REPOS_DIRECTORY = join(CONSOLE_DIRECTORY, "repos");

/**
 * The budget this file states rather than inherits.
 *
 * One family walked, read, and parsed — a fraction of the tier-wide readings beside
 * it — under this tier's project concurrency, where the load rather than the tree is
 * what a budget has to survive.
 */
const FAMILY_PARSE_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: FAMILY_PARSE_ALLOWANCE_MS, hookTimeout: FAMILY_PARSE_ALLOWANCE_MS });

/** What a site string must look like: the module's path from the console root. */
const CONSOLE_ROOTED_PATH = /^console\/repos\/[\w./-]+\.tsx?$/;

/** What names a tripwire site, whatever kind of declaration carries it. */
const SITE_DECLARATION_NAME = /_SITE$/;

/** One module as this gate reads it: a name for a failure, and the text. */
interface SourceModuleText {
  readonly displayPath: string;
  readonly source: string;
}

/** One declared site, with the module that declares it. */
interface DeclaredSite {
  readonly displayPath: string;
  readonly name: string;
  readonly value: string;
}

/** A string whose value is fixed at the declaration — quoted or a bare template. */
function literalTextOf(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

/** The site one declaration carries, or `undefined` where it carries none. */
function siteDeclaredBy(node: ts.Node, displayPath: string): DeclaredSite | undefined {
  if (!ts.isVariableDeclaration(node) && !ts.isPropertyDeclaration(node)) {
    return undefined;
  }
  if (!ts.isIdentifier(node.name) || !SITE_DECLARATION_NAME.test(node.name.text)) {
    return undefined;
  }
  const value = node.initializer === undefined ? undefined : literalTextOf(node.initializer);
  return value === undefined ? undefined : { displayPath, name: node.name.text, value };
}

/** Every `*_SITE` string the modules declare, in scan order. */
function declaredSites(modules: readonly SourceModuleText[]): readonly DeclaredSite[] {
  const declarations: DeclaredSite[] = [];
  for (const module of modules) {
    const parsed = parseSourceText(module.displayPath, module.source);
    forEachDescendant(parsed, (node) => {
      const site = siteDeclaredBy(node, module.displayPath);
      if (site !== undefined) {
        declarations.push(site);
      }
    });
  }
  return declarations;
}

/** Every site whose value is not the console-rooted path of its own module. */
function misplacedSites(sites: readonly DeclaredSite[]): readonly string[] {
  return sites
    .filter((site) => site.displayPath !== site.value)
    .map((site) => `${site.displayPath} declares ${site.name} = "${site.value}"`);
}

const tree = new ConsoleSourceTree({ roots: [REPOS_DIRECTORY] });
const readSites = (): readonly DeclaredSite[] => declaredSites(tree.reading.texts);

describe("the repos family — every tripwire site is a console-rooted module path", () => {
  beforeAll(() => {
    tree.read();
  });

  it("declares at least one, so the walk is not passing on an empty set", () => {
    // Without this the whole suite goes green the day the walk stops matching — a
    // renamed directory, a moved family — and reports nothing about the rule at all.
    expect(readSites().length).toBeGreaterThan(0);
  });

  it("spells every one from the console root", () => {
    const wrong = readSites()
      .filter((site) => !CONSOLE_ROOTED_PATH.test(site.value))
      .map((site) => `${site.displayPath} declares ${site.name} = "${site.value}"`);
    expect(wrong).toStrictEqual([]);
  });

  it("points each one at the module that declares it", () => {
    // A path that is well-formed and names a DIFFERENT module is the failure this
    // rule exists to stop: a copied constant reports the file it was copied from, and
    // the reader goes to a module that never fired.
    expect(misplacedSites(readSites())).toStrictEqual([]);
  });

  it("negative control: the same checks report a family-rooted and a copied site", () => {
    const planted: readonly SourceModuleText[] = [
      {
        displayPath: "console/repos/attachments/one.ts",
        source: 'const A_SITE = "repos/attachments/one.ts";',
      },
      {
        displayPath: "console/repos/diff-pane/two.ts",
        source: 'const B_SITE = "console/repos/diff-pane/three.ts";',
      },
      {
        // The `.tsx` carrier. A component declaring a site is what the family-scoped
        // `.ts` glob could not see, so this entry is what proves the walk reaches one
        // at all — and it is family-rooted, so it also has to be reported wrong.
        displayPath: "console/repos/mounts/Four.tsx",
        source: 'const C_SITE = "repos/mounts/Four.tsx";',
      },
      {
        // The two declaration forms the regular expression could not read. Both are
        // well-formed and both name their own module, so neither is reported — which
        // is the point: they are SEEN, and seen to be correct.
        displayPath: "console/repos/mounts/five.ts",
        source: [
          "let D_SITE = `console/repos/mounts/five.ts`;",
          'class Mount { static readonly E_SITE = "console/repos/mounts/five.ts"; }',
        ].join("\n"),
      },
    ];

    const sites = declaredSites(planted);
    expect(sites.map((site) => site.name)).toStrictEqual([
      "A_SITE",
      "B_SITE",
      "C_SITE",
      "D_SITE",
      "E_SITE",
    ]);
    expect(sites.filter((site) => !CONSOLE_ROOTED_PATH.test(site.value))).toHaveLength(2);
    expect(misplacedSites(sites)).toHaveLength(3);
  });
});
