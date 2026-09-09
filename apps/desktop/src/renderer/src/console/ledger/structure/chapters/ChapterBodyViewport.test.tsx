// The chapter body, held to the thing it exists to undo: rows that were counted and
// unreachable.
//
// Every case reads the RENDERED body, because the defect this component answers was a
// figure with nothing behind it — a case over the fold alone would have passed against
// a console that drew no body at all.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CHAPTER_VISIBLE_ROW_CAP } from "../../../core/index.js";
import {
  CHAPTER_BODY_FALLBACK_VIEWPORT_HEIGHT,
  CHAPTER_BODY_INTRINSIC_VIEWPORT_HEIGHT,
} from "./chapter-body.js";
import { ChapterBodyViewport } from "./ChapterBodyViewport.js";
import { foldChapters } from "./chapters.js";
import { chapterFor } from "./chapters.test-support.js";
import { runRow } from "../timeline-rows.test-support.js";
import { type TimelineRow } from "@ai-sidekicks/contracts";

const RUN_ID = "run-a";

function longRun(extraRows: number): readonly TimelineRow[] {
  return Array.from({ length: CHAPTER_VISIBLE_ROW_CAP + extraRows }, (_unused, index) =>
    runRow({
      id: `r${String(index + 1)}`,
      sequence: index + 1,
      type: "run.running",
      summary: `entry ${String(index + 1)}`,
      runId: RUN_ID,
      position: index + 1,
    }),
  );
}

function renderBody(
  rows: readonly TimelineRow[],
  narrowedRowIds?: readonly string[],
): HTMLElement | null {
  const sealed = chapterFor(foldChapters(rows).chapters, RUN_ID);
  const chapter =
    narrowedRowIds === undefined
      ? sealed
      : { ...sealed, rowIds: narrowedRowIds, rowCount: narrowedRowIds.length };
  const { container } = render(
    <ChapterBodyViewport chapter={chapter} supportsDeclaration={() => true} />,
  );
  return container.querySelector<HTMLElement>(".meridian-chapter-body");
}

describe("the chapter body — the head the outer list left out", () => {
  it("draws nothing at all for a chapter that clips nothing", () => {
    expect(renderBody(longRun(-1))).toBeNull();
  });

  it("draws the clipped rows, which were previously a figure and nothing else", () => {
    const body = renderBody(longRun(2));
    expect(body?.textContent).toContain("entry 1");
    expect(body?.textContent).toContain("entry 2");
    // The rows the outer list mounts are ITS job; the body never draws them twice.
    expect(body?.textContent).not.toContain(`entry ${String(CHAPTER_VISIBLE_ROW_CAP + 2)}`);
  });

  it("sets the height the engine agreed to on the scroller itself", () => {
    const scroller = renderBody(longRun(2))?.querySelector<HTMLElement>(
      ".meridian-chapter-body__scroller",
    );
    expect(scroller?.style.maxBlockSize).toBe(CHAPTER_BODY_INTRINSIC_VIEWPORT_HEIGHT);
  });

  it("falls back to a length every engine parses where the expression is refused", () => {
    const sealed = chapterFor(foldChapters(longRun(2)).chapters, RUN_ID);
    const { container } = render(
      <ChapterBodyViewport chapter={sealed} supportsDeclaration={() => false} />,
    );
    expect(
      container.querySelector<HTMLElement>(".meridian-chapter-body__scroller")?.style.maxBlockSize,
    ).toBe(CHAPTER_BODY_FALLBACK_VIEWPORT_HEIGHT);
  });

  it("re-pins through the engine's own anchoring rather than a second scroll writer", () => {
    const scroller = renderBody(longRun(2))?.querySelector<HTMLElement>(
      ".meridian-chapter-body__scroller",
    );
    expect(scroller).not.toBeNull();
    expect(scroller?.scrollTop).toBe(0);
  });
});

describe("the top-edge fade — drawn only while something is clipped above", () => {
  it("draws no fade at the top of the body", () => {
    expect(renderBody(longRun(2))?.querySelector(".meridian-chapter-body__fade")).toBeNull();
  });

  it("draws the fade once the body has been scrolled off its top", () => {
    const body = renderBody(longRun(2));
    const scroller = body?.querySelector<HTMLElement>(".meridian-chapter-body__scroller");
    if (scroller === null || scroller === undefined) {
      throw new Error("the body drew no scroller");
    }
    fireEvent.scroll(scroller, { target: { scrollTop: 24 } });
    expect(body?.querySelector(".meridian-chapter-body__fade")).not.toBeNull();
  });
});

describe("what the body does not hold", () => {
  it("says how many earlier entries are outside its own window", () => {
    const body = renderBody(longRun(CHAPTER_VISIBLE_ROW_CAP + 3));
    expect(body?.textContent).toContain("3 earlier entries are outside this window.");
  });

  it("asks only for the rows a narrowing admitted, never the whole run's", () => {
    const admitted = [
      "r1",
      "r2",
      ...Array.from(
        { length: CHAPTER_VISIBLE_ROW_CAP },
        (_unused, index) => `r${String(index + 3)}`,
      ),
    ];
    const body = renderBody(longRun(40), admitted);
    // Two admitted rows sit outside the ceiling, so the body draws exactly those two —
    // and not the thirty-eight the unnarrowed chapter would have clipped.
    expect(body?.querySelectorAll(".meridian-chapter-body__row")).toHaveLength(2);
    expect(body?.textContent).toContain("entry 1");
    expect(body?.textContent).toContain("entry 2");
  });
});
