// The size-observer chokepoint, asserted.
//
// `apps/desktop/AGENTS.md` states hoist-on-second-use and "one implementation per
// job", and a `ResizeObserver` is the shape that rule is hardest on: it is four
// lines — a feature detection, a construction, an `observe`, and a `disconnect` —
// so the second one is never introduced deliberately. It arrives inside a component
// that needed to know when its own box changed, and it is only wrong later, when the
// two copies stop agreeing about what an absent constructor means or about who
// disconnects.
//
// The console had exactly that: the browser family's seam and a second construction
// inside the terminal emulator. Both are `primitives/element-resize.ts` now, and this
// is what keeps that true — a claim no type and no layering rule can make, because
// constructing a global is not an import.
//
// WHAT COUNTS AS A CONSTRUCTION SITE. Reading the constructor off the platform, in
// either of the two forms this tree can write it. A module that merely names the type
// in a comment or holds a `ResizeObserver`-typed field is not scanned for: the
// observable act is taking the constructor, and the chokepoint is the only module
// allowed to take it.
//
// Test files are excluded: a fake has to construct the shape it stands in for, and
// forbidding that would forbid testing the chokepoint's own degrade.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIRECTORY = resolve(HERE, "..", "..", "..", "src", "renderer", "src", "console");

/**
 * The one module allowed to construct a size observer.
 *
 * An allow-list of exactly one, written as a path rather than inferred from a naming
 * convention, so moving the chokepoint is an edit a reviewer sees.
 */
const CHOKEPOINT_MODULE = join("primitives", "element-resize.ts");

/**
 * The ways this tree can take the constructor.
 *
 * `new ResizeObserver(` is the direct form; the chokepoint itself reads the global
 * into a local first, so the indirect form is listed beside it rather than left as a
 * hole a second site could be written through.
 */
const CONSTRUCTION_FORMS: readonly string[] = ["new ResizeObserver(", "globalThis.ResizeObserver"];

/**
 * Every way `source` shows it took the size-observer constructor, or `[]`.
 *
 * A pure function over text rather than a loop inside a test, so the negative
 * controls below can drive it with strings whose verdict is known and the checker is
 * proved to bite without perturbing a real module.
 */
function resizeObserverConstructionSignatures(source: string): readonly string[] {
  return CONSTRUCTION_FORMS.filter((form) => source.includes(form));
}

function consoleSourceModules(): readonly string[] {
  return readdirSync(CONSOLE_DIRECTORY, { recursive: true, encoding: "utf8" })
    .filter(
      (entry) =>
        (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
        !entry.endsWith(".test.ts") &&
        !entry.endsWith(".test.tsx") &&
        !entry.endsWith(".test-support.ts") &&
        !entry.endsWith(".d.ts"),
    )
    .sort();
}

function readConsoleSource(module: string): string {
  return readFileSync(join(CONSOLE_DIRECTORY, module), "utf8");
}

describe("element-resize — the size observer is constructed in exactly one module", () => {
  const modules = consoleSourceModules();

  it("finds a console tree to scan at all", () => {
    // Without this, a wrong CONSOLE_DIRECTORY would scan nothing and the assertion
    // below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules).toContain(CHOKEPOINT_MODULE);
  });

  it("no other module takes the constructor", () => {
    const offenders = modules
      .filter((module) => module !== CHOKEPOINT_MODULE)
      .map((module) => ({
        module,
        signatures: resizeObserverConstructionSignatures(readConsoleSource(module)),
      }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${relative(".", entry.module)}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the chokepoint itself trips the checker", () => {
    // The checker reads real files and the needles match real code. Without this, a
    // typo in a needle would make the clean result above meaningless — which is
    // exactly the state the emulator's own observer was found in.
    expect(resizeObserverConstructionSignatures(readConsoleSource(CHOKEPOINT_MODULE))).toContain(
      "globalThis.ResizeObserver",
    );
  });

  it("negative control: the emulator's old construction site is what this catches", () => {
    // The literal shape the terminal adapter carried, driven through the predicate
    // rather than through a planted edit, so the claim survives the module it was
    // removed from being renamed.
    expect(
      resizeObserverConstructionSignatures(
        "const resizeObserver = new ResizeObserver(() => {\n  this.fitToHost();\n});",
      ),
    ).toStrictEqual(["new ResizeObserver("]);
    expect(
      resizeObserverConstructionSignatures("#resizeObserver: ResizeObserver | undefined;"),
    ).toStrictEqual([]);
  });
});
