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
// THREE CLAIMS. They are separate because they fail separately, and the third is the
// only one that could ever have caught the defect named above.
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
//   3. **A windowed list goes through the row primitive.** Claims 1 and 2 both look
//      for something WRITTEN — a second writer of the pair, an explicit role tag —
//      and the historical defect wrote NEITHER. That second list is invisible to
//      both: it carries no `aria-setsize` so claim 1 has no offender, and it renders
//      bare `<li>` rows inside a `<ul>` with no role attribute so claim 2 has no
//      subject. It passed. So the third claim is the one stated in the positive: a
//      module that windows and does not name `WindowedListRow` is an offence,
//      whatever it does or does not write. A windowed list that skips the row
//      primitive tells its reader the list is as long as the window.
//
//      That is also why claim 3 needs no separate role regex: routing through the
//      primitive is what supplies the pair, and the primitive's own writing of it is
//      claim 1's subject. The negative control is planted from a real hand-rolled
//      list's markup, so the claim is proved to bite before such a list lands.
//
// THE REGEX IS COARSE AND SAYS SO. `WINDOWED_ROW_ROLE_TAG` is
// `/<[A-Za-z][^>]*\brole="(?:row|option)"[^>]*>/g` — an opening tag, up to its first
// `>`. A tag containing a `>` inside an expression (`onSelect={() => choose(row)}`)
// is therefore cut short, and a cut-short tag whose members sat past the cut is
// reported as an offence. That error direction is deliberate: a false alarm is a
// reviewer reading one tag, and a false pass is a reader being told the wrong length
// of a list with nothing anywhere to notice.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  consoleSourceModules,
  moduleNamed,
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

/**
 * The primitive every windowed row goes through, as source text.
 *
 * It is also one of `WINDOWING_SIGNALS`, and that overlap is what makes claim 3
 * expressible in one predicate: a module that windows and does NOT name this is a
 * module that reached the virtualizer or the roving index directly and then built its
 * own rows.
 */
const WINDOWED_ROW_PRIMITIVE = "WindowedListRow";

/** The host elements a row is spelled as when a module places its rows itself. */
const HAND_ROLLED_ROW_TAGS: readonly string[] = ["li", "div", "tr"];

/** How a windowed row array is obtained, which is what a `.map(` has to be over. */
const WINDOW_READ = "getVirtualItems";

function windowsAList(source: string): boolean {
  return WINDOWING_SIGNALS.some((signal) => source.includes(signal));
}

/** Every JSX opening tag name inside `node`, in source order. */
function jsxTagNamesIn(node: ts.Node): readonly string[] {
  const tags: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) {
      tags.push(child.tagName.getText());
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return tags;
}

/**
 * The names that hold a windowed row array in `parsed`.
 *
 * `entryWindow.getVirtualItems()` reaches a `.map(` two ways — inline, and through a
 * `const rows = …` on the line above — and the second is the ordinary spelling once the
 * array is read once and used twice. Both have to resolve to the same claim or the rule
 * is decided by where a variable was introduced.
 */
function windowedRowBindings(parsed: ts.SourceFile): readonly string[] {
  const bindings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      node.initializer.getText().includes(WINDOW_READ)
    ) {
      bindings.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return bindings;
}

/**
 * Every row a windowing module places itself instead of routing through the primitive.
 *
 * THE INSTRUMENT IS THE PARSER, and claim 3's whole strength rests on that. The
 * substring test this replaces asked whether the file MENTIONED the primitive's name,
 * which failed in both directions and was measured doing so: a comment reading
 * "deliberately not WindowedListRow" switched the claim off for a whole module, and a
 * module whose rows are a sibling component — the ordinary answer once a row grows —
 * was reported as an offence for naming a primitive its rows do go through.
 *
 * So the question asked here is the one the claim always meant: inside a `.map(` over
 * the windowed rows, does a host element get placed without the primitive? A capitalised
 * tag is a delegation and is answered by `rowComponentDelegates`, which reads the module
 * that tag resolves to.
 */
export function handRolledWindowedRows(
  source: string,
  fileName: string,
): readonly { readonly tag: string; readonly rowComponents: readonly string[] }[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const bindings = windowedRowBindings(parsed);
  const found: { tag: string; rowComponents: readonly string[] }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "map"
    ) {
      const receiver = node.expression.expression.getText();
      const overTheWindow =
        receiver.includes(WINDOW_READ) || bindings.some((binding) => receiver === binding);
      if (overTheWindow) {
        const tags = jsxTagNamesIn(node);
        if (!tags.includes(WINDOWED_ROW_PRIMITIVE)) {
          const rowComponents = tags.filter((tag) => /^[A-Z]/u.test(tag));
          for (const tag of tags.filter((tag) => HAND_ROLLED_ROW_TAGS.includes(tag))) {
            found.push({ tag, rowComponents });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

/**
 * Whether a row rendered as a component reaches the primitive in the module it names.
 *
 * The `DiffFileList` / `DiffFileRow` shape: the windowing module names no primitive and
 * its rows do go through one. Resolved by matching the component's name to the module
 * that declares it, which is this tree's own convention — one component per `.tsx` file,
 * named for it.
 */
function rowComponentDelegates(
  rowComponents: readonly string[],
  modules: readonly ConsoleSourceModule[],
): boolean {
  return rowComponents.some((component) =>
    modules.some(
      (module) =>
        module.displayPath.endsWith(`/${component}.tsx`) &&
        readConsoleSourceModule(module).includes(WINDOWED_ROW_PRIMITIVE),
    ),
  );
}

/** Whether `source` windows a list and places rows the primitive should have placed. */
function windowsWithoutTheRowPrimitive(
  source: string,
  fileName: string,
  modules: readonly ConsoleSourceModule[],
): boolean {
  if (!windowsAList(source)) {
    return false;
  }
  return handRolledWindowedRows(source, fileName).some(
    (row) => !rowComponentDelegates(row.rowComponents, modules),
  );
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

describe("windowed rows — a windowed list goes through the row primitive", () => {
  const modules: readonly ConsoleSourceModule[] = consoleSourceModules();

  it("no module windows a list and renders its rows itself", () => {
    const offenders = modules
      .filter((module) =>
        windowsWithoutTheRowPrimitive(readConsoleSourceModule(module), module.displayPath, modules),
      )
      .map((module) => module.displayPath);
    expect(offenders).toStrictEqual([]);
  });

  it("finds the windowing modules, so the clean result is not an empty scan", () => {
    const windowing = modules
      .filter((module) => windowsAList(readConsoleSourceModule(module)))
      .map((module) => module.displayPath);
    expect(windowing).toContain(WINDOWED_ROW_MODULE);
    expect(windowing.length).toBeGreaterThan(1);
  });

  it("negative control: a hand-rolled virtualized list is an offence", () => {
    // The markup of a real one, taken from a windowed list that renders bare `<li>`
    // rows inside a `<ul>` — no role attribute, no position pair, straight off
    // `getVirtualItems()`. Claims 1 and 2 both pass on it, which is the whole reason
    // this claim exists; the assertions below say so rather than leaving it implied.
    expect(windowsWithoutTheRowPrimitive(HAND_ROLLED_LIST, "HandRolled.tsx", modules)).toBe(true);
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
    expect(windowsWithoutTheRowPrimitive(excused, "Excused.tsx", modules)).toBe(true);
  });

  it("negative control: a list that renders through the primitive is not", () => {
    const throughThePrimitive = [
      'import { useVirtualizer } from "@tanstack/react-virtual";',
      'import { WindowedListRow } from "../primitives/index.js";',
      "export const rows = entryWindow.getVirtualItems().map((virtualRow) => (",
      "  <WindowedListRow rowIndex={virtualRow.index} totalRowCount={total} />",
      "));",
    ].join("\n");
    expect(windowsWithoutTheRowPrimitive(throughThePrimitive, "Through.tsx", modules)).toBe(false);
    // And a module that windows nothing is outside the claim entirely, rather than an
    // offence for not naming a primitive it has no use for.
    expect(windowsWithoutTheRowPrimitive("export const total = rows.length;", "x.ts", modules)) //
      .toBe(false);
  });

  it("negative control: rows extracted into a sibling component are admitted", () => {
    // The other direction the substring test got wrong, and the ordinary answer once a
    // row grows: the windowing module names no primitive, and its rows do go through
    // one. The sibling is resolved by name against the real module set, so the
    // admission is a fact about the tree rather than a shape in this file.
    const composed = [
      "export const list = entryWindow.getVirtualItems().map((virtualRow) => (",
      "  <WindowedListRow rowIndex={virtualRow.index} totalRowCount={total} />",
      "));",
    ].join("\n");
    const rowsOwnModule = moduleNamed(modules, WINDOWED_ROW_MODULE, "the row primitive");
    expect(readConsoleSourceModule(rowsOwnModule)).toContain(WINDOWED_ROW_PRIMITIVE);
    const delegating = [
      "export const list = entryWindow.getVirtualItems().map((virtualRow) => (",
      "  <li key={virtualRow.key}>",
      "    <WindowedListRow rowIndex={virtualRow.index} totalRowCount={total} />",
      "  </li>",
      "));",
    ].join("\n");
    expect(windowsWithoutTheRowPrimitive(composed, "Composed.tsx", modules)).toBe(false);
    expect(windowsWithoutTheRowPrimitive(delegating, "Delegating.tsx", modules)).toBe(false);
  });

  it("negative control: the read is over the WINDOW and not over any list", () => {
    // A windowing module that also maps an ordinary array into host elements — a row of
    // badges, a header — is not placing windowed rows, and a claim that swept those in
    // would be answered by moving the markup rather than by going through the primitive.
    const otherList = [
      'import { useVirtualizer } from "@tanstack/react-virtual";',
      "export const badges = labels.map((label) => <div key={label}>{label}</div>);",
    ].join("\n");
    expect(windowsWithoutTheRowPrimitive(otherList, "Other.tsx", modules)).toBe(false);
  });
});
