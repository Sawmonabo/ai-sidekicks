// The changed-file list, and the change it used to render as nothing.
//
// A rename, a copy, a mode change, and a binary change all live in a git patch's
// extended headers and produce no hunks, so such a file counted `+0 −0` and its
// entry read as a path nothing had happened to. The subject is the family's own
// fixture, parsed by the real parser, so what is asserted is what the console
// renders for a patch a daemon could actually send.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  EXTENDED_HEADER_DIFF_SHAPE,
  EXTENDED_HEADER_FIXTURE_FILES,
  SMALL_DIFF_SHAPE,
  buildDiffFixture,
} from "./diff-fixture.js";
import { DiffFileList } from "./DiffFileList.js";
import { type ConsoleDiffModel } from "./diff-model.js";

const EXTENDED_HEADER_DIFF = buildDiffFixture(EXTENDED_HEADER_DIFF_SHAPE);
const TEXTUAL_ONLY_DIFF = buildDiffFixture(SMALL_DIFF_SHAPE);

function renderFileList(diff: ConsoleDiffModel): HTMLElement {
  return render(
    <DiffFileList diff={diff} selectedFilePath={undefined} onSelectFilePath={() => undefined} />,
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
