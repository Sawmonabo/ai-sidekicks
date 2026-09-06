// How both file-list suites put the list on screen and reach into what it drew.
//
// SPLIT BY SUBJECT, NOT BY SCAFFOLDING. `DiffFileList.test.tsx` is about what one ENTRY
// is and `DiffFileList.windowing.test.tsx` is about which entries are MOUNTED, and that
// split was made by copying the mount and the two readers into both files rather than
// hoisting them. Nothing failed when one copy changed, which is the whole reason a
// helper used twice is declared once.

import { fireEvent, render } from "@testing-library/react";

import { DiffFileList } from "./DiffFileList.js";
import { type ConsoleDiffModel } from "./diff-model.js";

/** Mount the list over one change set, with the selection the case is about. */
export function renderFileList(diff: ConsoleDiffModel, selectedFilePath?: string): HTMLElement {
  return render(
    <DiffFileList
      diff={diff}
      selectedFilePath={selectedFilePath}
      onSelectFilePath={() => undefined}
    />,
  ).container;
}

/**
 * One file of a change set, by index.
 *
 * Thrown for rather than answered as optional, because a fixture shorter than a case
 * assumes is a broken case and not a state to assert about — and a `function`
 * declaration carries no narrowing a guard beside the fixture would have made.
 */
export function fixtureFileAt(
  diff: ConsoleDiffModel,
  fileIndex: number,
): ConsoleDiffModel["files"][number] {
  const file = diff.files[fileIndex];
  if (file === undefined) {
    throw new Error(`the generated change set has no file at ${String(fileIndex)}`);
  }
  return file;
}

/** Type into the list's own filter, which is how every filtering case narrows it. */
export function filterTo(container: HTMLElement, filterText: string): void {
  const filter = container.querySelector<HTMLInputElement>(".meridian-diff-files__filter-input");
  if (filter === null) {
    throw new Error("the list drew no filter input");
  }
  fireEvent.change(filter, { target: { value: filterText } });
}
