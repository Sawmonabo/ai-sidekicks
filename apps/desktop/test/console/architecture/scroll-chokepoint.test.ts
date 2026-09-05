// The scroll chokepoint, asserted by reading the tree.
//
// `Spec-023 §Console Test Tiers` puts two of this tier's tripwires here — "no
// `scrollTop` write outside the chokepoint, no `scrollIntoView`" — over the rule
// `ledger/frame/scroll-chokepoint.ts` states: one scroll controller per timeline pane
// owns `scrollTop` writes, every caller is a member of a closed caller union and is
// named in the write, and glides replace `scrollIntoView` everywhere. The
// controller's own behaviour is driven in its co-located unit test; the claim only a
// tree-wide scan can hold is that no OTHER module writes a scroll offset — and, like
// every chokepoint, the second implementation is never introduced deliberately. It
// arrives as one line in a component that needed to bring a row into view.
//
// TWO CLAIMS, DRAWN AT DIFFERENT PLACES.
//
//   • **Writing `scrollTop` is allowed in exactly one module.** Reading it is not
//     policed: a read is what the chokepoint's own geometry sample does, and a rule
//     that forbade the token outright would forbid the module that owns it from
//     naming its own subject.
//   • **`scrollIntoView`, `scrollTo`, and `scrollBy` are allowed NOWHERE**, the
//     chokepoint included. Each of them moves a scroll offset without saying which
//     one or by how much, so none of them can be arbitrated between callers — which
//     is what the closed caller union exists to make possible.
//
// Test files are excluded, for `wire-figure-chokepoint.test.ts`' reason: a test that
// drives the chokepoint has to write the very token the rule is about, and a scan
// that forbade it would forbid testing the chokepoint at all.

import { describe, expect, it } from "vitest";

import {
  CONSOLE_DIRECTORY,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";

/**
 * The one module allowed to write a scroll offset.
 *
 * A path rather than a naming convention, so moving the chokepoint is an edit a
 * reviewer sees rather than a rename that quietly re-points the rule.
 */
const CHOKEPOINT_MODULE = "console/ledger/frame/scroll-chokepoint.ts";

/** Every way a module can be seen assigning a scroll offset. */
const SCROLL_WRITE_FORMS: readonly string[] = [
  "scrollTop =",
  "scrollTop +=",
  "scrollTop -=",
  "scrollLeft =",
];

/**
 * Platform calls that move a scroll offset without naming one.
 *
 * Banned everywhere, chokepoint included: a glide states its caller and its target,
 * and these state neither.
 */
const UNNAMED_SCROLL_APIS: readonly string[] = [".scrollIntoView(", ".scrollTo(", ".scrollBy("];

/**
 * Every way `source` shows it wrote a scroll offset, or `[]`.
 *
 * A pure function over text so the negative controls below can drive it with
 * strings whose verdict is known, proving the checker bites without perturbing a
 * real module.
 */
function scrollWriteSignatures(source: string): readonly string[] {
  return SCROLL_WRITE_FORMS.filter((form) => source.includes(form));
}

/** Every unnamed scroll call `source` makes, or `[]`. */
function unnamedScrollApiSignatures(source: string): readonly string[] {
  return UNNAMED_SCROLL_APIS.filter((form) => source.includes(form));
}

describe("the scroll chokepoint — one writer, tree-wide", () => {
  const modules = consoleSourceModules({ roots: [CONSOLE_DIRECTORY] });

  it("finds a console tree to scan, and the chokepoint inside it", () => {
    // Without this, a wrong CONSOLE_DIRECTORY would scan nothing and every
    // assertion below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.map((module) => module.displayPath)).toContain(CHOKEPOINT_MODULE);
  });

  it("no other module assigns a scroll offset", () => {
    const offenders = modules
      .filter((module) => module.displayPath !== CHOKEPOINT_MODULE)
      .map((module) => ({
        module: module.displayPath,
        signatures: scrollWriteSignatures(readConsoleSourceModule(module)),
      }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.module}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("no module anywhere reaches for an unnamed scroll call", () => {
    const offenders = modules
      .map((module) => ({
        module: module.displayPath,
        signatures: unnamedScrollApiSignatures(readConsoleSourceModule(module)),
      }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${entry.module}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the chokepoint itself trips the write signature", () => {
    // The checker reads real files and the needles match real code. Without this, a
    // typo in a needle would make both clean results above meaningless.
    expect(
      scrollWriteSignatures(
        readConsoleSourceModule(moduleNamed(modules, CHOKEPOINT_MODULE, "the scroll chokepoint")),
      ),
    ).toContain("scrollTop =");
  });

  it("negative control: a virtualizer callback that wrote the offset would be caught", () => {
    // The adopted virtualizer's `scrollToFn` is the one seam through which a library
    // could reach the scroll offset, and the shipped implementation hands it to the
    // chokepoint. This is the proof that the scan would catch the other choice: the
    // body below is what the default implementation does, and it trips the rule.
    expect(
      scrollWriteSignatures(
        "scrollToFn: (offset) => { instance.scrollElement.scrollTop = offset; },",
      ),
    ).toStrictEqual(["scrollTop ="]);
    expect(
      unnamedScrollApiSignatures("scrollToFn: (offset) => element.scrollTo({ top: offset })"),
    ).toStrictEqual([".scrollTo("]);
    // And the shipped seam trips neither, because it names a caller and delegates.
    expect(
      scrollWriteSignatures('this.scroll.glideTo("measurement-compensation", offset);'),
    ).toStrictEqual([]);
  });

  it("negative control: the predicates bite, and read like a read", () => {
    expect(scrollWriteSignatures("element.scrollTop = 120;")).toStrictEqual(["scrollTop ="]);
    expect(scrollWriteSignatures("surface.scrollTop += delta;")).toStrictEqual(["scrollTop +="]);
    // A READ is not a write, and the chokepoint's own sample is one.
    expect(scrollWriteSignatures("const offset = element.scrollTop;")).toStrictEqual([]);
    expect(unnamedScrollApiSignatures("row.scrollIntoView({ block: 'center' })")).toStrictEqual([
      ".scrollIntoView(",
    ]);
    expect(
      unnamedScrollApiSignatures("const glide = controller.glideTo('deep-link', 40);"),
    ).toStrictEqual([]);
  });
});
