// The mount and readers for the file-list suite, `DiffFileList.test.tsx`.

import { fireEvent, render } from "@testing-library/react";

import { DiffFileList } from "./DiffFileList.js";
import { buildDiffFixture } from "@test/helpers/diff/fixture/fixture.js";
import { liveBridgeWrapper } from "@test/helpers/app/frame-fixtures.js";
import { type DiffModel } from "../diff-model.js";

/**
 * A repository-wide patch: five thousand files, one changed line each. A windowing claim can
 * only be made against a change set this size, so it is built once for the whole suite.
 */
export const REPOSITORY_WIDE_DIFF: DiffModel = buildDiffFixture({
  fileCount: 5_000,
  hunksPerFile: 1,
  linesPerHunk: 1,
  precedingContextPerHunk: 0,
  extendedHeaderFiles: false,
  terminalNewlineFile: false,
});

/** Mount the list over one change set, with the selection the case is about. */
export function renderFileList(diff: DiffModel, selectedFilePath?: string): HTMLElement {
  return render(
    <DiffFileList
      diff={diff}
      selectedFilePath={selectedFilePath}
      onSelectFilePath={() => undefined}
    />,
    { wrapper: liveBridgeWrapper() },
  ).container;
}

/**
 * One file of a change set, by index. Throws on a missing file: a fixture shorter than a case
 * assumes is a broken case, not a state to assert about.
 */
export function fixtureFileAt(diff: DiffModel, fileIndex: number): DiffModel["files"][number] {
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

/** The list's first mounted entry; throws when none is drawn, as `fixtureFileAt` does. */
export function firstEntry(container: HTMLElement): HTMLElement {
  const entry = container.querySelector<HTMLElement>(".meridian-diff-files__entry");
  if (entry === null) {
    throw new Error("the list drew no entry");
  }
  return entry;
}

/** The mounted entries the page can tab to, which is at most one of them. */
export function tabbableEntryCount(container: HTMLElement): number {
  return [...container.querySelectorAll(".meridian-diff-files__entry")].filter(
    (entry) => entry.getAttribute("tabindex") === "0",
  ).length;
}
