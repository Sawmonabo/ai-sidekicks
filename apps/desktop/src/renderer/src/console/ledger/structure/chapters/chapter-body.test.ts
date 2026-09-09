// The chapter body's bounds: the height the engine agreed to, where the clip falls,
// and how much of the head the body can still reach.
//
// The height cases drive BOTH arms through the injected probe rather than through the
// host's own engine: a case that only ever took the arm this runner supports would
// pass on a host that answers the other way and prove nothing about it.

import { describe, expect, it } from "vitest";

import { CHAPTER_VISIBLE_ROW_CAP } from "../../../core/index.js";
import {
  CHAPTER_BODY_FALLBACK_VIEWPORT_HEIGHT,
  CHAPTER_BODY_INTRINSIC_VIEWPORT_HEIGHT,
  ChapterBodyRowWindow,
  chapterClippedHeadRowCount,
  chapterClippedHeadRowIds,
  resolveChapterBodyViewportHeight,
} from "./chapter-body.js";
import { runRow } from "../timeline-rows.test-support.js";

function chapterRow(sequence: number): ReturnType<typeof runRow> {
  return runRow({
    id: `r${String(sequence)}`,
    sequence,
    type: "run.running",
    runId: "run-a",
    position: sequence,
  });
}

describe("the body's height — validated before it is applied", () => {
  it("takes the intrinsic expression where the engine parses it", () => {
    expect(resolveChapterBodyViewportHeight(() => true)).toBe(
      CHAPTER_BODY_INTRINSIC_VIEWPORT_HEIGHT,
    );
  });

  it("falls back to a length every engine parses where it does not", () => {
    expect(resolveChapterBodyViewportHeight(() => false)).toBe(
      CHAPTER_BODY_FALLBACK_VIEWPORT_HEIGHT,
    );
  });

  it("asks about the property it is going to set", () => {
    const asked: string[] = [];
    resolveChapterBodyViewportHeight((property, value) => {
      asked.push(`${property}: ${value}`);
      return true;
    });
    expect(asked).toEqual([`max-height: ${CHAPTER_BODY_INTRINSIC_VIEWPORT_HEIGHT}`]);
  });
});

describe("where the clip falls", () => {
  it("clips nothing while the chapter is under the ceiling", () => {
    expect(chapterClippedHeadRowIds(["a", "b", "c"])).toEqual([]);
  });

  it("clips the OLDER head, never the newest rows", () => {
    const rowIds = Array.from({ length: CHAPTER_VISIBLE_ROW_CAP + 3 }, (_unused, index) =>
      String(index),
    );
    const head = chapterClippedHeadRowIds(rowIds);
    expect(head).toEqual(["0", "1", "2"]);
    expect(head).not.toContain(String(CHAPTER_VISIBLE_ROW_CAP + 2));
  });

  it("returns one identity for every empty head, so a memo over it does not re-run", () => {
    expect(chapterClippedHeadRowIds(["a"])).toBe(chapterClippedHeadRowIds(["b", "c"]));
  });

  it("counts the clip from the chapter's length alone, without building the list", () => {
    // The count is what a sealed chapter carries, and it is arithmetic rather than
    // the length of a list nobody keeps: a chapter of ten thousand rows used to be
    // sliced into a ten-thousand-element array so that a number could be read off
    // it and the array thrown away.
    expect(chapterClippedHeadRowCount(CHAPTER_VISIBLE_ROW_CAP - 1)).toBe(0);
    expect(chapterClippedHeadRowCount(CHAPTER_VISIBLE_ROW_CAP)).toBe(0);
    expect(chapterClippedHeadRowCount(CHAPTER_VISIBLE_ROW_CAP + 7)).toBe(7);
    // A negative length is not reachable, and the floor says what happens anyway
    // rather than leaving a caller to subtract past zero.
    expect(chapterClippedHeadRowCount(0)).toBe(0);
  });

  it("counts exactly what the list form would have listed, at every boundary", () => {
    // The two forms are one rule with two shapes, and this is what keeps them from
    // drifting: the arithmetic answer and the sliced answer agree on both sides of
    // the cap and on the cap itself.
    for (const length of [
      0,
      1,
      CHAPTER_VISIBLE_ROW_CAP - 1,
      CHAPTER_VISIBLE_ROW_CAP,
      CHAPTER_VISIBLE_ROW_CAP + 1,
      CHAPTER_VISIBLE_ROW_CAP * 2,
    ]) {
      const rowIds = Array.from({ length }, (_unused, index) => String(index));
      expect(chapterClippedHeadRowIds(rowIds)).toHaveLength(chapterClippedHeadRowCount(length));
    }
  });
});

describe("the body's row window — bounded on both sides", () => {
  it("holds nothing while the chapter is under the ceiling", () => {
    const window = new ChapterBodyRowWindow();
    for (let sequence = 1; sequence <= CHAPTER_VISIBLE_ROW_CAP; sequence += 1) {
      window.admit(chapterRow(sequence));
    }
    expect(window.headRows).toEqual([]);
  });

  it("holds the rows the mounted window displaced, oldest first", () => {
    const window = new ChapterBodyRowWindow();
    for (let sequence = 1; sequence <= CHAPTER_VISIBLE_ROW_CAP + 2; sequence += 1) {
      window.admit(chapterRow(sequence));
    }
    expect(window.headRows.map((row) => row.id)).toEqual(["r1", "r2"]);
  });

  it("never grows past the ceiling, however long the run is", () => {
    const window = new ChapterBodyRowWindow();
    const admitted = CHAPTER_VISIBLE_ROW_CAP * 3;
    for (let sequence = 1; sequence <= admitted; sequence += 1) {
      window.admit(chapterRow(sequence));
    }
    expect(window.headRows).toHaveLength(CHAPTER_VISIBLE_ROW_CAP);
    // The NEWEST of the head, which is what a body scrolls up into first.
    expect(window.headRows.at(-1)?.id).toBe(`r${String(admitted - CHAPTER_VISIBLE_ROW_CAP)}`);
  });
});
