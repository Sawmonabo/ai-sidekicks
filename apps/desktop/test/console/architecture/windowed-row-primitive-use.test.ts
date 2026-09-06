// What a windowed list does with the row primitive: whether it reaches it, and what it
// writes inside it.
//
// TWO OF THE GATE'S FOUR CLAIMS, and the two whose instrument is the TYPESCRIPT PARSER.
// The other two — that the position pair has a single writer, and that an explicit row
// role carries it — are questions about characters and are answered by text scans in
// `windowed-row-position-pair.test.ts` beside this file. The claims were split on that
// seam because they fail separately and because one file carrying all four was doing
// two jobs at ~485 lines. Both files read the same census, `windowed-row-census.ts`, so
// no predicate is written twice.
//
//   3. **A windowed list goes through the row primitive.** Claims 1 and 2 both look for
//      something WRITTEN — a second writer of the position pair, an explicit role tag —
//      and the historical defect wrote NEITHER. A second windowed list in the repos
//      family is invisible to both: it carries no `aria-setsize` so claim 1 has no
//      offender, and it renders bare `<li>` rows inside a `<ul>` with no role attribute
//      so claim 2 has no subject. It passed. So this claim is the one stated in the
//      positive: a module that windows and does not render `WindowedListRow` is an
//      offence, whatever it does or does not write. A windowed list that skips the row
//      primitive tells its reader the list is as long as the window.
//
//      That is also why this claim needs no role regex of its own: routing through the
//      primitive is what supplies the pair, and the primitive's own writing of it is
//      claim 1's subject. The negative control is planted from a real hand-rolled
//      list's markup, so the claim is proved to bite before such a list lands.
//   4. **A windowed row keeps one tab stop.** Stated separately from claim 3 on this
//      gate's own principle that claims which fail separately are stated separately:
//      claim 3 asks whether a list reached the primitive at all, and this one asks what
//      a list that DID reach it wrote inside its rows. A windowed list has one tab stop
//      and the roving index moves it (the APG's roving-tabindex rule), and the
//      primitive writes that stop on the element it renders itself — the wrapper, or
//      the one control a delegating row hands its roving props to. An interactive
//      element a caller writes into a row as ordinary markup keeps its own native stop,
//      which is the moving row count back in the page's tab order, the active row
//      holding two stops, and nothing inside the primitive able to see it. So every
//      `button`, `input`, `select`, `textarea`, or `a[href]` inside a `WindowedListRow`
//      element declares where it sits: an explicit `tabIndex`, or the spread of the
//      row's own target props. Anything else is an offence.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  type ConsoleSourceModule,
  ConsoleSourceTree,
  consoleSourceModules,
  moduleNamed,
  readConsoleSourceModule,
} from "../console-source-modules.js";
import {
  rendersTheRowPrimitive,
  roleTagsMissingPosition,
  undeclaredRowTabStops,
  windowsAList,
  windowsWithoutTheRowPrimitive,
  writesPositionMembers,
  WINDOWED_ROW_MODULE,
  WINDOWED_ROW_PRIMITIVE,
} from "./windowed-row-census.js";

/**
 * A real hand-rolled windowed list, kept as one corpus for the cases that drive it.
 *
 * Bare `<li>` rows inside a `<ul>`, straight off `getVirtualItems()`: no role attribute,
 * so claim 2 has no subject, and no position members, so claim 1 has no offender.
 */
const HAND_ROLLED_LIST = [
  'import { useVirtualizer } from "@tanstack/react-virtual";',
  "const virtualRows = entryWindow.getVirtualItems();",
  "export const list = (",
  '  <ul className="meridian-diff-files__list" onKeyDown={onKeyDown}>',
  "    {virtualRows.map((virtualRow) => (",
  '      <li key={entry.path} className="meridian-diff-files__row" data-index={virtualRow.index}>',
  "        <DiffFileEntryButton entry={entry} />",
  "      </li>",
  "    ))}",
  "  </ul>",
  ");",
].join("\n");

/**
 * The budgets this file states rather than inherits, and why they differ.
 *
 * The same reading cost the sibling file records, and the same posture: the hook pays
 * for the one walk and read and is set well above the loaded cost, because what a
 * budget guards is a reading that never settles rather than a slow one. The cases pay
 * only for scans over sources already in hand, so their budget is smaller — a case that
 * somehow became the first to touch the reading should fail fast and say so.
 *
 * Two files each pay for one reading where one file paid for one, and that is the price
 * of the split, stated rather than hidden: vitest gives each test file its own module
 * registry, so a reading cannot be shared across them. It buys two files a reader can
 * hold, and neither reading is the eight the original file made before it was hoisted.
 */
const CONSOLE_READING_ALLOWANCE_MS = 30_000;
const SCAN_ALLOWANCE_MS = 10_000;

vi.setConfig({ testTimeout: SCAN_ALLOWANCE_MS, hookTimeout: CONSOLE_READING_ALLOWANCE_MS });

/**
 * Row modules planted on disk, so the sibling lookup resolves against a real read.
 *
 * `rowComponentDelegates` answers by NAME against the module set and then reads what
 * that name resolves to, so driving its true arm needs a `<Name>.tsx` that exists and
 * reaches the primitive. No production module does yet — the primitive's first caller
 * is the task its door line names — and a hand-built module record would prove only
 * that the filter runs, not that the resolution does. So the case plants the two
 * shapes it needs and reads them back through the same walk the tree reading uses.
 */
function plantRowSiblingModules(sources: Readonly<Record<string, string>>): {
  readonly modules: readonly ConsoleSourceModule[];
  readonly remove: () => void;
} {
  const plantRoot = mkdtempSync(join(tmpdir(), "windowed-row-siblings-"));
  for (const [name, source] of Object.entries(sources)) {
    writeFileSync(join(plantRoot, name), source, "utf8");
  }
  return {
    modules: consoleSourceModules({ roots: [plantRoot] }),
    remove: () => {
      rmSync(plantRoot, { recursive: true, force: true });
    },
  };
}

const tree = new ConsoleSourceTree();

beforeAll(() => {
  tree.read();
});

describe("windowed rows — a windowed list goes through the row primitive", () => {
  it("control: the tree is walked and read once for the whole file", () => {
    // One reading is a claim about what this file spends, so it is asserted rather than
    // left to the structure looking right — and it is asserted in BOTH split files,
    // because each pays for its own and a control in one says nothing about the other.
    expect(tree.readCount).toBe(1);
    expect(tree.reading.texts.length).toBe(tree.reading.modules.length);
  });

  it("no module windows a list and renders its rows itself", () => {
    const offenders = tree.reading.texts
      .filter((text) =>
        windowsWithoutTheRowPrimitive(text.source, text.displayPath, tree.reading.modules),
      )
      .map((text) => text.displayPath);
    expect(offenders).toStrictEqual([]);
  });

  it("finds the windowing modules, so the clean result is not an empty scan", () => {
    const windowing = tree.reading.texts
      .filter((text) => windowsAList(text.source))
      .map((text) => text.displayPath);
    expect(windowing).toContain(WINDOWED_ROW_MODULE);
    expect(windowing.length).toBeGreaterThan(1);
  });

  it("negative control: a hand-rolled virtualized list is an offence", () => {
    // The markup of a real one, taken from a windowed list that renders bare `<li>`
    // rows inside a `<ul>` — no role attribute, no position pair, straight off
    // `getVirtualItems()`. Claims 1 and 2 both pass on it, which is the whole reason
    // this claim exists; the assertions below say so rather than leaving it implied,
    // and they drive the sibling file's own predicates to say it.
    expect(
      windowsWithoutTheRowPrimitive(HAND_ROLLED_LIST, "HandRolled.tsx", tree.reading.modules),
    ).toBe(true);
    expect(writesPositionMembers(HAND_ROLLED_LIST)).toBe(false);
    expect(roleTagsMissingPosition(HAND_ROLLED_LIST)).toStrictEqual([]);
  });

  it("planted violation: a prose mention of the primitive does not switch the claim off", () => {
    // The smallest violation that PASSED the substring test this claim replaced: one
    // comment carrying the primitive's name, and the whole module left the subject set.
    const excused = [
      "// Deliberately not WindowedListRow: this list places its rows itself.",
      HAND_ROLLED_LIST,
    ].join("\n");
    expect(excused).toContain(WINDOWED_ROW_PRIMITIVE);
    expect(windowsWithoutTheRowPrimitive(excused, "Excused.tsx", tree.reading.modules)).toBe(true);
  });

  it("negative control: a list that renders through the primitive is not", () => {
    const throughThePrimitive = [
      'import { useVirtualizer } from "@tanstack/react-virtual";',
      'import { WindowedListRow } from "../primitives/index.js";',
      "export const rows = entryWindow.getVirtualItems().map((virtualRow) => (",
      "  <WindowedListRow rowIndex={virtualRow.index} totalRowCount={total} />",
      "));",
    ].join("\n");
    expect(
      windowsWithoutTheRowPrimitive(throughThePrimitive, "Through.tsx", tree.reading.modules),
    ).toBe(false);
    // And a module that windows nothing is outside the claim entirely, rather than an
    // offence for not naming a primitive it has no use for.
    expect(
      windowsWithoutTheRowPrimitive(
        "export const total = rows.length;",
        "x.ts",
        tree.reading.modules,
      ),
    ).toBe(false);
  });

  it("negative control: a map that reaches the primitive itself is admitted", () => {
    // The early arm: the primitive is inside the `.map(`, so no row was placed for it
    // to have been placed instead of, and the sibling lookup is never asked. Both
    // spellings, because a row that wraps its content and one that self-closes are the
    // same answer to the claim.
    const composed = [
      "export const list = entryWindow.getVirtualItems().map((virtualRow) => (",
      "  <WindowedListRow rowIndex={virtualRow.index} totalRowCount={total} />",
      "));",
    ].join("\n");
    const wrapped = [
      "export const list = entryWindow.getVirtualItems().map((virtualRow) => (",
      "  <li key={virtualRow.key}>",
      "    <WindowedListRow rowIndex={virtualRow.index} totalRowCount={total} />",
      "  </li>",
      "));",
    ].join("\n");
    const rowsOwnModule = moduleNamed(
      tree.reading.modules,
      WINDOWED_ROW_MODULE,
      "the row primitive",
    );
    expect(readConsoleSourceModule(rowsOwnModule)).toContain(WINDOWED_ROW_PRIMITIVE);
    expect(windowsWithoutTheRowPrimitive(composed, "Composed.tsx", tree.reading.modules)).toBe(
      false,
    );
    expect(windowsWithoutTheRowPrimitive(wrapped, "Wrapped.tsx", tree.reading.modules)).toBe(false);
  });

  it("negative control: rows extracted into a sibling component are admitted", () => {
    // The other direction the substring test got wrong, and the ordinary answer once a
    // row grows: the windowing module names no primitive at all, its `.map(` places a
    // bare `<li>`, and the row inside it is a sibling component that DOES reach the
    // primitive. This is the case that executes `rowComponentDelegates`' true arm —
    // the map above never reaches it, because a primitive inside the map answers the
    // claim before the siblings are looked at.
    const delegating = [
      'import { useVirtualizer } from "@tanstack/react-virtual";',
      "const virtualRows = entryWindow.getVirtualItems();",
      "export const list = (",
      '  <ul className="meridian-diff-files__list">',
      "    {virtualRows.map((virtualRow) => (",
      "      <li key={entry.path} data-index={virtualRow.index}>",
      "        <DiffFileRow entry={entry} />",
      "      </li>",
      "    ))}",
      "  </ul>",
      ");",
    ].join("\n");
    expect(delegating).not.toContain(WINDOWED_ROW_PRIMITIVE);

    const planted = plantRowSiblingModules({
      // The delegating sibling: a row of its own that renders the primitive.
      "DiffFileRow.tsx": `export const DiffFileRow = () => <${WINDOWED_ROW_PRIMITIVE} as="li">{entry.path}</${WINDOWED_ROW_PRIMITIVE}>;`,
      // The sibling `HAND_ROLLED_LIST` names, so that corpus's row RESOLVES here and is
      // still an offence — which separates "no module of that name" from "a module that
      // does not reach the primitive", the two ways the false arm is reached.
      "DiffFileEntryButton.tsx":
        'export const DiffFileEntryButton = () => <button type="button">{entry.path}</button>;',
    });
    try {
      const modules = [...tree.reading.modules, ...planted.modules];
      expect(
        planted.modules.map((module) => module.displayPath.split("/").at(-1)).sort(),
      ).toStrictEqual(["DiffFileEntryButton.tsx", "DiffFileRow.tsx"]);

      expect(windowsWithoutTheRowPrimitive(delegating, "DiffFileList.tsx", modules)).toBe(false);
      expect(windowsWithoutTheRowPrimitive(HAND_ROLLED_LIST, "HandRolled.tsx", modules)).toBe(true);
    } finally {
      planted.remove();
    }
  });

  it("planted violation: a sibling that only MENTIONS the primitive does not delegate", () => {
    // The other half of the substring defect, and the half that outlived the first: the
    // sibling lookup asked whether the row's OWN module contained the primitive's name,
    // so a row module carrying the same excusing comment as the violation above admitted
    // its whole windowing caller — claim 3's false pass, moved one module along.
    const mentionsOnly = [
      "// Deliberately not WindowedListRow: this row places itself.",
      'export const DiffFileRow = () => <li className="meridian-diff-files__row" />;',
    ].join("\n");
    // The old predicate's whole question, so the fail-first direction is stated rather
    // than remembered: it says yes, and the parser says no.
    expect(mentionsOnly).toContain(WINDOWED_ROW_PRIMITIVE);
    expect(rendersTheRowPrimitive(mentionsOnly, "DiffFileRow.tsx")).toBe(false);
    // Both JSX forms, because the ELEMENT is what the claim reads: a row that wraps its
    // content opens and closes, and one that takes a render function self-closes.
    const selfClosing = 'export const DiffFileRow = () => <WindowedListRow as="li" />;';
    const wrapping =
      'export const DiffFileRow = () => <WindowedListRow as="li">{path}</WindowedListRow>;';
    expect(rendersTheRowPrimitive(selfClosing, "DiffFileRow.tsx")).toBe(true);
    expect(rendersTheRowPrimitive(wrapping, "DiffFileRow.tsx")).toBe(true);
  });

  it("negative control: the read is over the WINDOW and not over any list", () => {
    // A windowing module that also maps an ordinary array into host elements — a row of
    // badges, a header — is not placing windowed rows, and a claim that swept those in
    // would be answered by moving the markup rather than by going through the primitive.
    const otherList = [
      'import { useVirtualizer } from "@tanstack/react-virtual";',
      "export const badges = labels.map((label) => <div key={label}>{label}</div>);",
    ].join("\n");
    expect(windowsWithoutTheRowPrimitive(otherList, "Other.tsx", tree.reading.modules)).toBe(false);
  });
});

describe("windowed rows — a row keeps one tab stop", () => {
  it("no console module writes an interactive element into a row that keeps its own stop", () => {
    const offenders = tree.reading.texts.flatMap((text) =>
      undeclaredRowTabStops(text.source, text.displayPath).map(
        (tag) => `${text.displayPath}: ${tag}`,
      ),
    );
    expect(offenders).toStrictEqual([]);
    // Said out loud rather than left implicit, on claim 2's precedent: no production
    // module mounts a windowed row yet, so this claim has no subject TODAY and the
    // planted controls below are what keep the zero from meaning "the predicate is
    // broken". It arms the moment a family lands its first windowed list. The scan
    // itself is asserted non-empty so a walk that stopped reading fails here.
    expect(tree.reading.texts.length).toBeGreaterThan(20);
  });

  it("negative control: content written as markup is an offence", () => {
    // The exact shape the primitive shipped with, and what it cost: the roving index
    // went on the `<li>` and the button kept its native stop, so the active row had two
    // stops and every mounted row was in the page's tab order.
    const asMarkup = [
      "export const row = (",
      '  <WindowedListRow as="li" rowIndex={index} totalRowCount={total} isTabbable>',
      '    <button type="button">{entry.path}</button>',
      "  </WindowedListRow>",
      ");",
    ].join("\n");
    expect(undeclaredRowTabStops(asMarkup, "Offender.tsx")).toStrictEqual([
      '<button type="button">',
    ]);
  });

  it("negative control: the delegated control is not, and a foreign spread still is", () => {
    // The admitted spelling is the row's OWN target props, read by the parameter name
    // the row bound them to. A spread of anything else says nothing about the tab
    // order, and admitting every spread would have been the false pass this claim is
    // for.
    const delegated = [
      "export const row = (",
      '  <WindowedListRow as="li" rowIndex={index} totalRowCount={total} isTabbable>',
      '    {(targetProps) => <button type="button" {...targetProps} />}',
      "  </WindowedListRow>",
      ");",
    ].join("\n");
    expect(undeclaredRowTabStops(delegated, "Delegated.tsx")).toStrictEqual([]);
    const foreignSpread = delegated.replace("{...targetProps}", "{...props}");
    expect(undeclaredRowTabStops(foreignSpread, "Foreign.tsx")).toStrictEqual([
      '<button type="button" {...props} />',
    ]);
  });

  it("negative control: an explicit tab index is a declaration, and a row's own content is not this rule’s business", () => {
    const explicit = [
      "export const row = (",
      '  <WindowedListRow as="li" rowIndex={index} totalRowCount={total} isTabbable>',
      '    <button type="button" tabIndex={-1}>{entry.path}</button>',
      "  </WindowedListRow>",
      ");",
    ].join("\n");
    expect(undeclaredRowTabStops(explicit, "Explicit.tsx")).toStrictEqual([]);
    const inert = [
      "export const row = (",
      '  <WindowedListRow as="li" rowIndex={index} totalRowCount={total} isTabbable>',
      '    <span className="meridian-diff-files__path">{entry.path}</span>',
      "    <a>{entry.path}</a>",
      "  </WindowedListRow>",
      ");",
    ].join("\n");
    expect(undeclaredRowTabStops(inert, "Inert.tsx")).toStrictEqual([]);
    // And a button outside any row is a button, not a windowed row’s tab stop.
    expect(undeclaredRowTabStops('export const save = <button type="button" />;', "Plain.tsx")) //
      .toStrictEqual([]);
  });
});
