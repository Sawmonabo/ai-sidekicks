// The byte-scaling chokepoint, asserted.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules holds the console to
// `Intl` for every derived quantity, and `primitives/wire-figures.ts` carries the
// single amendment to that rule: `Intl` has no kibibyte, so exactly one function
// scales by powers of 1024 and appends a label from a closed set. That module's
// header states this test exists and says what it asserts. Until this file it did
// not, so the one written claim standing between the console and a second byte
// formatter was a comment describing a test nobody had written — and `apps/desktop`
// AGENTS.md names "no second byte formatter" a chokepoint precisely because the
// second one is never introduced deliberately. It arrives as four lines in a
// component that needed a file size on screen.
//
// WHAT COUNTS AS SCALING, and why the line is drawn where it is. A binary unit
// LABEL is the giveaway: a module that scales bytes has to name the unit it scaled
// to, and a module that merely bounds a byte count does not. That is why
// `core/constants.ts` may hold `64 * 1024` — a cap is a bound, it names no unit,
// and nothing renders it — while `/ 1024` is flagged, because dividing is the
// scaling step itself. Multiplying up to a bound and dividing down to a display
// figure are different acts, and only one of them is this chokepoint's business.
//
// Test files are excluded: a test asserting that "1.0 KiB" renders has to write
// "1.0 KiB", and forbidding that would forbid testing the chokepoint's own output.
//
// THE SECOND CLAIM IN THIS FILE IS ABOUT COUNTS, and it is here rather than in a
// file of its own because it is the same chokepoint read from the other side: the
// module that formats a figure is only the chokepoint if every DISPLAYED figure
// goes through it. A count reaching a screen as `String(rows.length)` or as a bare
// `{overriddenRowCount}` is a second formatting path — it groups in no locale, so
// an allowlist of 1200 tools reads "1200" beside every other four-figure quantity
// in the console reading "1,200".
//
// ITS SUBJECT IS `.tsx` MODULES ONLY, and the narrowing is the honest one rather
// than a convenience. A number in a `.tsx` file is on its way to a render; the same
// `String(failures.length)` inside a `.ts` module is overwhelmingly an `Error`
// message, which is a diagnostic and not a figure a person reads as a quantity —
// `core/emitter.ts`, `persistence/value-classes.ts` and `palette/keybindings.ts`
// each hold one today. A `.ts` module that composes SPOKEN text does reach a person
// (`sessions/notifications/attention-sentences.ts`), and it already routes through
// `formatCount`; nothing by grep separates that from an error string, so the rule
// claims the surface it can check and says so rather than firing on both.

import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { consoleSourceModules, readConsoleSource } from "../console-source-modules.js";

/**
 * The one module allowed to scale a byte figure.
 *
 * An allow-list of exactly one, written as a path rather than inferred from a
 * naming convention, so moving the chokepoint is an edit a reviewer sees.
 */
const CHOKEPOINT_MODULE = join("primitives", "wire-figures.ts");

/**
 * The binary unit labels. Naming one of these in a source module is the
 * observable signature of having scaled a byte count for display.
 */
const BINARY_UNIT_LABELS: readonly string[] = ["KiB", "MiB", "GiB", "TiB"];

/**
 * The scaling step, in the forms it can be written.
 *
 * Division only. See the header: multiplying by 1024 bounds a value, dividing by
 * it converts one for a reader.
 */
const SCALING_STEP_FORMS: readonly string[] = [
  "/ 1024",
  "/= 1024",
  "/ BYTE_UNIT_STEP",
  "/= BYTE_UNIT_STEP",
];

/**
 * Every way `source` shows it scaled a byte figure, or `[]`.
 *
 * A pure function over text rather than a loop inside a test, so the negative
 * controls below can drive it with strings whose verdict is known and the checker
 * is proved to bite without perturbing a real module.
 */
function byteScalingSignatures(source: string): readonly string[] {
  return [...BINARY_UNIT_LABELS, ...SCALING_STEP_FORMS].filter((form) => source.includes(form));
}

describe("wire-figure-formatting — byte scaling happens in exactly one module", () => {
  const modules = consoleSourceModules();

  it("finds a console tree to scan at all", () => {
    // Without this, a wrong console directory would scan nothing and every
    // assertion below would pass over the empty set.
    expect(modules.length).toBeGreaterThan(20);
    expect(modules).toContain(CHOKEPOINT_MODULE);
  });

  it("no other module names a binary unit or divides by the scaling step", () => {
    const offenders = modules
      .filter((module) => module !== CHOKEPOINT_MODULE)
      .map((module) => ({ module, signatures: byteScalingSignatures(readConsoleSource(module)) }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${relative(".", entry.module)}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the chokepoint itself trips every signature", () => {
    // The checker reads real files and the needles match real code. Without this,
    // a typo in a needle would make the clean result above meaningless.
    const signatures = byteScalingSignatures(readConsoleSource(CHOKEPOINT_MODULE));
    for (const label of BINARY_UNIT_LABELS) {
      expect(signatures).toContain(label);
    }
    // The division form is asserted as a CLASS, not as one spelling: the module
    // writes `scaled /= BYTE_UNIT_STEP`, and pinning `/ BYTE_UNIT_STEP` here made
    // this control fail against a chokepoint that was doing exactly its job.
    expect(SCALING_STEP_FORMS.filter((form) => signatures.includes(form))).not.toStrictEqual([]);
  });

  it("negative control: a byte cap is not scaling, and a unit label is", () => {
    // The two sides of the line the header draws, asserted against the predicate
    // rather than against whichever module happens to hold a cap today.
    expect(byteScalingSignatures("export const CAP: number = 64 * 1024;")).toStrictEqual([]);
    expect(byteScalingSignatures('const label = "KiB";')).toStrictEqual(["KiB"]);
    expect(byteScalingSignatures("const scaled = total / 1024;")).toStrictEqual(["/ 1024"]);
  });
});

/**
 * A count interpolated straight into JSX, e.g. `{overriddenRowCount}` or
 * `{rows.length}`.
 *
 * The lookbehind is what separates a RENDER from a prop pass: `droppedCount={
 * droppedCount}` and `key={startRequestCount}` hand a number to another component
 * or to React, which formats nothing and displays nothing — the leaf that renders
 * it is where the rule bites. `$` is excluded for the same reason a template
 * interpolation is already covered by the stringify form below.
 */
const RAW_COUNT_IN_JSX = /(?<![=$\w])\{\s*[A-Za-z_$][\w$.]*(?:Count|\.length)\s*\}/g;

/**
 * A count converted for display with `String(...)` rather than through `Intl`.
 *
 * The reference walks identifier and property characters and stops at a subscript,
 * which is what keeps `String(names[names.length - 1])` out: that expression
 * stringifies a NAME the array holds, and its `.length` is computing an index
 * rather than a quantity anybody reads.
 */
const STRINGIFIED_COUNT = /String\(\s*[A-Za-z_$][\w$.]*(?:Count|\.length)\b/g;

/**
 * An `import`/`export … from "…"` statement, which names symbols and renders none.
 *
 * Stripped before the scan because `import { formatCount } from …` is a brace
 * around an identifier ending in `Count` — indistinguishable from a JSX
 * interpolation by shape alone, and the exact opposite of an offender: it is the
 * chokepoint being reached for. Matched only up to the module specifier, so a
 * declaration BODY is never removed and can never hide a count inside it.
 */
const MODULE_SPECIFIER_STATEMENT = /^[ \t]*(?:import|export)\s[^;]*?\sfrom\s+"[^"]*";/gm;

/**
 * Every way `source` shows it displayed a count without the chokepoint, or `[]`.
 *
 * A pure function over text for the same reason its byte-scaling sibling is one:
 * the negative controls drive it with strings whose verdict is known, so the clean
 * result above is a checked claim rather than a checker that matches nothing.
 */
function rawCountSignatures(source: string): readonly string[] {
  const rendered = source.replace(MODULE_SPECIFIER_STATEMENT, "");
  return [...rendered.matchAll(RAW_COUNT_IN_JSX), ...rendered.matchAll(STRINGIFIED_COUNT)].map(
    (match) => match[0],
  );
}

describe("wire-figure-formatting — a displayed count goes through the chokepoint", () => {
  const renderModules = consoleSourceModules().filter((module) => module.endsWith(".tsx"));

  it("finds render modules to scan at all", () => {
    // Without this, a filter that matched nothing would make every assertion below
    // pass over the empty set.
    expect(renderModules.length).toBeGreaterThan(20);
  });

  it("no render module stringifies a count or drops one straight into JSX", () => {
    const offenders = renderModules
      .map((module) => ({ module, signatures: rawCountSignatures(readConsoleSource(module)) }))
      .filter((entry) => entry.signatures.length > 0)
      .map((entry) => `${relative(".", entry.module)}: ${entry.signatures.join(", ")}`);
    expect(offenders).toStrictEqual([]);
  });

  it("negative control: the checker bites on both shapes and spares a prop pass", () => {
    // The two sides of the line the header draws, asserted against the predicate
    // rather than against whichever module happens to hold a count today.
    expect(rawCountSignatures("<span>{overriddenRowCount}</span>")).toStrictEqual([
      "{overriddenRowCount}",
    ]);
    expect(rawCountSignatures("<span>{rows.length}</span>")).toStrictEqual(["{rows.length}"]);
    expect(rawCountSignatures("const more = String(allowlist.length - CAP);")).toStrictEqual([
      "String(allowlist.length",
    ]);
    expect(rawCountSignatures("<Line droppedCount={droppedCount} />")).toStrictEqual([]);
    expect(rawCountSignatures("<div key={startRequestCount} />")).toStrictEqual([]);
    expect(rawCountSignatures("<span>{formatCount(overriddenRowCount)}</span>")).toStrictEqual([]);
  });

  it("negative control: naming the chokepoint is not bypassing it", () => {
    // `import { formatCount }` is a brace around an identifier ending in `Count`,
    // and a rule that could not tell it from a render would fire on every module
    // that obeys the chokepoint — the exact inversion of what it is for.
    expect(
      rawCountSignatures('import { formatCount } from "../primitives/index.js";'),
    ).toStrictEqual([]);
  });

  it("negative control: an index is not a count", () => {
    // `names[names.length - 1]` computes a position, and the value stringified is
    // the name at it. A rule that flagged this would forbid reading the last
    // element of an array by index.
    expect(rawCountSignatures("const last = String(names[names.length - 1]);")).toStrictEqual([]);
  });

  it("negative control: a comparison is not a display", () => {
    // `rows.length === 0` decides whether to render an absence; it puts no figure on
    // screen, and a rule that fired on it would forbid the guard every empty state
    // is built from.
    expect(rawCountSignatures("if (rows.length === 0) { return null; }")).toStrictEqual([]);
  });
});
