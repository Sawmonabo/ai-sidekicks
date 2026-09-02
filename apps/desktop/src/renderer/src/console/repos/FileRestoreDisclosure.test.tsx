// What the restore disclosure puts on screen, and what it refuses to.
//
// The cases drive the real component against real `RollbackInterventionResult` values
// rather than a stand-in, and each clean assertion is paired with the case that would
// pass if the surface stopped doing the thing: "never silent" is only meaningful
// beside the empty pair that must still render, and the partial/unrestored split is
// only meaningful beside the two sentences that must differ.

import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RollbackInterventionResult } from "@ai-sidekicks/contracts";

import { FileRestoreDisclosure } from "./FileRestoreDisclosure.js";

const OVERWRITTEN_PATH = "build/.env.local";
const DIVERGENT_GITLINK = "vendor/upstream";

function appliedRestore(
  overrides: Partial<Extract<RollbackInterventionResult, { disposition: "files-restored" }>> = {},
): RollbackInterventionResult {
  return {
    disposition: "files-restored",
    overwrittenIgnoredPaths: [OVERWRITTEN_PATH],
    divergentGitlinks: [DIVERGENT_GITLINK],
    ...overrides,
  };
}

describe("FileRestoreDisclosure — the two enumerations are never silent", () => {
  it("names both enumerations and their counts on a restore that mutated the tree", () => {
    const { container } = render(<FileRestoreDisclosure result={appliedRestore()} />);
    expect(container.textContent).toContain("Overwritten ignored paths");
    expect(container.textContent).toContain("Divergent gitlinks");
    expect(container.textContent).toContain(OVERWRITTEN_PATH);
    expect(container.textContent).toContain(DIVERGENT_GITLINK);
  });

  it("renders both enumerations even when both are empty", () => {
    // The contract types them REQUIRED and empty-when-none, so an empty pair is a
    // reading and not an absence. Dropping the labels would make the surface silent
    // in exactly the case the design says it may not be.
    const { container } = render(
      <FileRestoreDisclosure
        result={appliedRestore({ overwrittenIgnoredPaths: [], divergentGitlinks: [] })}
      />,
    );
    expect(container.textContent).toContain("Overwritten ignored paths");
    expect(container.textContent).toContain("Divergent gitlinks");
  });

  it("never presents an empty pair as an all-clear", () => {
    const { container } = render(
      <FileRestoreDisclosure
        result={appliedRestore({ overwrittenIgnoredPaths: [], divergentGitlinks: [] })}
      />,
    );
    expect(container.textContent).toContain("not an all-clear");
  });

  it("negative control: a non-empty pair carries no not-an-all-clear sentence", () => {
    // Without this, a component that printed the sentence unconditionally would pass
    // the case above while saying something false about a restore that did enumerate.
    const { container } = render(<FileRestoreDisclosure result={appliedRestore()} />);
    expect(container.textContent).not.toContain("not an all-clear");
  });

  it("carries the enumerations on the degraded partial restore too", () => {
    const { container } = render(
      <FileRestoreDisclosure
        result={{
          disposition: "files-partially-restored",
          failedStep: "checkout tree",
          overwrittenIgnoredPaths: [OVERWRITTEN_PATH],
          divergentGitlinks: [],
        }}
      />,
    );
    expect(container.textContent).toContain(OVERWRITTEN_PATH);
    expect(container.textContent).toContain("Divergent gitlinks");
  });

  it("carries the enumerations on resend-unapplied, which displaces a completed file leg", () => {
    const { container } = render(
      <FileRestoreDisclosure
        result={{
          disposition: "resend-unapplied",
          resendDisposition: "unapplied",
          overwrittenIgnoredPaths: [OVERWRITTEN_PATH],
          divergentGitlinks: [],
        }}
      />,
    );
    expect(container.textContent).toContain(OVERWRITTEN_PATH);
    expect(container.textContent).toContain("Overwritten ignored paths");
  });

  it("negative control: a disposition that mutated nothing carries no enumerations", () => {
    // The enumerations are not decoration. A surface that drew two empty lists on
    // `pause-only` would be reporting an absence of mutation as a reading of one.
    const { container } = render(<FileRestoreDisclosure result={{ disposition: "pause-only" }} />);
    expect(container.textContent).not.toContain("Overwritten ignored paths");
    expect(container.textContent).toContain("carries no path enumerations");
  });
});

describe("FileRestoreDisclosure — the partial restore is never collapsed", () => {
  it("names the failed step and says earlier effects are still on disk", () => {
    const { container } = render(
      <FileRestoreDisclosure
        result={{
          disposition: "files-partially-restored",
          failedStep: "checkout tree",
          overwrittenIgnoredPaths: [],
          divergentGitlinks: [],
        }}
      />,
    );
    expect(container.textContent).toContain("checkout tree");
    expect(container.textContent).toContain("still on disk");
  });

  it("negative control: files-unrestored says the opposite, and says it differently", () => {
    // The one collapse the design forbids. If the two arms shared a sentence, a late
    // failure that left effects on disk would read as a rewind that touched nothing.
    const partial = render(
      <FileRestoreDisclosure
        result={{
          disposition: "files-partially-restored",
          failedStep: "checkout tree",
          overwrittenIgnoredPaths: [],
          divergentGitlinks: [],
        }}
      />,
    );
    const unrestored = render(
      <FileRestoreDisclosure result={{ disposition: "files-unrestored" }} />,
    );
    expect(unrestored.container.textContent).toContain("No file was restored");
    expect(unrestored.container.textContent).not.toContain("still on disk");
    expect(partial.container.textContent).not.toBe(unrestored.container.textContent);
  });

  it("routes the empty-pair copy through the failed step where one exists", () => {
    const { container } = render(
      <FileRestoreDisclosure
        result={{
          disposition: "files-partially-restored",
          failedStep: "restore submodules",
          overwrittenIgnoredPaths: [],
          divergentGitlinks: [],
        }}
      />,
    );
    expect(container.textContent).toContain("The failed step above is what names how far");
  });
});

describe("FileRestoreDisclosure — the boundary arm's nullable position", () => {
  it("renders both positions where the boundary row carries one", () => {
    const { container } = render(
      <FileRestoreDisclosure
        result={{
          disposition: "boundary-diverged",
          confirmedPosition: 12,
          newestBoundaryPosition: 9,
        }}
      />,
    );
    expect(container.textContent).toContain("12");
    expect(container.textContent).toContain("9");
  });

  it("states the cause where the compaction row carries no position", () => {
    // Required-and-nullable on the wire: an explicit `null` names a position-less
    // compaction row, so rendering it as a missing value would report the console's
    // silence as the daemon's.
    const { container } = render(
      <FileRestoreDisclosure
        result={{
          disposition: "boundary-diverged",
          confirmedPosition: 12,
          newestBoundaryPosition: null,
        }}
      />,
    );
    expect(container.textContent).toContain("carries no position");
    expect(container.textContent).toContain("every target of this run");
  });

  it("negative control: the null arm does not print a boundary number", () => {
    const { container } = render(
      <FileRestoreDisclosure
        result={{
          disposition: "boundary-diverged",
          confirmedPosition: 12,
          newestBoundaryPosition: null,
        }}
      />,
    );
    expect(container.textContent).not.toContain("newest boundary at");
  });
});

describe("FileRestoreDisclosure — a read surface that offers nothing", () => {
  it("opens a path in the diff pane when the mount supplies the navigation", () => {
    const onOpenPath = vi.fn();
    const { container } = render(
      <FileRestoreDisclosure result={appliedRestore()} onOpenPath={onOpenPath} />,
    );
    const pathButtons = within(container).getAllByRole("button");
    expect(pathButtons).toHaveLength(2);
    fireEvent.click(pathButtons[0] as HTMLElement);
    expect(onOpenPath).toHaveBeenCalledWith(OVERWRITTEN_PATH);
  });

  it("negative control: with no navigation supplied, nothing on the surface is pressable", () => {
    // "Offers: nothing." The path link exists only where the mount can honour it, so
    // a disclosure with no diff behind it renders text rather than a dead control.
    const { container } = render(<FileRestoreDisclosure result={appliedRestore()} />);
    expect(within(container).queryAllByRole("button")).toHaveLength(0);
  });

  it("labels the enumerations as paths and names no ref or branch", () => {
    // Never surface a snapshot ref as a branch — nothing here renders a ref at all.
    const { container } = render(<FileRestoreDisclosure result={appliedRestore()} />);
    expect(container.textContent).not.toContain("refs/");
    expect(container.textContent?.toLowerCase()).not.toContain("branch");
  });
});
