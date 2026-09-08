// The airspace registration, asserted to cover every overlay the console mounts.
//
// `Spec-023 §Console Design (Meridian)` 12.3's Never bullet asks for exactly this
// rule: "A new overlay primitive that does not register is caught by the architecture
// lint rule, which asserts it matched at least one site so a rename cannot silently
// disarm it." The registry it guards shipped for a whole phase with zero registrants —
// a set the native view's visibility predicate consulted and that nothing ever put an
// overlay into — so the vacuity guard is not decoration here, it is the finding.
//
// AND ONE REGISTRANT IS NOT THE CLAIM EITHER, which is the correction this file makes.
// A rule satisfied by ANY single site passed while the attach dialog, the membership
// menu, and the revoke confirmation each mounted a Base UI popup of their own and
// registered nothing: once a `WebContentsView` is live the native view paints over
// exactly those three and eats their input, and the gate stayed green throughout. So
// the subject moves from "somebody registers" to the CLASS — every module that mounts
// one of Base UI's popup parts is an overlay primitive, and every overlay primitive
// registers.
//
// SIX CLAIMS, and they are different.
//
//   1. The hook is REACHED: at least one console module calls
//      `useAirspaceRegistration`, so the airspace has a registrant at all.
//   2. Overlay popup parts are mounted ONLY under `primitives/`. A family that mounts
//      `Dialog.Portal` itself is the shape 12.3's Never forbids — "No consumer
//      registers an overlay by hand at a call site" is unenforceable while a consumer
//      can mount an overlay without going near the registration at all.
//   3. Every primitive that mounts one REGISTERS. This is what makes claim 2 worth
//      making: routing every overlay through `primitives/` buys nothing if a primitive
//      may forget, and a consumer cannot forget on its own behalf.
//   4. The hook is the ONLY door: no module outside the ones that own the seam reaches
//      the registry accessor directly, because a hand-rolled registration at a call
//      site is the shape that forgets to remove.
//   5. The registry is SINGULAR: exactly one production module constructs an
//      `AirspaceRegistry`, and it is the holder — and exactly one DECLARES the class,
//      because two declarations of one name are two registries however few are built.
//   6. Every MODAL wrapper registers its BACKDROP. Claim 3 is satisfied by a module
//      that registers one rectangle, and for a modal the popup is the wrong one to
//      stop at: the backdrop is the part that covers the window, so a wrapper that
//      registered only the popup left a native view painted and interactive over
//      every pane the dialog's own box did not happen to cross.
//
// THE FIFTH IS NOT IMPLIED BY THE FOURTH, which is why it is written. The accessor
// rule constrains who may ASK the holder for a registry and says nothing about who may
// build one: a family constructing `new AirspaceRegistry()` of its own passes the
// accessor rule untouched, and every overlay registered into it would be invisible to
// the native view's visibility predicate — a second airspace nothing reconciles,
// which is worse than none, because the first failure mode announces itself and this
// one renders correctly right up until a native view is on screen.
//
// THE SOURCE SHAPES ARE `airspace-source.ts`'s and the CLAIMS are this file's, and the
// controls that prove each predicate bites are `airspace-source.test.ts`'s beside them.
// Every predicate takes a parsed module, so a control there drives the same rule a
// claim here drives, over a snippet parsed exactly as the walk parses a module.

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  AIRSPACE_REGISTRATION_HOOKS,
  backdropsMountedWithoutAirspaceRef,
  callsAnyFunctionNamed,
  callsFunctionNamed,
  constructsClassNamed,
  declaresClassNamed,
  overlayPopupPartsMounted,
  ParsedConsoleTree,
} from "./airspace-source.js";

/** The budget this file states rather than inherits; `source-walk-chokepoint.ts`'s figure. */
const CONSOLE_PARSE_ALLOWANCE_MS = 30_000;

vi.setConfig({ testTimeout: CONSOLE_PARSE_ALLOWANCE_MS });

/** The registry accessor the hook calls, and nothing else in a view family may. */
const REGISTRY_ACCESSOR = "airspaceRegistryFor";

/** The class whose one construction site is the holder. */
const REGISTRY_CLASS = "AirspaceRegistry";

/** The one production module allowed to construct one. Its holder is the singleton. */
const REGISTRY_HOLDER = "core/airspace-registries.ts";

/** The one module allowed to declare the class. The DAG floor, where both sides reach it. */
const REGISTRY_DECLARATION = "core/airspace-registry.ts";

/** The module that declares the hook, and therefore registers nothing itself. */
const REGISTRATION_DOOR = "primitives/airspace-registration.ts";

/**
 * The module that decides which parts of a MODAL are airspace, and mounts none of them.
 *
 * Excluded from the vacuity guard beside the door for the same reason: it calls the
 * registration hook, so a claim that "somebody registers" would be satisfied by the two
 * modules whose whole job is to declare the seam, with no overlay on screen anywhere.
 */
const MODAL_AIRSPACE_DOOR = "primitives/overlay/modal-airspace.ts";

/** The one directory an overlay popup part may be mounted in. */
const OVERLAY_PRIMITIVE_PREFIX = "primitives/";

/**
 * The modules allowed to reach the registry accessor directly.
 *
 * The hook itself, because it is the registration door; the two `core/` modules that
 * declare and hold it; and the two NATIVE-VIEW CONSUMERS, which read the airspace
 * rather than registering into it — the browser family's geometry binding and the
 * deck's rect tracker, which hides a pane's view while an overlay is up. Written as
 * paths rather than inferred from a naming convention, so widening the set is an edit
 * a reviewer sees.
 */
const REGISTRY_READERS: readonly string[] = [
  "core/airspace-registries.ts",
  REGISTRATION_DOOR,
  "browser/pane/geometry-binding.ts",
  "workspace/deck/rect-discipline.ts",
];

describe("airspace — every overlay registers, through one door", () => {
  const tree = new ParsedConsoleTree();

  beforeAll(() => {
    tree.read();
  });

  it("finds a console tree to scan at all", () => {
    expect(tree.relativePaths.length).toBeGreaterThan(20);
    expect(tree.relativePaths).toContain(REGISTRATION_DOOR);
    expect(tree.relativePaths).toContain(MODAL_AIRSPACE_DOOR);
  });

  it("at least one console surface registers an overlay", () => {
    // The vacuity guard 12.3 names. A registry with no registrant is a set the
    // visibility predicate consults and nothing ever writes to, which is the state
    // this rule was written after finding.
    const registrants = tree.modules
      .filter(
        (module) =>
          module.relativePath !== REGISTRATION_DOOR && module.relativePath !== MODAL_AIRSPACE_DOOR,
      )
      .filter((module) => callsAnyFunctionNamed(module.parsed, AIRSPACE_REGISTRATION_HOOKS))
      .map((module) => module.relativePath);
    expect(registrants.length).toBeGreaterThan(0);
  });

  it("mounts a Base UI popup part only inside the primitive layer", () => {
    // Claim 2. A family that mounts its own `Dialog.Portal` has an overlay the
    // airspace cannot know about, and no registration rule reaches it — the consumer
    // never touches the registration at all, so there is nothing there to forget.
    const offenders = tree.modules
      .filter((module) => !module.relativePath.startsWith(OVERLAY_PRIMITIVE_PREFIX))
      .map((module) => ({ module, parts: overlayPopupPartsMounted(module.parsed) }))
      .filter(({ parts }) => parts.length > 0)
      .map(({ module, parts }) => `${module.relativePath} mounts ${parts.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("every overlay primitive registers what it mounts", () => {
    // Claim 3, and the vacuity floor beside it: routing every overlay into
    // `primitives/` is worth nothing if a primitive may mount one and register none,
    // and an "every" over an empty set is a rule that has stopped being read.
    const overlayPrimitives = tree.modules.filter(
      (module) =>
        module.relativePath.startsWith(OVERLAY_PRIMITIVE_PREFIX) &&
        overlayPopupPartsMounted(module.parsed).length > 0,
    );
    expect(overlayPrimitives.length).toBeGreaterThan(0);
    const unregistered = overlayPrimitives
      .filter((module) => !callsAnyFunctionNamed(module.parsed, AIRSPACE_REGISTRATION_HOOKS))
      .map((module) => module.relativePath);
    expect(unregistered).toStrictEqual([]);
  });

  it("every modal wrapper registers the backdrop it mounts", () => {
    // Claim 6, and the vacuity floor with it: the console has to be mounting a
    // backdrop somewhere for the rule to be about anything, and every one it mounts
    // has to carry the registration. Read over the WHOLE tree rather than over
    // `primitives/` alone — claim 2 is what keeps the mounts in the primitive layer,
    // and this claim would be worth less if it quietly assumed that claim's result.
    const backdropMounts = tree.modules.filter((module) =>
      overlayPopupPartsMounted(module.parsed).some((part) => part.endsWith(".Backdrop")),
    );
    expect(backdropMounts.length).toBeGreaterThan(0);
    const bare = tree.modules
      .map((module) => ({
        module,
        backdrops: backdropsMountedWithoutAirspaceRef(module.parsed),
      }))
      .filter(({ backdrops }) => backdrops.length > 0)
      .map(
        ({ module, backdrops }) => `${module.relativePath} mounts a bare ${backdrops.join(", ")}`,
      );
    expect(bare).toStrictEqual([]);
  });

  it("no surface reaches the registry around the hook", () => {
    const offenders = tree.modules
      .filter((module) => !REGISTRY_READERS.includes(module.relativePath))
      .filter((module) => callsFunctionNamed(module.parsed, REGISTRY_ACCESSOR))
      .map((module) => module.relativePath);
    expect(offenders).toStrictEqual([]);
  });

  it("exactly one production module constructs a registry, and it is the holder", () => {
    // The claim the accessor rule cannot make. A second `new AirspaceRegistry()`
    // anywhere — in a view family, in a test-support module that ships, under any
    // other name for the variable it lands in — is a second airspace, and every
    // overlay put into it is invisible to the predicate that decides whether a native
    // view yields. The declaring module is not exempt: it declares the class and does
    // not construct one.
    const constructors = tree.modules
      .filter((module) => constructsClassNamed(module.parsed, REGISTRY_CLASS))
      .map((module) => module.relativePath);
    expect(constructors).toStrictEqual([REGISTRY_HOLDER]);
  });

  it("exactly one module declares the registry class, and it is the one at the floor", () => {
    // The claim the construction rule cannot make either, and the one this file was
    // missing while the console carried TWO classes of this name: the workspace deck
    // declared a second registry for the same rule — a `Set` of overlay ids behind
    // `claim` / `isOccupied` — and every claim above stayed green, because the deck
    // never constructed one and never reached the accessor. Two declarations are two
    // registries whether or not both are built: the first surface to instantiate the
    // wrong one registers into a set the visibility predicate does not read.
    const declarers = tree.modules
      .filter((module) => declaresClassNamed(module.parsed, REGISTRY_CLASS))
      .map((module) => module.relativePath);
    expect(declarers).toStrictEqual([REGISTRY_DECLARATION]);
  });
});
