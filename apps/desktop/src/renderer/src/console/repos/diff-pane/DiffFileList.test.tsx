// The changed-file list: the change it used to render as nothing, and the change set
// it used to render all of.
//
// A rename, a copy, a mode change, and a binary change all live in a git patch's
// extended headers and produce no hunks, so such a file counted `+0 −0` and its
// entry read as a path nothing had happened to. The subject is the family's own
// fixture, parsed by the real parser, so what is asserted is what the console
// renders for a patch a daemon could actually send.
//
// AND THE LIST IS WINDOWED, so every case here states the pane's height: a window is
// computed against a viewport, and happy-dom reports every box as zero. Without the
// layout fixture a bound on the mounted row count is satisfied by a list that mounted
// nothing, which is the state that makes such a bound meaningless.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDiffFixture } from "./diff-fixture.js";
import {
  EXTENDED_HEADER_DIFF_SHAPE,
  EXTENDED_HEADER_FIXTURE_FILES,
  SMALL_DIFF_SHAPE,
} from "./diff-fixture-shapes.js";
import {
  DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
  DiffLayoutFixture,
} from "./diff-layout-fixture.test-support.js";
import { DiffFileList } from "./DiffFileList.js";
import { HIDDEN_SELECTION_COPY } from "./diff-file-entries.js";
import { type ConsoleDiffModel } from "./diff-model.js";

const EXTENDED_HEADER_DIFF = buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE);
const TEXTUAL_ONLY_DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);

/**
 * A repository-wide patch: five thousand files, one changed line each.
 *
 * Built once for the whole file, because two describes need it and a change set this
 * size is the only subject a windowing claim can be made against at all.
 */
const REPOSITORY_WIDE_DIFF = buildDiffFixture({
  fileCount: 5_000,
  hunksPerFile: 1,
  linesPerHunk: 1,
  precedingContextPerHunk: 0,
  agentAttributionEveryNthLine: 0,
  extendedHeaderFiles: false,
  terminalNewlineFile: false,
});

const layout = new DiffLayoutFixture();

beforeEach(() => {
  layout.install({ viewportHeightPx: DIFF_FIXTURE_VIEWPORT_HEIGHT_PX });
});

afterEach(() => {
  layout.restore();
});

function renderFileList(diff: ConsoleDiffModel, selectedFilePath?: string): HTMLElement {
  return render(
    <DiffFileList
      diff={diff}
      selectedFilePath={selectedFilePath}
      onSelectFilePath={() => undefined}
    />,
  ).container;
}

/** The entry for one path, as the list drew it. */
function entryFor(container: HTMLElement, path: string): HTMLElement {
  const entry = [...container.querySelectorAll<HTMLElement>(".meridian-diff-files__entry")].find(
    (candidate) => candidate.querySelector(".meridian-diff-files__path")?.textContent === path,
  );
  if (entry === undefined) {
    throw new Error(`the list drew no entry for ${path}`);
  }
  return entry;
}

/**
 * One file of a change set, by index.
 *
 * Thrown for rather than answered as optional, because a fixture shorter than a case
 * assumes is a broken case and not a state to assert about — and a `function`
 * declaration below carries no narrowing a guard beside the fixture would have made.
 */
function fixtureFileAt(
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
function filterTo(container: HTMLElement, filterText: string): void {
  const filter = container.querySelector<HTMLInputElement>(".meridian-diff-files__filter-input");
  if (filter === null) {
    throw new Error("the list drew no filter input");
  }
  fireEvent.change(filter, { target: { value: filterText } });
}

/** The change note on one path's entry, or `undefined` where it drew none. */
function changeNoteFor(container: HTMLElement, path: string): string | undefined {
  return (
    entryFor(container, path).querySelector(".meridian-diff-files__change")?.textContent ??
    undefined
  );
}

describe("diff file list — a change that lives only in the extended headers", () => {
  it("names the path a rename came from, beside counts that are still zero", () => {
    const container = renderFileList(EXTENDED_HEADER_DIFF);
    const { renamed } = EXTENDED_HEADER_FIXTURE_FILES;
    expect(changeNoteFor(container, renamed.to)).toBe(`renamed from ${renamed.from}`);
    // The counts stay: they are true, and a suppressed pair would make this the
    // one row a reader cannot compare with its neighbours.
    expect(entryFor(container, renamed.to).textContent).toContain("+0");
  });

  it("tells a copy from a rename, because the source still exists", () => {
    const { copied } = EXTENDED_HEADER_FIXTURE_FILES;
    expect(changeNoteFor(renderFileList(EXTENDED_HEADER_DIFF), copied.to)).toBe(
      `copied from ${copied.from}`,
    );
  });

  it("renders a mode change as both modes, so which direction is legible", () => {
    const { modeChanged } = EXTENDED_HEADER_FIXTURE_FILES;
    expect(changeNoteFor(renderFileList(EXTENDED_HEADER_DIFF), modeChanged.path)).toBe(
      `mode ${modeChanged.from} → ${modeChanged.to}`,
    );
  });

  it("marks a binary file, whose change no unified patch can show", () => {
    expect(
      changeNoteFor(
        renderFileList(EXTENDED_HEADER_DIFF),
        EXTENDED_HEADER_FIXTURE_FILES.binary.path,
      ),
    ).toBe("binary file changed");
  });

  it("negative control: an ordinary change draws no note at all", () => {
    // Without this, a list that stamped every entry with a note would pass every
    // case above while telling a reader that every file in the change set had
    // moved.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    expect(container.querySelectorAll(".meridian-diff-files__change")).toHaveLength(0);
  });

  it("negative control: the filter still matches the path and not the note", () => {
    // The note is a second string on every entry, and the filter's subject is the
    // wire-verbatim path — a filter that searched the note would surface a file
    // under a path the list is not showing.
    const container = renderFileList(EXTENDED_HEADER_DIFF);
    const filter = container.querySelector<HTMLInputElement>(".meridian-diff-files__filter-input");
    if (filter === null) {
      throw new Error("the list drew no filter input");
    }
    fireEvent.change(filter, { target: { value: EXTENDED_HEADER_FIXTURE_FILES.renamed.from } });
    expect(container.querySelector(".meridian-diff-files__no-match")).not.toBeNull();
  });
});

describe("diff file list — a narrowing this filter hides", () => {
  const FIRST_FILE = fixtureFileAt(TEXTUAL_ONLY_DIFF, 0);
  const SECOND_FILE = fixtureFileAt(TEXTUAL_ONLY_DIFF, 1);

  /** The list, narrowed to the first file and filtered to the second. */
  function renderWithHiddenNarrowing(): {
    readonly container: HTMLElement;
    readonly onSelectFilePath: ReturnType<typeof vi.fn>;
  } {
    const onSelectFilePath = vi.fn<(path: string | undefined) => void>();
    const { container } = render(
      <DiffFileList
        diff={TEXTUAL_ONLY_DIFF}
        selectedFilePath={FIRST_FILE.path}
        onSelectFilePath={onSelectFilePath}
      />,
    );
    filterTo(container, SECOND_FILE.path);
    return { container, onSelectFilePath };
  }

  it("marks no row current, because the row the narrowing is on is not drawn", () => {
    // The whole defect: the hidden narrowing fell back to row zero, so "All files"
    // took `aria-current` while the renderer beside it went on showing one file.
    const { container } = renderWithHiddenNarrowing();

    expect(container.querySelector('.meridian-diff-files__entry[aria-current="true"]')).toBeNull();
    expect(container.textContent).toContain(HIDDEN_SELECTION_COPY);
  });

  it("keeps the narrowing the participant chose rather than clearing it", () => {
    // The filter is a way of looking at the list; the narrowing is a choice. Clearing
    // it here would change what the pane renders as a side effect of typing.
    const { onSelectFilePath } = renderWithHiddenNarrowing();

    expect(onSelectFilePath).not.toHaveBeenCalled();
  });

  it("marks the row current again once the filter stops hiding it", () => {
    const { container } = renderWithHiddenNarrowing();

    filterTo(container, "");

    const current = container.querySelector('.meridian-diff-files__entry[aria-current="true"]');
    expect(current?.textContent).toContain(FIRST_FILE.path);
    expect(container.textContent).not.toContain(HIDDEN_SELECTION_COPY);
  });

  it("negative control: a filter that still shows the narrowing marks its row", () => {
    // Without this the cases above would pass against a list that marked nothing
    // current and printed the line under every filter anybody typed.
    const { container } = render(
      <DiffFileList
        diff={TEXTUAL_ONLY_DIFF}
        selectedFilePath={FIRST_FILE.path}
        onSelectFilePath={() => undefined}
      />,
    );

    filterTo(container, FIRST_FILE.path);

    const current = container.querySelector('.meridian-diff-files__entry[aria-current="true"]');
    expect(current?.textContent).toContain(FIRST_FILE.path);
    expect(container.textContent).not.toContain(HIDDEN_SELECTION_COPY);
  });
});

describe("diff file list — a move made in a list that then changed", () => {
  /** The mounted entries the page can tab to, which is at most one of them. */
  function tabbableEntryCount(container: HTMLElement): number {
    return [...container.querySelectorAll(".meridian-diff-files__entry")].filter(
      (entry) => entry.getAttribute("tabindex") === "0",
    ).length;
  }

  function firstEntry(container: HTMLElement): HTMLElement {
    const entry = container.querySelector<HTMLElement>(".meridian-diff-files__entry");
    if (entry === null) {
      throw new Error("the list drew no entry");
    }
    return entry;
  }

  it("keeps the list in the page's tab order after a filter comes and goes", () => {
    // The whole defect: the move survived the filter that shrank the entry set, so
    // clearing the filter restored an index a thousand rows below the window and left
    // every mounted button `tabIndex={-1}` — a file list a keyboard could not enter.
    const container = renderFileList(REPOSITORY_WIDE_DIFF);
    fireEvent.keyDown(firstEntry(container), { key: "End" });

    filterTo(container, "module-01");
    filterTo(container, "");

    expect(tabbableEntryCount(container)).toBe(1);
  });

  it("negative control: a move inside an unchanged list still stands", () => {
    // Without this the case above would pass against a list that dropped the moved
    // position on every render, which would put the keyboard back at the top after
    // every arrow key.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    fireEvent.keyDown(firstEntry(container), { key: "End" });

    const tabbable = container.querySelector('.meridian-diff-files__entry[tabindex="0"]');
    expect(tabbable?.closest(".meridian-diff-files__row")?.getAttribute("data-index")).toBe(
      String(SMALL_DIFF_SHAPE.fileCount),
    );
  });
});
