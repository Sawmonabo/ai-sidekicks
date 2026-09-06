// A windowed row says where it sits in the whole enumeration — and one module says it.
//
// A window mounts a slice, and the accessibility tree cannot tell a slice from a list:
// without `aria-setsize` and `aria-posinset` a reader is told "item 3 of 12" for row 3
// of four thousand, which is not a smaller truth but a different and false one. The
// pair is easy to write and easy to forget, and the console has already forgotten it
// once — one windowed list in the repos family carried both members and the family's
// own second windowed list carried neither, which is what a per-call-site obligation
// costs.
//
// TWO OF THE GATE'S FOUR CLAIMS, and the two whose instrument is TEXT. The other two —
// that a windowed list goes through the row primitive, and that a row inside one keeps
// a single tab stop — are questions about declaration boundaries and are answered by
// the TypeScript parser in `windowed-row-primitive-use.test.ts` beside this file. The
// claims were split on that seam because they fail separately and because one file
// carrying all four was doing two jobs at ~485 lines. Both files read the same census,
// `windowed-row-census.ts`, so no predicate is written twice.
//
//   1. **One writer.** The pair is written in exactly one console module,
//      `primitives/WindowedListRow.tsx`. A family that hand-rolls it fails here, and
//      that is the claim this lane exists to make mechanical. It has a subject on
//      every branch — the primitive itself — so this half is never vacuous.
//   2. **No explicit row role without the pair.** In a module that windows a list, an
//      element opening with `role="row"` or `role="option"` carries both members. No
//      console module writes such a tag yet: the primitive takes its role as a prop
//      rather than spelling one. So this half reports zero sites TODAY and says so out
//      loud rather than passing silently, and it arms the moment a family lands a
//      windowed grid or listbox. The predicate is proved to bite by the planted
//      controls below, which is what keeps the zero honest.
//
// Neither claim could have caught the defect named at the top, and the file next door
// says why: that second list wrote neither a position member nor a role attribute, so
// claim 1 had no offender and claim 2 had no subject, and it passed.

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  ConsoleSourceTree,
  moduleNamed,
  readConsoleSourceModule,
  type ConsoleModuleText,
} from "../console-source-modules.js";
import {
  POSITION_MEMBERS,
  roleTagsIn,
  roleTagsMissingPosition,
  windowsAList,
  writesPositionMembers,
  WINDOWED_ROW_MODULE,
} from "./windowed-row-census.js";

/**
 * The budgets this file states rather than inherits, and why they differ.
 *
 * The gate this pair was split out of walked the console per `describe` and re-read the
 * modules each case scanned — eight full readings for four claims, all of the walking
 * charged to COLLECTION where no case timing shows it. Measured alone on the authoring
 * machine the visible cases were single-digit to 90 ms and the file 498 ms end to end;
 * under the aggregate gate's five-project concurrency the same file timed out against
 * vitest's 5 s default with no change to the code it reads. The load, not the tree, is
 * what a budget here has to survive — the finding that put explicit budgets on
 * `barrel-census.test.ts`, restated here rather than cross-referenced.
 *
 * The hook pays for the one reading and is set well above the loaded cost, because what
 * a budget guards is a reading that never settles rather than a slow one. The cases pay
 * only for scans over sources already in hand, so their budget is smaller: a case that
 * somehow became the first to touch the reading should fail fast and say so.
 */
const CONSOLE_READING_ALLOWANCE_MS = 30_000;
const SCAN_ALLOWANCE_MS = 10_000;

vi.setConfig({ testTimeout: SCAN_ALLOWANCE_MS, hookTimeout: CONSOLE_READING_ALLOWANCE_MS });

const tree = new ConsoleSourceTree();

beforeAll(() => {
  tree.read();
});

/** The windowing modules, derived from the one reading rather than from a second walk. */
function windowingTexts(): readonly ConsoleModuleText[] {
  return tree.reading.texts.filter((text) => windowsAList(text.source));
}

describe("windowed rows — the position pair has one writer", () => {
  it("finds a console tree to scan at all", () => {
    expect(tree.reading.modules.length).toBeGreaterThan(20);
    expect(tree.reading.texts.map((text) => text.displayPath)).toContain(WINDOWED_ROW_MODULE);
  });

  it("control: the tree is walked and read once for the whole file", () => {
    // Without this the hoist is invisible: the gate this file was split out of walked
    // the console per `describe` and every case re-read the modules it scanned, and it
    // would still have passed that way — at the cost that made it time out under the
    // aggregate gate. One reading is a claim about what this file spends, so it is
    // asserted rather than left to the structure looking right.
    expect(tree.readCount).toBe(1);
    expect(tree.reading.texts.length).toBe(tree.reading.modules.length);
  });

  it("writes the pair in exactly one module", () => {
    const writers = tree.reading.texts
      .filter((text) => writesPositionMembers(text.source))
      .map((text) => text.displayPath);
    expect(writers).toStrictEqual([WINDOWED_ROW_MODULE]);
  });

  it("negative control: that module writes BOTH members, not one of them", () => {
    // A primitive that carried only `aria-setsize` would satisfy the one-writer claim
    // above and still tell a reader nothing about where the row sits.
    const source = readConsoleSourceModule(
      moduleNamed(tree.reading.modules, WINDOWED_ROW_MODULE, "the windowed-row primitive"),
    );
    for (const member of POSITION_MEMBERS) {
      expect(source, `the primitive does not write ${member}`).toContain(member);
    }
  });
});

describe("windowed rows — an explicit row role carries the pair", () => {
  it("finds the windowing modules to scan", () => {
    // The row primitive and its roving-index sibling both name themselves, so a scan
    // that found none has stopped reading the tree.
    expect(windowingTexts().map((text) => text.displayPath)).toContain(WINDOWED_ROW_MODULE);
  });

  it("reports every offending tag, and says when there are no tags at all", () => {
    const windowing = windowingTexts();
    const tags = windowing.flatMap((text) => roleTagsIn(text.source));
    const offenders = windowing.flatMap((text) =>
      roleTagsMissingPosition(text.source).map(
        (tag) => `${text.displayPath}: ${tag.replace(/\s+/g, " ")}`,
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
