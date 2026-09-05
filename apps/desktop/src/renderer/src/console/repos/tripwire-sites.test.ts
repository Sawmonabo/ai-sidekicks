// One prefix rule for every tripwire site this family reports from.
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
// ASSERTED BY WALKING THE SOURCE rather than by importing the four constants, and the
// difference matters: one of them is module-private, so an import-based check could
// only cover three — and a check that covers what happens to be exported is a check
// that goes quiet the moment someone adds a fifth site the same way the fourth was
// added. The walk finds every declaration whose name ends `_SITE`, so a new one is
// covered by existing.

import { describe, expect, it } from "vitest";

// The family's own modules, inlined at transform time through Vite's raw glob —
// `node:fs` is banned in renderer programs, and this is the form `families.test.ts`
// and `growth-values/index.test.ts` established for source reads.
const familySources = import.meta.glob("./**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Readonly<Record<string, string>>;

/** What a site string must look like: the module's path from the console root. */
const CONSOLE_ROOTED_PATH = /^console\/repos\/[\w./-]+\.tsx?$/;

/** Every `*_SITE` string this family declares, with the module that declares it. */
function declaredSites(
  sources: Readonly<Record<string, string>>,
): readonly { readonly module: string; readonly name: string; readonly value: string }[] {
  const declarations: { module: string; name: string; value: string }[] = [];
  for (const [module, source] of Object.entries(sources)) {
    if (module.includes(".test.") || module.includes(".test-support.")) {
      continue;
    }
    for (const match of source.matchAll(/const (\w*_SITE)\s*(?::[^=]+)?=\s*\n?\s*"([^"]*)"/g)) {
      declarations.push({ module, name: match[1] ?? "", value: match[2] ?? "" });
    }
  }
  return declarations;
}

describe("the repos family — every tripwire site is a console-rooted module path", () => {
  it("declares at least one, so the walk is not passing on an empty set", () => {
    // Without this the whole suite goes green the day the glob stops matching — a
    // renamed directory, a moved family — and reports nothing about the rule at all.
    expect(declaredSites(familySources).length).toBeGreaterThan(0);
  });

  it("spells every one from the console root", () => {
    const wrong = declaredSites(familySources)
      .filter((site) => !CONSOLE_ROOTED_PATH.test(site.value))
      .map((site) => `${site.module} declares ${site.name} = "${site.value}"`);
    expect(wrong).toStrictEqual([]);
  });

  it("points each one at the module that declares it", () => {
    // A path that is well-formed and names a DIFFERENT module is the failure this
    // rule exists to stop: a copied constant reports the file it was copied from, and
    // the reader goes to a module that never fired.
    const misplaced = declaredSites(familySources)
      .filter((site) => `console/repos/${site.module.replace("./", "")}` !== site.value)
      .map((site) => `${site.module} declares ${site.name} = "${site.value}"`);
    expect(misplaced).toStrictEqual([]);
  });

  it("negative control: the same checks report a family-rooted and a copied site", () => {
    const planted = {
      "./attachments/one.ts": 'const A_SITE = "repos/attachments/one.ts";',
      "./diff-pane/two.ts": 'const B_SITE = "console/repos/diff-pane/three.ts";',
    };
    const sites = declaredSites(planted);
    expect(sites.map((site) => site.name)).toStrictEqual(["A_SITE", "B_SITE"]);
    expect(sites.filter((site) => !CONSOLE_ROOTED_PATH.test(site.value))).toHaveLength(1);
    expect(
      sites.filter((site) => `console/repos/${site.module.replace("./", "")}` !== site.value),
    ).toHaveLength(2);
  });
});
