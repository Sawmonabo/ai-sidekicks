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

import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  CONSOLE_DIRECTORY,
  moduleNamed,
} from "../console-source-modules.js";

/**
 * The one module allowed to construct a size observer.
 *
 * An allow-list of exactly one, written as a path rather than inferred from a naming
 * convention, so moving the chokepoint is an edit a reviewer sees.
 */
const CHOKEPOINT_MODULE = "primitives/element-resize.ts";

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

/**
 * Every console source module, through the tier's one walk.
 *
 * Console-relative because that is the name every message below reports, and the
 * walk's own `displayPath` carries the `console/` root in front of it. The walk
 * itself is not this file's to write: `source-walk-chokepoint.test.ts` fails a gate
 * that reaches renderer source through a `readdirSync` of its own, because five
 * private walks is five slightly different ideas of what counts as source and the
 * difference between them is invisible until one of them scans a file the others do
 * not.
 */
const CONSOLE_MODULES = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

/** The console-relative paths of every scanned module. */
function consoleModulePaths(): readonly string[] {
  return CONSOLE_MODULES.map((module) => module.displayPath.slice("console/".length));
}

function readConsoleSource(module: string): string {
  return readConsoleSourceModule(moduleNamed(CONSOLE_MODULES, `console/${module}`));
}

describe("element-resize — the size observer is constructed in exactly one module", () => {
  const modules = consoleModulePaths();

  it("finds a console tree to scan at all", () => {
    // Without this, a walk that reached nothing would leave the assertion below
    // passing over the empty set.
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
      .map((entry) => `${entry.module}: ${entry.signatures.join(", ")}`);
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
