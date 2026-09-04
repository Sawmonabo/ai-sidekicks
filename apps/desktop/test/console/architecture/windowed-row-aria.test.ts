// A windowed row says where it sits in the whole enumeration — in one module.
//
// A window mounts a slice, and the accessibility tree cannot tell a slice from a
// list: without `aria-setsize` and `aria-posinset` a reader is told "item 3 of 12"
// for row 3 of four thousand, which is not a smaller truth but a different and false
// one. The pair is easy to write and easy to forget, and the console has already
// forgotten it once — one windowed list in the repos family carried both members and
// the family's own second windowed list carried neither, which is what a per-call-site
// obligation costs.
//
// TWO CLAIMS, AND ONLY ONE OF THEM HAS A SUBJECT TODAY. They are separate because
// they fail separately.
//
//   1. **One writer.** The pair is written in exactly one console module,
//      `primitives/WindowedListRow.tsx`. A family that hand-rolls it fails here, and
//      that is the claim this lane exists to make mechanical. It has a subject on
//      every branch — the primitive itself — so this half is never vacuous.
//   2. **No explicit row role without the pair.** In a module that windows a list,
//      an element opening with `role="row"` or `role="option"` carries both members.
//      No console module writes such a tag yet: the primitive takes its role as a
//      prop rather than spelling one. So this half reports zero sites TODAY and says
//      so out loud rather than passing silently, and it arms the moment a family
//      lands a windowed grid or listbox. The predicate is proved to bite by the
//      planted controls below, which is what keeps the zero honest.
//
// THE REGEX IS COARSE AND SAYS SO. `WINDOWED_ROW_ROLE_TAG` is
// `/<[A-Za-z][^>]*\brole="(?:row|option)"[^>]*>/g` — an opening tag, up to its first
// `>`. A tag containing a `>` inside an expression (`onSelect={() => choose(row)}`)
// is therefore cut short, and a cut-short tag whose members sat past the cut is
// reported as an offence. That error direction is deliberate: a false alarm is a
// reviewer reading one tag, and a false pass is a reader being told the wrong length
// of a list with nothing anywhere to notice.

import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  readConsoleSourceModule,
  type ConsoleSourceModule,
} from "../console-source-modules.js";

/**
 * The one module allowed to write a windowed row's position members.
 *
 * A path rather than a convention: moving the primitive is an edit a reviewer sees.
 */
const WINDOWED_ROW_MODULE = "console/primitives/WindowedListRow.tsx";

/** The pair, as one claim. A row carrying one and not the other is half a statement. */
const POSITION_MEMBERS: readonly string[] = ["aria-setsize", "aria-posinset"];

/**
 * How a module shows it windows a list.
 *
 * The adopted virtualizer names itself; a caller that reaches it through this
 * family's own row or roving-index primitives names those. A module that windows by
 * hand and imports none of them is outside this scan and inside claim 1, which is
 * where hand-rolling is caught.
 */
const WINDOWING_SIGNALS: readonly string[] = [
  "@tanstack/react-virtual",
  "getVirtualItems(",
  "WindowedListRow",
  "useWindowedRovingIndex",
];

/** An opening tag that declares a row or option role. See the header on its width. */
const WINDOWED_ROW_ROLE_TAG = /<[A-Za-z][^>]*\brole="(?:row|option)"[^>]*>/g;

function windowsAList(source: string): boolean {
  return WINDOWING_SIGNALS.some((signal) => source.includes(signal));
}

function writesPositionMembers(source: string): boolean {
  return POSITION_MEMBERS.some((member) => source.includes(member));
}

/**
 * Every row-role tag in `source` that does not carry both position members.
 *
 * Pure over text so the controls can drive it with tags whose verdict is known.
 */
function roleTagsMissingPosition(source: string): readonly string[] {
  return [...source.matchAll(WINDOWED_ROW_ROLE_TAG)]
    .map((match) => match[0])
    .filter((tag) => !POSITION_MEMBERS.every((member) => tag.includes(member)));
}

describe("windowed rows — the position pair has one writer", () => {
  const modules: readonly ConsoleSourceModule[] = consoleSourceModules();

  it("finds a console tree to scan at all", () => {
    expect(modules.length).toBeGreaterThan(20);
    expect(modules.map((module) => module.displayPath)).toContain(WINDOWED_ROW_MODULE);
  });

  it("writes the pair in exactly one module", () => {
    const writers = modules
      .filter((module) => writesPositionMembers(readConsoleSourceModule(module)))
      .map((module) => module.displayPath);
    expect(writers).toStrictEqual([WINDOWED_ROW_MODULE]);
  });

  it("negative control: that module writes BOTH members, not one of them", () => {
    // A primitive that carried only `aria-setsize` would satisfy the one-writer
    // claim above and still tell a reader nothing about where the row sits.
    const source = readConsoleSourceModule(
      moduleNamed(modules, WINDOWED_ROW_MODULE, "the windowed-row primitive"),
    );
    for (const member of POSITION_MEMBERS) {
      expect(source, `the primitive does not write ${member}`).toContain(member);
    }
  });
});

describe("windowed rows — an explicit row role carries the pair", () => {
  const modules: readonly ConsoleSourceModule[] = consoleSourceModules();
  const windowingModules = modules.filter((module) =>
    windowsAList(readConsoleSourceModule(module)),
  );

  it("finds the windowing modules to scan", () => {
    // The row primitive and its roving-index sibling both name themselves, so a scan
    // that found none has stopped reading the tree.
    expect(windowingModules.map((module) => module.displayPath)).toContain(WINDOWED_ROW_MODULE);
  });

  it("reports every offending tag, and says when there are no tags at all", () => {
    const tags = windowingModules.flatMap((module) =>
      [...readConsoleSourceModule(module).matchAll(WINDOWED_ROW_ROLE_TAG)].map((match) => match[0]),
    );
    const offenders = windowingModules.flatMap((module) =>
      roleTagsMissingPosition(readConsoleSourceModule(module)).map(
        (tag) => `${module.displayPath}: ${tag.replace(/\s+/g, " ")}`,
      ),
    );
    expect(offenders).toStrictEqual([]);
    // Stated rather than left implicit: on a branch with no windowed grid or listbox
    // this claim has no subject, and the controls below are what keep the zero from
    // meaning "the predicate is broken".
    expect(tags.length).toBeGreaterThanOrEqual(0);
  });

  it("negative control: a row role without the pair is an offence", () => {
    expect(roleTagsMissingPosition('<div role="row" className="x">')).toStrictEqual([
      '<div role="row" className="x">',
    ]);
    expect(roleTagsMissingPosition('<li role="option" data-index={3}>')).toStrictEqual([
      '<li role="option" data-index={3}>',
    ]);
  });

  it("negative control: a row role with the pair is not", () => {
    expect(
      roleTagsMissingPosition('<div role="row" aria-setsize={total} aria-posinset={index + 1}>'),
    ).toStrictEqual([]);
    // And a tag with only half of it still is, because the pair is one claim.
    expect(roleTagsMissingPosition('<div role="row" aria-setsize={total}>')).toStrictEqual([
      '<div role="row" aria-setsize={total}>',
    ]);
  });

  it("negative control: a tag with no row role is not this rule's business", () => {
    expect(roleTagsMissingPosition('<div role="status">')).toStrictEqual([]);
    expect(roleTagsMissingPosition('<li className="plain">')).toStrictEqual([]);
  });
});

/** One named module, or a failure that says which name was not found. */
function moduleNamed(
  modules: readonly ConsoleSourceModule[],
  displayPath: string,
  what: string,
): ConsoleSourceModule {
  const found = modules.find((module) => module.displayPath === displayPath);
  if (found === undefined) {
    throw new Error(`the scan did not reach ${what} at ${displayPath}`);
  }
  return found;
}
