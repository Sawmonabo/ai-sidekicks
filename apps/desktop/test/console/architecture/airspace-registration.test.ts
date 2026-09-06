// The airspace registration, asserted to have registrants.
//
// `Spec-023 §Console Design (Meridian)` 12.3's Never bullet asks for exactly this
// rule: "A new overlay primitive that does not register is caught by the architecture
// lint rule, which asserts it matched at least one site so a rename cannot silently
// disarm it." The registry it guards shipped for a whole phase with zero registrants —
// a set the native view's visibility predicate consulted and that nothing ever put an
// overlay into — so the vacuity guard is not decoration here, it is the finding.
//
// THREE CLAIMS, and they are different. The first is that the hook is REACHED: at
// least one console module calls `useAirspaceRegistration`, so the airspace has a
// registrant at all. The second is that the hook is the ONLY door: no module outside
// the ones that own the seam reaches the registry accessor directly, because a
// hand-rolled registration at a call site is the shape 12.3's Never forbids and the
// shape that forgets to remove. The third is that the registry is SINGULAR: exactly one
// production module constructs an `AirspaceRegistry`, and it is the holder.
//
// THE THIRD IS NOT IMPLIED BY THE SECOND, which is why it is written. The accessor
// rule constrains who may ASK the holder for a registry and says nothing about who may
// build one: a family constructing `new AirspaceRegistry()` of its own passes the
// accessor rule untouched, and every overlay registered into it would be invisible to
// the native view's visibility predicate — a second airspace nothing reconciles,
// which is worse than none, because the first failure mode announces itself and this
// one renders correctly right up until a native view is on screen.
//
// THE INSTRUMENT IS THE PARSER, on `resize-observer-chokepoint.test.ts`'s reasoning:
// a substring scan cannot tell a call from a sentence about one, and this file's own
// header names both symbols in prose. A call expression and an import specifier are
// declaration boundaries, which `apps/desktop/AGENTS.md` says to answer with the
// compiler rather than with a pattern.

import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  consoleRelativePaths,
  consoleSourceModules,
  readModuleNamed,
  CONSOLE_DIRECTORY,
} from "../console-source-modules.js";
import { forEachDescendant, parseSourceText } from "../typescript-source.js";

/** The budget this file states rather than inherits; `source-walk-chokepoint.ts`'s figure. */
const CONSOLE_PARSE_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: CONSOLE_PARSE_ALLOWANCE_MS });

/** The primitive-layer hook every overlay registers through. */
const REGISTRATION_HOOK = "useAirspaceRegistration";

/** The registry accessor the hook calls, and nothing else in a view family may. */
const REGISTRY_ACCESSOR = "airspaceRegistryFor";

/** The class whose one construction site is the holder. */
const REGISTRY_CLASS = "AirspaceRegistry";

/** The one production module allowed to construct one. Its holder is the singleton. */
const REGISTRY_HOLDER = "core/airspace-registries.ts";

/**
 * The modules allowed to reach the registry accessor directly.
 *
 * The hook itself, because it is the registration door; the geometry binding, because
 * a native-view consumer reads the airspace rather than registering into it; and the
 * two `core/` modules that declare and hold it. Written as paths rather than inferred
 * from a naming convention, so widening the set is an edit a reviewer sees.
 */
const REGISTRY_READERS: readonly string[] = [
  "core/airspace-registries.ts",
  "primitives/airspace-registration.ts",
  "browser/pane/geometry-binding.ts",
];

/** Whether a module CONSTRUCTS the named class, as a tree shape rather than a substring. */
function constructsClassNamed(fileName: string, source: string, className: string): boolean {
  let constructed = false;
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === className
    ) {
      constructed = true;
    }
  });
  return constructed;
}

/** Whether a module CALLS the named function, as a tree shape rather than a substring. */
function callsFunctionNamed(fileName: string, source: string, functionName: string): boolean {
  let called = false;
  forEachDescendant(parseSourceText(fileName, source), (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === functionName
    ) {
      called = true;
    }
  });
  return called;
}

const CONSOLE_MODULES = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

function readConsoleSource(module: string): string {
  return readModuleNamed(CONSOLE_MODULES, `console/${module}`);
}

describe("airspace — the overlay registration has registrants and one door", () => {
  const modules = consoleRelativePaths(CONSOLE_MODULES);

  it("finds a console tree to scan at all", () => {
    expect(modules.length).toBeGreaterThan(20);
    expect(modules).toContain("primitives/airspace-registration.ts");
  });

  it("at least one console surface registers an overlay", () => {
    // The vacuity guard 12.3 names. A registry with no registrant is a set the
    // visibility predicate consults and nothing ever writes to, which is the state
    // this rule was written after finding.
    const registrants = modules.filter(
      (module) =>
        module !== "primitives/airspace-registration.ts" &&
        callsFunctionNamed(module, readConsoleSource(module), REGISTRATION_HOOK),
    );
    expect(registrants.length).toBeGreaterThan(0);
  });

  it("no surface reaches the registry around the hook", () => {
    const offenders = modules
      .filter((module) => !REGISTRY_READERS.includes(module))
      .filter((module) => callsFunctionNamed(module, readConsoleSource(module), REGISTRY_ACCESSOR));
    expect(offenders).toStrictEqual([]);
  });

  it("exactly one production module constructs a registry, and it is the holder", () => {
    // The claim the accessor rule cannot make. A second `new AirspaceRegistry()`
    // anywhere — in a view family, in a test-support module that ships, under any
    // other name for the variable it lands in — is a second airspace, and every
    // overlay put into it is invisible to the predicate that decides whether a native
    // view yields. The declaring module is not exempt: it declares the class and does
    // not construct one.
    const constructors = modules.filter((module) =>
      constructsClassNamed(module, readConsoleSource(module), REGISTRY_CLASS),
    );
    expect(constructors).toStrictEqual([REGISTRY_HOLDER]);
  });

  it("negative control: the checker bites on a planted registration", () => {
    // Without this, a wrong node predicate would leave both clean results above
    // meaningless — which is exactly the state the registry itself was found in.
    expect(
      callsFunctionNamed(
        "planted.tsx",
        "useAirspaceRegistration('dialog', popupRef, open);",
        REGISTRATION_HOOK,
      ),
    ).toBe(true);
    expect(
      callsFunctionNamed(
        "planted.tsx",
        "const registry = airspaceRegistryFor(document);",
        REGISTRY_ACCESSOR,
      ),
    ).toBe(true);
    expect(
      constructsClassNamed("planted.tsx", "const own = new AirspaceRegistry();", REGISTRY_CLASS),
    ).toBe(true);
  });

  it("negative control: a sentence about the hook is not a call", () => {
    expect(
      callsFunctionNamed(
        "explainer.ts",
        "// Overlays reach the airspace through useAirspaceRegistration(...).\nconst x = 1;",
        REGISTRATION_HOOK,
      ),
    ).toBe(false);
    expect(
      callsFunctionNamed("explainer.ts", 'const name = "airspaceRegistryFor";', REGISTRY_ACCESSOR),
    ).toBe(false);
    expect(
      constructsClassNamed(
        "explainer.ts",
        "// The holder builds the one AirspaceRegistry.\nconst x = 1;",
        REGISTRY_CLASS,
      ),
    ).toBe(false);
  });
});
