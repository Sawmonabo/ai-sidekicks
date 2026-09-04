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

import { DIFF_FILE_ROW_HEIGHT_PX, DIFF_WINDOW_OVERSCAN_ROWS } from "./diff-bounds.js";
import {
  EXTENDED_HEADER_DIFF_SHAPE,
  EXTENDED_HEADER_FIXTURE_FILES,
  SMALL_DIFF_SHAPE,
  buildDiffFixture,
} from "./diff-fixture.js";
import { DIFF_FIXTURE_VIEWPORT_HEIGHT_PX, DiffLayoutFixture } from "./diff-layout-fixture.js";
import { DiffFileList } from "./DiffFileList.js";
import { HIDDEN_SELECTION_COPY } from "./diff-file-entries.js";
import { type ConsoleDiffModel } from "./diff-model.js";

const EXTENDED_HEADER_DIFF = buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE);
const TEXTUAL_ONLY_DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);

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

describe("diff file list — a change set too long to mount", () => {
  /**
   * The mounted-entry ceiling one window may reach.
   *
   * Derived from the bounds rather than picked, exactly as the rows renderer's is:
   * the viewport's own rows plus overscan on both sides, plus the boundary row and
   * the reset control. A list that mounted more than this is not windowing.
   */
  const MAXIMUM_MOUNTED_ENTRY_COUNT =
    Math.ceil(DIFF_FIXTURE_VIEWPORT_HEIGHT_PX / DIFF_FILE_ROW_HEIGHT_PX) +
    DIFF_WINDOW_OVERSCAN_ROWS * 2 +
    2;

  /** A repository-wide patch: five thousand files, one changed line each. */
  const REPOSITORY_WIDE_DIFF = buildDiffFixture({
    fileCount: 5_000,
    hunksPerFile: 1,
    linesPerHunk: 1,
    precedingContextPerHunk: 0,
    agentAttributionEveryNthLine: 0,
    extendedHeaderFiles: false,
    terminalNewlineFile: false,
  });

  function mountedEntryCount(container: HTMLElement): number {
    return container.querySelectorAll(".meridian-diff-files__entry").length;
  }

  it("mounts a window of a five-thousand-file change set rather than all of it", () => {
    // The whole defect: past its threshold the list added a scrolling class and
    // mounted every matching file anyway, so a generated or repository-wide patch
    // cost thousands of buttons before the already virtualized body could help.
    const container = renderFileList(REPOSITORY_WIDE_DIFF);

    expect(mountedEntryCount(container)).toBeLessThanOrEqual(MAXIMUM_MOUNTED_ENTRY_COUNT);
    // And the list is still ABOUT the whole change set: the reset control counts every
    // file, not the handful the window mounted.
    expect(container.querySelector(".meridian-diff-files__entry")?.textContent).toContain("5000");
  });

  it("stays bounded when the filter narrows to thousands of paths", () => {
    // A keystroke rebuilds the entry list, and the list that was rebuilt used to be
    // every matching row. The filter below matches most of the change set on purpose:
    // a bound that only held for a filter matching nothing would hold for the wrong
    // reason.
    const container = renderFileList(REPOSITORY_WIDE_DIFF);
    const filter = container.querySelector<HTMLInputElement>(".meridian-diff-files__filter-input");
    if (filter === null) {
      throw new Error("the list drew no filter input");
    }

    fireEvent.change(filter, { target: { value: "module-" } });

    expect(mountedEntryCount(container)).toBeLessThanOrEqual(MAXIMUM_MOUNTED_ENTRY_COUNT);
    expect(container.querySelector(".meridian-diff-files__no-match")).toBeNull();
  });

  it("opens the window on a selection the window would not otherwise reach", () => {
    // A narrowing whose row is off-window is a control a reader cannot see the state
    // of — and a pane reopened on a file a thousand rows down opens on exactly that.
    const selected = REPOSITORY_WIDE_DIFF.files[4_000]?.path;
    if (selected === undefined) {
      throw new Error("the generated change set is shorter than the case assumes");
    }
    const container = renderFileList(REPOSITORY_WIDE_DIFF, selected);

    const current = container.querySelector('.meridian-diff-files__entry[aria-current="true"]');
    expect(current?.textContent).toContain(selected);
    expect(mountedEntryCount(container)).toBeLessThanOrEqual(MAXIMUM_MOUNTED_ENTRY_COUNT);
  });

  it("negative control: a change set under the threshold mounts every entry", () => {
    // Without this, every bound above would be satisfied by a list that mounted
    // nothing at all — which is what a windowed list does against a viewport a DOM
    // shim reports as zero.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    expect(mountedEntryCount(container)).toBe(SMALL_DIFF_SHAPE.fileCount + 1);
  });
});

describe("diff file list — reaching an entry the window has not mounted", () => {
  /** The entry a browser would move focus to, by the index the row carries. */
  function focusedEntryIndex(container: HTMLElement): number {
    return Number(
      container.ownerDocument.activeElement?.getAttribute("data-entry-index") ?? Number.NaN,
    );
  }

  function firstEntry(container: HTMLElement): HTMLElement {
    const entry = container.querySelector<HTMLElement>(".meridian-diff-files__entry");
    if (entry === null) {
      throw new Error("the list drew no entry");
    }
    return entry;
  }

  it("moves between entries on the arrow keys, because tab can only reach the window", () => {
    // A window mounts the rows a scroll position needs, so tabbing reaches those and
    // no others. The list is one tab stop with the arrows inside it, which is what
    // keeps every entry reachable however few of them are mounted.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    firstEntry(container).focus();

    fireEvent.keyDown(firstEntry(container), { key: "ArrowDown" });
    expect(focusedEntryIndex(container)).toBe(1);

    fireEvent.keyDown(container.ownerDocument.activeElement!, { key: "ArrowUp" });
    expect(focusedEntryIndex(container)).toBe(0);
  });

  it("takes the ends of the list without walking it", () => {
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    firstEntry(container).focus();

    fireEvent.keyDown(firstEntry(container), { key: "End" });
    // The reset control plus one entry per file, so the last index is the file count.
    expect(focusedEntryIndex(container)).toBe(SMALL_DIFF_SHAPE.fileCount);

    fireEvent.keyDown(container.ownerDocument.activeElement!, { key: "Home" });
    expect(focusedEntryIndex(container)).toBe(0);
  });

  it("keeps exactly one entry in the page's tab order", () => {
    // The other half of the composite-widget rule: a windowed list that left every
    // mounted row tabbable would put a moving number of tab stops in the page.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    const tabbable = [...container.querySelectorAll(".meridian-diff-files__entry")].filter(
      (entry) => entry.getAttribute("tabindex") === "0",
    );
    expect(tabbable).toHaveLength(1);
  });

  it("negative control: a key the list does not own moves nothing", () => {
    // Without this, a handler that moved on every key would satisfy the cases above
    // while stealing the character a person is typing into the filter beside it.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    firstEntry(container).focus();

    fireEvent.keyDown(firstEntry(container), { key: "a" });

    expect(focusedEntryIndex(container)).toBe(0);
  });
});

describe("diff file list — a narrowing this filter hides", () => {
  const [FIRST_FILE, SECOND_FILE] = TEXTUAL_ONLY_DIFF.files;
  if (FIRST_FILE === undefined || SECOND_FILE === undefined) {
    throw new Error("the small change set is shorter than these cases assume");
  }

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
