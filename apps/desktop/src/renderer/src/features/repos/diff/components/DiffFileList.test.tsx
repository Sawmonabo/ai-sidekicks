// The changed-file list over the diff tests' fixture, parsed by the real parser. A rename, copy,
// mode change or binary change lives only in a patch's extended headers and has no hunks, so its
// entry must still say what changed. Every case states the pane height: the list is windowed and
// happy-dom reports every box as zero, so a bound on mounted rows would hold for an empty list.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDiffFixture } from "@test/helpers/diff-fixture.js";
import {
  EXTENDED_HEADER_DIFF_SHAPE,
  EXTENDED_HEADER_FIXTURE_FILES,
  SMALL_DIFF_SHAPE,
} from "@test/helpers/diff-fixture-shapes.js";
import {
  DIFF_FIXTURE_VIEWPORT_HEIGHT_PX,
  DiffLayoutFixture,
} from "@test/helpers/diff-layout-fixture.js";
import { DiffFileList } from "./DiffFileList.js";
import {
  REPOSITORY_WIDE_DIFF,
  filterTo,
  firstEntry,
  fixtureFileAt,
  renderFileList,
  tabbableEntryCount,
} from "./diff-file-list.test-support.js";
import { HIDDEN_SELECTION_COPY } from "../diff-file-entries.js";

const EXTENDED_HEADER_DIFF = buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE);
const TEXTUAL_ONLY_DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);

const layout = new DiffLayoutFixture();

beforeEach(() => {
  layout.install({ viewportHeightPx: DIFF_FIXTURE_VIEWPORT_HEIGHT_PX });
});

afterEach(() => {
  layout.restore();
});

function entryFor(container: HTMLElement, path: string): HTMLElement {
  const entry = [...container.querySelectorAll<HTMLElement>(".meridian-diff-files__entry")].find(
    (candidate) => candidate.querySelector(".meridian-diff-files__path")?.textContent === path,
  );
  if (entry === undefined) {
    throw new Error(`the list drew no entry for ${path}`);
  }
  return entry;
}

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
    // The counts stay: they are true, and a suppressed pair would make this the one row a
    // reader cannot compare with its neighbors.
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
    // Negative control: a list stamping every entry with a note would pass the cases above.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    expect(container.querySelectorAll(".meridian-diff-files__change")).toHaveLength(0);
  });

  it("negative control: the filter still matches the path and not the note", () => {
    // The filter's subject is the wire-verbatim path; searching the note would surface a file
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
    // The hidden narrowing must not fall back to row zero: "All files" would take
    // `aria-current` while the renderer beside it goes on showing one file.
    const { container } = renderWithHiddenNarrowing();

    expect(container.querySelector('.meridian-diff-files__entry[aria-current="true"]')).toBeNull();
    expect(container.textContent).toContain(HIDDEN_SELECTION_COPY);
  });

  it("keeps the narrowing the user chose rather than clearing it", () => {
    // The filter is a way of looking at the list and the narrowing is a choice; clearing it
    // here would change what the pane renders as a side effect of typing.
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
    // Negative control: a list that marked nothing current and printed the line under every
    // filter would pass the cases above.
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

describe("diff file list — the filter belongs to the change set it filters", () => {
  function filterInputText(container: HTMLElement): string {
    return (
      container.querySelector<HTMLInputElement>(".meridian-diff-files__filter-input")?.value ?? ""
    );
  }

  it("drops the filter when the pane is pointed at another change set", () => {
    // The list is not keyed, so a bare register would keep the previous change set's filter
    // and draw "No changed file matches that filter." over a change set that has files.
    const { container, rerender } = render(
      <DiffFileList
        diff={EXTENDED_HEADER_DIFF}
        selectedFilePath={undefined}
        onSelectFilePath={() => undefined}
      />,
    );
    filterTo(container, fixtureFileAt(EXTENDED_HEADER_DIFF, 0).path);
    expect(filterInputText(container)).not.toBe("");

    rerender(
      <DiffFileList
        diff={TEXTUAL_ONLY_DIFF}
        selectedFilePath={undefined}
        onSelectFilePath={() => undefined}
      />,
    );

    expect(filterInputText(container)).toBe("");
    expect(container.textContent).not.toContain("No changed file matches that filter.");
  });

  it("negative control: a re-render at the same change set keeps what was typed", () => {
    // Negative control: a filter cleared on every render would pass above and erase a user's
    // narrowing on any pane update, since a pane layout composes fresh props each render.
    const { container, rerender } = render(
      <DiffFileList
        diff={TEXTUAL_ONLY_DIFF}
        selectedFilePath={undefined}
        onSelectFilePath={() => undefined}
      />,
    );
    const typed = fixtureFileAt(TEXTUAL_ONLY_DIFF, 0).path;
    filterTo(container, typed);

    rerender(
      <DiffFileList
        diff={TEXTUAL_ONLY_DIFF}
        selectedFilePath={undefined}
        onSelectFilePath={() => undefined}
      />,
    );

    expect(filterInputText(container)).toBe(typed);
  });
});

describe("diff file list — a move made in a list that then changed", () => {
  it("keeps the list in the page's tab order after a filter comes and goes", () => {
    // A move must not survive a filter that shrank the entry set: clearing the filter would
    // restore an index far below the window and leave every mounted button `tabIndex={-1}`.
    const container = renderFileList(REPOSITORY_WIDE_DIFF);
    fireEvent.keyDown(firstEntry(container), { key: "End" });

    filterTo(container, "module-01");
    filterTo(container, "");

    expect(tabbableEntryCount(container)).toBe(1);
  });

  it("negative control: a move inside an unchanged list still stands", () => {
    // Negative control: a list that dropped the moved position on every render would put the
    // keyboard back at the top after every arrow key.
    const container = renderFileList(TEXTUAL_ONLY_DIFF);
    fireEvent.keyDown(firstEntry(container), { key: "End" });

    const tabbable = container.querySelector('.meridian-diff-files__entry[tabindex="0"]');
    expect(tabbable?.closest(".meridian-diff-files__row")?.getAttribute("data-index")).toBe(
      String(SMALL_DIFF_SHAPE.fileCount),
    );
  });
});
